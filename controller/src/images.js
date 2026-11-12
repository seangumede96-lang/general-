// The Characters page's engine. Unlike a video job, images are made in a session: the GPU
// is rented once, stays up while pictures are generated one request after another, and is
// deleted when idle or when its time is up.
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createComfyClient, ComfyError } from './comfy.js';
import { openB2 } from './b2.js';
import { imagePodSpec, buildImageGraph, SIZES, REFERENCE_ROLES } from './image-recipe.js';
import { COMFY_PORT, LOG_PORT } from './video-recipe.js';
import { MIN_VRAM } from './gpu.js';

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
- Always state the clothing explicitly, item by item. Follow the user's wishes about clothing and nudity exactly; if they say nothing about clothing, give a complete outfit.
- Unless the user names a setting, the background is a plain pure white void.
- Characters are fictional adults. Keep every detail the user gave; invent sensible specifics for what they left out. Do not add text, logos or watermarks.
- If reference pictures are mentioned, do not describe the face or body they will supply; describe everything else.`;

export function createImageStudio({ db, gpu, uploadsDir, clock = Date.now, pollMs = 3000, llm = null }) {
	const progress = new Map(); // podId -> latest setup step
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
			if (step) progress.set(p.id, step.replace(/^STEP /, ''));
			if (lines.some((l) => l.startsWith('SETUP FAILED'))) {
				const tail = lines.filter((l) => !l.startsWith('SETUP FAILED')).slice(-3).join(' | ').slice(-300);
				await gpu.stop(p.id, `image engine setup failed: ${tail || 'no details'}`);
			}
		} catch { /* the pod is not answering yet */ }
	}
	gpu.registerProbe('image', probe);

	const view = (g) => ({ id: g.id, status: g.status, detail: g.detail, prompt: g.prompt, params: JSON.parse(g.params), images: JSON.parse(g.images), created_at: g.created_at });

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

	async function status() {
		await listLoras();
		let p = pod();
		if (p && !p.ready_at) { await probe(p); p = pod(); }
		const last = db.listPods().find((x) => x.kind === 'image');
		return {
			session: {
				state: !p ? 'off' : p.ready_at ? 'ready' : 'starting',
				detail: p ? progress.get(p.id) || '' : '',
				podId: p?.id || null,
				secondsLeft: p ? Math.max(0, Math.round((p.deadline_at - clock()) / 1000)) : 0,
				// Why the last session ended, when that is worth telling the user.
				lastEnd: !p && last?.end_reason?.startsWith('image engine setup failed') ? last.end_reason : ''
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
			if (declined) return { prompt: text, enhanced: false, why: 'The chat model declined to write this prompt, so your own words were used. An uncensored private brain would write it.' };
			if (out.length < text.length) return { prompt: text, enhanced: false, why: '' };
			return { prompt: out.slice(0, 4000), enhanced: true, why: '' };
		} catch (err) { return { prompt: text, enhanced: false, why: `The prompt could not be written automatically (${err.message.slice(0, 120)}), so your own words were used.` }; }
	}

	const quote = (minutes) => gpu.quote({ minutes, minVram: MIN_VRAM.image, fastNetwork: true });

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
		const started = await gpu.start({ minutes, minVram: MIN_VRAM.image, fastNetwork: true, purpose: 'Character images', spec: imagePodSpec(loras) });
		db.setSettings({ imageLoras: JSON.stringify(loras.map(({ name, size }) => ({ name, size }))) });
		return started.id;
	}

	function validate(req) {
		const prompt = String(req.prompt || '').trim();
		if (!prompt) throw new ImageError('Describe the picture first.');
		const [width, height] = SIZES[req.size] || SIZES.portrait;
		const count = Math.min(4, Math.max(1, Number.parseInt(req.count, 10) || 2));
		// Up to three LoRAs, each with its own strength, applied one after another.
		const known = new Set(savedLoras().map((l) => l.name));
		const loras = (Array.isArray(req.loras) ? req.loras : []).slice(0, 3).map((l) => ({ name: String(l?.name || ''), strength: Math.min(2, Math.max(0, Number(l?.strength) || 0.9)) }));
		if (loras.some((l) => !known.has(l.name))) throw new ImageError('One of those LoRAs was not loaded in this session.');
		// Reference pictures by role. Order matters: it is how the description refers to them.
		const refs = [];
		for (const role of Object.keys(REFERENCE_ROLES)) {
			const uploadId = req.refs?.[role];
			if (!uploadId) continue;
			const upload = db.getUpload(String(uploadId));
			if (!upload || !upload.type.startsWith('image/')) throw new ImageError(`The ${role} picture is missing.`);
			refs.push({ role, upload });
		}
		return { prompt: prompt.slice(0, 4000), width, height, count, loras, refs, size: SIZES[req.size] ? req.size : 'portrait' };
	}

	async function generate(req) {
		const v = validate(req);
		const p = pod();
		if (!p?.ready_at) throw new ImageError(p ? 'The image engine is still starting.' : 'Start a session first.');
		if (db.listGenerations().some((g) => g.status === 'running')) throw new ImageError('A picture is already being made.');
		const id = randomUUID();
		const params = { size: v.size, width: v.width, height: v.height, count: v.count, loras: v.loras, refs: Object.fromEntries(v.refs.map((r) => [r.role, r.upload.id])), asked: v.prompt, note: '' };
		v.enhance = req.enhance === true;
		v.prefix = String(req.prefix || '').trim().slice(0, 100);
		db.insertGeneration({ id, prompt: v.prompt, params, created_at: clock() });
		run(id, p, v).catch((err) => console.error('[images]', err));
		return view(db.getGeneration(id));
	}

	async function run(id, p, v) {
		const saved = [];
		try {
			const comfy = comfyFor(p);
			gpu.touch(p.id);
			if (v.enhance) {
				const e = await enhance(v.prompt, v.refs);
				v.prompt = e.prompt;
				const params = { ...JSON.parse(db.getGeneration(id).params), note: e.why };
				db.updateGeneration(id, { prompt: v.prompt, params: JSON.stringify(params) });
			}
			// LoRA trigger words go first, outside the written prompt, so they are never reworded.
			if (v.prefix && !v.prompt.includes(v.prefix)) v.prompt = `${v.prefix} ${v.prompt}`;
			const refs = [];
			for (const r of v.refs) refs.push({ role: r.role, file: await comfy.upload(r.upload.path, `${r.role}-${r.upload.id}-${r.upload.name}`, r.upload.type) });
			const graph = buildImageGraph({ ...v, refs, seed: Math.floor(Math.random() * 2 ** 31), prefix: `gen-${id}` });
			const promptId = await comfy.queue(graph, id);
			let files;
			for (;;) {
				await sleep(pollMs);
				if (db.getPod(p.id)?.ended_at) throw new ImageError('The session ended before the picture was finished.');
				gpu.touch(p.id);
				const r = await comfy.result(promptId);
				if (r.done) { files = r.files; break; }
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

	return { status, quote, start, generate, remove, recover, enhance, stop: async () => { const p = pod(); if (p) await gpu.stop(p.id, 'stopped by you'); } };
}
