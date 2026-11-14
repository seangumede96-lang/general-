// The Characters page's engine. Unlike a video job, images are made in a session: the GPU
// is rented once, stays up while pictures are generated one request after another, and is
// deleted when idle or when its time is up.
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createComfyClient, ComfyError } from './comfy.js';
import { openB2 } from './b2.js';
import { imagePodSpec, buildImageGraph, SIZES, sizeFor, MAX_QUALITY_COUNT, REFERENCE_ROLES, MAX_REFERENCES } from './image-recipe.js';
import { COMFY_PORT, LOG_PORT } from './video-recipe.js';
import { MIN_VRAM } from './gpu.js';
import { createTracker, computeProgress, parseStep, imagePlan } from './progress.js';

/** Longest a Standard picture request may take; Max quality gets twice this. */
const MAX_GENERATE_MINUTES = 10;

export class ImageError extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How to turn a casual request into a prompt Krea 2 follows well. These are the prompting
 * rules found by trial on 11 November 2026 (see the pipeline notes).
 */
const PROMPT_WRITER = `You write prompts for the Krea 2 image model. The user gives a short or vague idea; you reply with ONE detailed prompt and nothing else: no preamble, no quotes, no lists, no notes.
Rules:
- One paragraph of long, natural sentences, 80 to 160 words.
- Start with the framing (for example "Full-body picture of", "Close-up portrait of") and the body type and build, then face, hair, skin, then clothing, pose, expression, lighting.
- Follow the user's wishes about clothing and nudity exactly. If they ask for nudity, say plainly that the person is fully nude ("completely nude, wearing nothing") and do not mention or invent any clothing, underwear, cover or censoring. Otherwise state the clothing explicitly, item by item; if they say nothing about clothing, give a complete outfit.
- Unless the user names a setting, the background is a plain pure white void.
- Characters are fictional adults. Keep every detail the user gave; invent sensible specifics for what they left out. Do not add text, logos or watermarks.
- If reference pictures are mentioned, do not describe the face or body they will supply; describe everything else.`;

export function createImageStudio({ db, gpu, uploadsDir, clock = Date.now, pollMs = 3000, llm = null, stopRetryMs = 15000 }) {
	const progress = new Map(); // podId -> latest setup step
	const tracker = createTracker(clock);
	const pod = () => db.listPods().find((p) => !p.ended_at && p.kind === 'image') || null;
	const comfyFor = (p) => createComfyClient(gpu.proxyUrl(p.id, COMFY_PORT));
	const b2Config = () => { const s = db.getSettings(); return { keyId: s.b2KeyId, appKey: s.b2AppKey, bucket: s.b2Bucket, apiBase: s.b2ApiBase || undefined }; };
	const b2Ready = () => { const c = b2Config(); return Boolean(c.keyId && c.appKey && c.bucket); };
	const savedLoras = () => { try { return JSON.parse(db.getSettings().imageLoras || '[]'); } catch { return []; } };

	/** Called by the GPU watchdog while the session pod is starting: is the engine up yet? */
	async function probe(p) {
		if (await comfyFor(p).ready()) { db.setPodReady(p.id, clock()); db.touchPod(p.id, clock()); progress.delete(p.id); return; }
		try {
			const res = await fetch(`${gpu.proxyUrl(p.id, LOG_PORT)}/setup.log`, { signal: AbortSignal.timeout(8000) });
			if (!res.ok) return;
			const lines = (await res.text()).trim().split('\n');
			const step = lines.filter((l) => l.startsWith('STEP ')).at(-1);
			if (step) {
				progress.set(p.id, step.replace(/^STEP /, ''));
				const parsed = parseStep(step.replace(/^STEP /, ''));
				if (parsed) tracker.report(p.id, parsed.index, step);
				if (/Downloading/.test(step)) {
					const f = await fetch(`${gpu.proxyUrl(p.id, LOG_PORT)}/files.txt`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
					if (f?.ok) tracker.files(p.id, await f.text());
				}
			}
			// Kept on the phone: once the pod is deleted its log is gone, and it is the only record of why setup stalled.
			db.setSettings({ imageSetupLog: JSON.stringify({ podId: p.id, at: clock(), lines: lines.filter((l) => !/\[notice\]|Running pip as the 'root' user/.test(l)).slice(-12) }) });
			if (lines.some((l) => l.startsWith('SETUP FAILED'))) {
				const tail = lines.filter((l) => !l.startsWith('SETUP FAILED')).slice(-3).join(' | ').slice(-300);
				await gpu.stop(p.id, `image engine setup failed: ${tail || 'no details'}`);
			}
		} catch { /* the pod is not answering yet */ }
	}
	gpu.registerProbe('image', probe);

	/** Live progress of running pictures, from the engine's messages: { stage, step, steps, at }. */
	const live = new Map();
	const view = (g) => ({ id: g.id, status: g.status, detail: g.detail, prompt: g.prompt, params: JSON.parse(g.params), images: JSON.parse(g.images), created_at: g.created_at, ended_at: g.ended_at ?? null, progress: g.status === 'running' ? live.get(g.id) || { stage: 'Starting', at: g.created_at } : null });

	let lorasListedAt = 0;
	/** Show what is in the Backblaze loras/ folder even before a session, refreshed at most every 5 minutes. */
	async function listLoras() {
		if (!b2Ready() || pod() || clock() - lorasListedAt < 5 * 60000) return;
		lorasListedAt = clock();
		try {
			const files = (await (await openB2(b2Config())).list('loras/')).filter((f) => f.name.endsWith('.safetensors'));
			db.setSettings({ imageLoras: JSON.stringify(files.map(({ name, size }) => ({ name, size }))) });
		} catch { /* shown when a session is started */ }
	}

	function savedLog(podId) {
		try { const l = JSON.parse(db.getSettings().imageSetupLog || '{}'); return l.podId === podId ? l.lines : []; } catch { return []; }
	}
	/** Why the last session ended, when it never got as far as making pictures. */
	function endExplanation(last) {
		if (last.ready_at) return '';
		if (last.end_reason?.startsWith('image engine setup failed')) return last.end_reason;
		const lines = savedLog(last.id);
		const step = lines.filter((l) => l.startsWith('STEP ')).at(-1)?.replace(/^STEP /, '');
		return `the image engine never finished setting up (${last.end_reason || 'stopped'})${step ? `; it was at step ${step}` : lines.length ? '' : '; its progress log could not be reached, so the machine may not have started at all'}.`;
	}

	/** Download size of a session: the Krea 2 files (measured 11 Nov 2026) plus the LoRAs it loads. */
	const MODEL_GB = 13.14 + 13.2 + 8.88 + 0.25 + 0.2 + 0.86;
	const sessionGb = () => Math.round(MODEL_GB + savedLoras().reduce((n, l) => n + (l.size || 0), 0) / 1e9);

	async function status() {
		await listLoras();
		let p = pod();
		if (p && !p.ready_at) { await probe(p); p = pod(); }
		const last = db.listPods().find((x) => x.kind === 'image');
		return {
			session: {
				state: !p ? 'off' : gpu.stopping?.(p.id) ? 'stopping' : p.ready_at ? 'ready' : 'starting',
				detail: p ? progress.get(p.id) || '' : '',
				progress: p && !p.ready_at ? computeProgress('image', p.created_at, tracker.get(p.id), clock(), imagePlan(sessionGb())) : null,
				podId: p?.id || null,
				secondsLeft: p ? Math.max(0, Math.round((p.deadline_at - clock()) / 1000)) : 0,
				// Why the last session ended, when that is worth telling the user.
				lastEnd: !p && last ? endExplanation(last) : '',
				setupLog: !p && last && !last.ready_at ? savedLog(last.id) : []
			},
			loras: savedLoras(), b2: b2Ready(), sizes: Object.keys(SIZES),
			generations: db.listGenerations().map(view)
		};
	}

	/**
	 * Expand a casual request into a detailed prompt using the chat brain. If no brain
	 * answers, or it declines, the user's own words are used unchanged.
	 */
	async function enhance(text, refs = []) {
		if (!llm) return { prompt: text, enhanced: false, why: 'No chat model is set up.' };
		const refNote = refs.length ? `\n(Reference pictures will supply: ${refs.map((r) => r.role === 'look' ? 'outfit and makeup' : r.role).join(', ')}.)` : '';
		try {
			const out = (await llm([{ role: 'system', content: PROMPT_WRITER }, { role: 'user', content: text + refNote }])).replace(/^["'\s]+|["'\s]+$/g, '');
			const declined = /^(i('m| am)? (sorry|unable|not able)|i can('|no)t|sorry|as an ai|i won't)/i.test(out);
			if (declined) return { prompt: text, enhanced: false, writer: 'declined', why: 'The chat model declined to write this prompt, so your own words were used. An uncensored private brain would write it.' };
			// A rewrite shorter than the request usually dropped something (often the explicit part).
			if (out.length < text.length) return { prompt: text, enhanced: false, writer: 'kept yours (its version was shorter)', why: 'The prompt writer\'s version was shorter than yours (it may have left things out), so your own words were used.', rejected: out.slice(0, 1000) };
			return { prompt: out.slice(0, 4000), enhanced: true, writer: 'rewrote', why: '' };
		} catch (err) { return { prompt: text, enhanced: false, writer: 'failed', why: `The prompt could not be written automatically (${err.message.slice(0, 120)}), so your own words were used.` }; }
	}

	/** Setup is reserved on top of the minutes asked for, so a 30-minute session gives 30 minutes of pictures. */
	const SETUP_MINUTES = 15;
	const quote = async (minutes) => ({ ...(await gpu.quote({ minutes: Number(minutes) + SETUP_MINUTES, minVram: MIN_VRAM.image, fastNetwork: true })), useMinutes: Number(minutes), setupMinutes: SETUP_MINUTES });

	async function start({ minutes, confirmEstimate }) {
		const q = await quote(minutes);
		if (!q.allowed) throw new ImageError(q.reason);
		if (confirmEstimate !== q.estimate) throw new ImageError(`The price changed to $${q.estimate.toFixed(2)}. Review the new price and confirm again.`);
		// LoRAs live in Backblaze. The pod gets one-hour links to them; the keys stay here.
		let loras = [];
		if (b2Ready()) {
			const b2 = await openB2(b2Config());
			const files = (await b2.list('loras/')).filter((f) => f.name.endsWith('.safetensors'));
			loras = await Promise.all(files.map(async (f) => ({ name: f.name, size: f.size, url: await b2.link(f.name) })));
		}
		const started = await gpu.start({ minutes: Number(minutes) + SETUP_MINUTES, minVram: MIN_VRAM.image, fastNetwork: true, purpose: 'Character images', spec: imagePodSpec(loras, db.getSettings().imageEngineImage) });
		db.setSettings({ imageLoras: JSON.stringify(loras.map(({ name, size }) => ({ name, size }))) });
		return started.id;
	}

	function validate(req) {
		const prompt = String(req.prompt || '').trim();
		if (!prompt) throw new ImageError('Describe the picture first.');
		const quality = req.quality === 'max' ? 'max' : 'standard';
		const [width, height] = sizeFor(req.size, quality);
		const count = Math.min(quality === 'max' ? MAX_QUALITY_COUNT : 4, Math.max(1, Number.parseInt(req.count, 10) || 2));
		// Up to three LoRAs, each with its own strength, applied one after another.
		const known = new Set(savedLoras().map((l) => l.name));
		const loras = (Array.isArray(req.loras) ? req.loras : []).slice(0, 3).map((l) => ({ name: String(l?.name || ''), strength: Math.min(2, Math.max(0, Number(l?.strength) || 0.9)) }));
		if (loras.some((l) => !known.has(l.name))) throw new ImageError('One of those LoRAs was not loaded in this session.');
		// Reference pictures by role, several per role allowed. Order matters: it is how the description refers to them.
		const refs = [];
		for (const role of Object.keys(REFERENCE_ROLES)) {
			const given = req.refs?.[role];
			for (const uploadId of (Array.isArray(given) ? given : given ? [given] : [])) {
				const upload = db.getUpload(String(uploadId));
				if (!upload || !upload.type.startsWith('image/')) throw new ImageError(`One of the ${role === 'look' ? 'outfit' : role} pictures is missing.`);
				refs.push({ role, upload, count: Math.min(3, Math.max(1, Number.parseInt(req.refCounts?.[role], 10) || 1)) });
			}
		}
		if (refs.length > MAX_REFERENCES) throw new ImageError(`At most ${MAX_REFERENCES} reference pictures in total can be used at once.`);
		let shape = null;
		if (req.shape) {
			shape = db.getUpload(String(req.shape));
			if (!shape || !shape.type.startsWith('image/')) throw new ImageError('The body shape picture is missing. Open the body editor and tap "Use this body" again.');
		}
		const shapeDenoise = Math.min(0.95, Math.max(0.3, Number(req.shapeDenoise) || 0.72));
		let depth = null;
		if (req.depth) {
			depth = db.getUpload(String(req.depth));
			if (!depth || !depth.type.startsWith('image/')) throw new ImageError('The body depth map is missing. Open the body editor and tap "Use this body" again.');
		}
		const depthStrength = Math.min(1.2, Math.max(0.3, Number(req.depthStrength) || 0.9));
		return { depth, depthStrength, shape, shapeDenoise, prompt: prompt.slice(0, 4000), width, height, count, quality, loras, refs, size: SIZES[req.size] ? req.size : 'portrait' };
	}

	async function generate(req) {
		const v = validate(req);
		const p = pod();
		if (!p?.ready_at) throw new ImageError(p ? 'The image engine is still starting.' : 'Start a session first.');
		if (gpu.stopping?.(p.id)) throw new ImageError('The session is stopping.');
		if (db.listGenerations().some((g) => g.status === 'running')) throw new ImageError('A picture is already being made.');
		const id = randomUUID();
		const params = { size: v.size, quality: v.quality, width: v.width, height: v.height, count: v.count, loras: v.loras, refs: Object.fromEntries(Object.keys(REFERENCE_ROLES).map((role) => [role, v.refs.filter((r) => r.role === role).map((r) => r.upload.id)]).filter(([, ids]) => ids.length)), shape: v.shape?.id || '', shapeDenoise: v.shape ? v.shapeDenoise : null, depth: v.depth?.id || '', depthStrength: v.depth ? v.depthStrength : null, asked: v.prompt, note: '', stylePass: req.stylePass === true && v.loras.length > 0 ? Math.min(0.6, Math.max(0.3, Number(req.styleDenoise) || 0.45)) : null };
		params.styleDenoise = params.stylePass; // the second pass's denoise (null: no style pass)
		v.enhance = req.enhance === true;
		// Keep-it-nude style pass: only meaningful with a style LoRA.
		v.stylePass = req.stylePass === true && v.loras.length > 0 ? { denoise: Math.min(0.6, Math.max(0.3, Number(req.styleDenoise) || 0.45)) } : null;
		v.prefix = String(req.prefix || '').trim().slice(0, 100);
		db.insertGeneration({ id, prompt: v.prompt, params, created_at: clock() });
		run(id, p, v).catch((err) => console.error('[images]', err));
		return view(db.getGeneration(id));
	}

	async function run(id, p, v) {
		const saved = [];
		let stopWatch = () => {};
		try {
			const comfy = comfyFor(p);
			gpu.touch(p.id);
			if (v.enhance) {
				const e = await enhance(v.prompt, v.refs);
				v.prompt = e.prompt;
				const params = { ...JSON.parse(db.getGeneration(id).params), note: e.why, writer: e.writer, ...(e.rejected ? { writerVersion: e.rejected } : {}) };
				db.updateGeneration(id, { prompt: v.prompt, params: JSON.stringify(params) });
			}
			// LoRA trigger words go first, outside the written prompt, so they are never reworded.
			if (v.stylePass) v.stylePass.plainPrompt = v.prompt; // pass 1: no trigger words
			if (v.prefix && !v.prompt.includes(v.prefix)) v.prompt = `${v.prefix} ${v.prompt}`;
			const refs = [];
			for (const r of v.refs) refs.push({ role: r.role, count: r.count, file: await comfy.upload(r.upload.path, `${r.role}-${r.upload.id}-${r.upload.name}`, r.upload.type) });
			const shapeFile = v.shape ? await comfy.upload(v.shape.path, `shape-${v.shape.id}.png`, v.shape.type) : null;
			const depthFile = v.depth ? await comfy.upload(v.depth.path, `depth-${v.depth.id}.png`, v.depth.type) : null;
			const graph = buildImageGraph({ ...v, refs, shape: shapeFile, depth: depthFile, seed: Math.floor(Math.random() * 2 ** 31), prefix: `gen-${id}` });
			// What each part of the graph does, in words, for the live progress line.
			const STAGES = { UNETLoader: 'Loading the model', CLIPLoader: 'Loading the model', VAELoader: 'Loading the model', LoraLoaderModelOnly: 'Loading your LoRAs', CLIPTextEncode: 'Reading the description', TextEncodeKrea2OstrisEdit: 'Studying the reference pictures', LoadImage: 'Preparing the pictures', ImageScaleToTotalPixels: 'Preparing the pictures', Krea2ControlImageEncode: 'Reading the body shape', KSampler: 'Drawing', VAEDecode: 'Finishing the pictures', SaveImage: 'Saving' };
			live.set(id, { stage: 'Waiting for the engine', at: clock() });
			stopWatch = comfy.watch(id, (m) => {
				const d = m.data || {};
				if (m.type === 'executing' && d.node && graph[d.node]) live.set(id, { stage: STAGES[graph[d.node].class_type] || 'Working', at: clock() });
				else if (m.type === 'progress' && d.max > 0) live.set(id, { stage: 'Drawing', step: d.value, steps: d.max, at: clock() });
			});
			// Record exactly what the engine is given (trigger words, written prompt, reference hints).
			{
				const pos = graph['5']?.inputs || {};
				const first = graph['5p']?.inputs;
				const params = { ...JSON.parse(db.getGeneration(id).params), sent: String(pos.text ?? pos.prompt ?? v.prompt), ...(first ? { sentFirstPass: String(first.text ?? first.prompt) } : {}), enhance: v.enhance, prefix: v.prefix, ...(v.enhance ? {} : { writer: 'off' }) };
				db.updateGeneration(id, { params: JSON.stringify(params) });
			}
			const promptId = await comfy.queue(graph, id);
			let files;
			// A job the engine has lost, or one far past any normal time, must not keep the GPU
			// marked busy (and charging) until the session's time runs out.
			const started = clock();
			const limit = (v.quality === 'max' ? MAX_GENERATE_MINUTES * 2 : MAX_GENERATE_MINUTES) * 60000;
			let missing = 0;
			for (;;) {
				await sleep(pollMs);
				if (db.getPod(p.id)?.ended_at) throw new ImageError('The session ended before the picture was finished.');
				const r = await comfy.result(promptId);
				if (r.done) { files = r.files; break; }
				if (clock() - started > limit) throw new ImageError(`The picture took over ${Math.round(limit / 60000)} minutes, far longer than normal, so it was stopped. The session is still on: try again, perhaps with fewer or smaller pictures.`);
				// Not finished, not running and not waiting: the engine lost it (it restarted or ran out of memory).
				missing = (await comfy.inQueue(promptId)) ? 0 : missing + 1;
				if (missing >= 3) throw new ImageError('The image engine lost this picture (it may have run out of memory or restarted). Try again; Standard quality or fewer pictures use less memory.');
				gpu.touch(p.id);
			}
			if (!files.length) throw new ImageError('The image engine finished but produced no picture.');
			for (const [i, f] of files.entries()) {
				const uploadId = randomUUID();
				const dir = join(uploadsDir, uploadId);
				await mkdir(dir, { recursive: true, mode: 0o700 });
				const name = `character-${id.slice(0, 8)}-${i + 1}.png`;
				const got = await comfy.download(f, join(dir, name));
				db.insertUpload({ id: uploadId, name, type: 'image/png', size: got.size, path: join(dir, name), created_at: clock() });
				db.claimUpload(uploadId, `gen:${id}`);
				saved.push(uploadId);
			}
			db.updateGeneration(id, { status: 'done', images: JSON.stringify(saved), ended_at: clock() });
		} catch (err) {
			const known = err instanceof ImageError || err instanceof ComfyError;
			if (!known) console.error('[images]', err);
			db.updateGeneration(id, { status: 'failed', detail: known ? err.message : 'Something unexpected went wrong.', images: JSON.stringify(saved), ended_at: clock() });
		} finally {
			stopWatch();
			live.delete(id);
		}
	}

	async function remove(id) {
		const g = db.getGeneration(id);
		if (!g || g.status === 'running') return false;
		for (const uploadId of JSON.parse(g.images)) {
			const u = db.getUpload(uploadId);
			if (u) { await rm(dirname(u.path), { recursive: true, force: true }); db.deleteUpload(u.id); }
		}
		db.deleteGeneration(id);
		return true;
	}

	/** After a restart nothing is generating any more; close anything left "running". */
	function recover() {
		for (const g of db.listGenerations().filter((x) => x.status === 'running')) db.updateGeneration(g.id, { status: 'failed', detail: 'The app was restarted while this was being made.', ended_at: clock() });
	}

	return { status, quote, start, generate, remove, recover, enhance, stop: async () => { const p = pod(); return p ? gpu.stopSoon(p.id, 'stopped by you', stopRetryMs) : { stopped: true }; } };
}
