// Motion capture: body motion (joint data) from a clip, run blind. One job = put the clip in
// Backblaze, rent a 48 GB GPU, let SAM-Body4D track the people the owner marked and measure
// their bodies frame by frame, then bring back joint numbers and a numbers-only quality report.
// No picture or video of the result is made anywhere; the owner's clip is only ever shown to
// the owner, on the phone, to mark the people in it.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { openB2, B2Error } from './b2.js';
import { GpuError } from './gpu.js';
import { mocapPodSpec, minutesFor, GATED_FILES, LOG_PORT, MIN_VRAM_GB } from './mocap-recipe.js';

export class MocapError extends Error {}
const ACTIVE = new Set(['starting', 'preparing', 'loading', 'tracking', 'checking', 'saving']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Longest clip for one job, in seconds (time and memory grow with length). */
const MAX_SECONDS = 60;
/** Setup with no change in its log for this long fails the job (the GPU is deleted). */
const STALL_MS = 20 * 60000;
const SMALL_FILE_MAX = 1024 * 1024;

export function createMocapStudio({ db, gpu, uploadsDir, clock = Date.now, pollMs = 5000, stallMs = STALL_MS, hfBase = 'https://huggingface.co' }) {
	const running = new Map();
	const cancelled = new Set();
	const b2Config = () => { const s = db.getSettings(); return { keyId: s.b2KeyId, appKey: s.b2AppKey, bucket: s.b2Bucket, apiBase: s.b2ApiBase || undefined }; };
	const b2Ready = () => { const c = b2Config(); return Boolean(c.keyId && c.appKey && c.bucket); };
	const mine = () => db.listJobs().filter((j) => j.kind === 'mocap');

	const view = (j) => {
		const params = JSON.parse(j.params || '{}');
		const pod = j.pod_id && db.getPod(j.pod_id);
		return {
			id: j.id, status: j.status, detail: j.detail, params, active: ACTIVE.has(j.status),
			input: j.input_upload, result: j.result_upload || null, qc: params.qc || null,
			created_at: j.created_at, step_started_at: j.step_started_at, ended_at: j.ended_at,
			gpuSecondsLeft: ACTIVE.has(j.status) && pod && !pod.ended_at ? Math.max(0, Math.round((pod.deadline_at - clock()) / 1000)) : null
		};
	};
	const setStep = (id, status, detail = '') => db.updateJob(id, { status, detail, step_started_at: clock() });

	/** What the page needs to know before anything starts. */
	function limits() {
		const s = db.getSettings();
		return { maxSeconds: MAX_SECONDS, b2: b2Ready(), hfToken: Boolean(s.hfToken), minVramGb: MIN_VRAM_GB };
	}

	/**
	 * The owner's marks: [{ name, marks: [{ t, points: [[x, y, 1|0]], box }] }], coordinates
	 * 0-1 relative to the frame, t in seconds. An empty list means "find people automatically".
	 */
	function cleanPeople(people) {
		if (!Array.isArray(people)) return [];
		const out = [];
		for (const [i, p] of people.slice(0, 6).entries()) {
			const marks = (Array.isArray(p?.marks) ? p.marks : []).slice(0, 20).map((m) => ({
				t: Math.max(0, Math.min(MAX_SECONDS, Number(m?.t) || 0)),
				points: (Array.isArray(m?.points) ? m.points : []).slice(0, 20)
					.filter((pt) => Array.isArray(pt) && pt.length === 3 && pt.slice(0, 2).every((v) => Number.isFinite(Number(v)) && v >= 0 && v <= 1))
					.map(([x, y, l]) => [Number(x), Number(y), Number(l) ? 1 : 0]),
				box: Array.isArray(m?.box) && m.box.length === 4 && m.box.every((v) => Number.isFinite(Number(v)) && v >= 0 && v <= 1) ? m.box.map(Number) : null
			})).filter((m) => m.points.some((pt) => pt[2] === 1) || m.box);
			if (marks.length) out.push({ id: i + 1, name: String(p?.name || `Person ${String.fromCharCode(65 + i)}`).slice(0, 40), marks });
		}
		return out;
	}

	function validate(request) {
		const video = db.getUpload(String(request.input || ''));
		if (!video || !video.type.startsWith('video/')) throw new MocapError('Choose a video first.');
		const seconds = Number(request.seconds);
		if (!(seconds > 0)) throw new MocapError('Could not read the length of that video.');
		if (seconds > MAX_SECONDS) throw new MocapError(`Clips can be up to ${MAX_SECONDS} seconds for now; trim it first.`);
		const people = cleanPeople(request.people);
		if (!people.length && request.automatic !== true) throw new MocapError('Mark each person first (tap them on the clip), or choose to find people automatically.');
		if (!b2Ready()) throw new MocapError('Backblaze is needed to pass the clip to the GPU. Add it on the System page.');
		if (!db.getSettings().hfToken) throw new MocapError('A Hugging Face token with access to SAM 3 and SAM 3D Body is needed. Add it in Settings.');
		return { video, seconds, people };
	}

	async function quote(request) {
		const { seconds } = validate(request);
		if (mine().some((j) => ACTIVE.has(j.status))) throw new MocapError('A motion capture is already running.');
		const needed = minutesFor(seconds);
		const untilDone = request.runMinutes === 'until-done';
		const minutes = untilDone ? Math.max(needed * 3, 120) : needed;
		const q = await gpu.quote({ minutes, minVram: MIN_VRAM_GB, fastNetwork: true, wholeGpu: true, chosenLength: untilDone });
		return { ...q, seconds, minutes, needed, run: untilDone ? 'until-done' : 'auto' };
	}

	async function create(request) {
		if (request.rightsConfirmed !== true) throw new MocapError('Confirm that you have the right to use this footage first.');
		const { video, seconds, people } = validate(request);
		const q = await quote(request);
		if (!q.allowed) throw new MocapError(q.reason);
		if (request.confirmEstimate !== q.estimate) throw new MocapError(`The price changed to $${q.estimate.toFixed(2)}. Review the new price and confirm again.`);
		const id = randomUUID();
		db.claimUpload(video.id, `job:${id}`);
		const now = clock();
		db.insertJob({
			id, kind: 'mocap', status: 'starting', input_upload: video.id, ref_upload: '', prompt: JSON.stringify(people),
			params: { seconds, minutes: q.minutes, run: q.run, estimate: q.estimate, people: people.map((p) => p.name), automatic: !people.length },
			rights_confirmed_at: now, created_at: now
		});
		const task = run(id, q.minutes, q.run !== 'auto').catch((err) => console.error('[mocap]', err)).finally(() => running.delete(id));
		running.set(id, task);
		return view(db.getJob(id));
	}

	/**
	 * One-hour download links for the gated model files, made on the phone with the owner's
	 * token so the token never leaves it. Small files that have no separate download host are
	 * fetched here and handed over as content.
	 */
	async function gatedFiles() {
		const token = db.getSettings().hfToken;
		const links = [];
		const small = {};
		for (const g of GATED_FILES) {
			const url = `${hfBase}/${g.repo}/resolve/main/${g.file}`;
			let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(30000) }).catch(() => null);
			if (!res) throw new MocapError('Could not reach Hugging Face from the phone. Check the connection and try again.');
			if (res.status === 401 || res.status === 403) throw new MocapError(`Hugging Face refused ${g.repo}: the saved token has no access to it. Request access on its Hugging Face page, or save a token that has it.`);
			const location = res.headers.get('location');
			if (res.status >= 300 && res.status < 400 && location) {
				const target = new URL(location, url);
				if (target.host !== new URL(url).host) { links.push(`${g.dest} ${target.href}`); continue; }
				// Same host (a small file served by Hugging Face itself): fetch it here.
				res = await fetch(target, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) }).catch(() => null);
			}
			if (!res?.ok) throw new MocapError(`Could not get ${g.file} from Hugging Face (${res ? `HTTP ${res.status}` : 'no answer'}).`);
			const body = Buffer.from(await res.arrayBuffer());
			if (body.length > SMALL_FILE_MAX) throw new MocapError(`${g.file} came without a download link and is too big to pass along.`);
			small[g.dest] = body.toString('base64');
		}
		return { MOCAP_GATED: links.join('\n'), MOCAP_SMALL: JSON.stringify(small) };
	}

	async function podText(podId, path) {
		const res = await fetch(`${gpu.proxyUrl(podId, LOG_PORT)}/${path}`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
		return res?.ok ? res.text() : null;
	}

	async function podFile(podId, path, destination) {
		for (let attempt = 0; attempt < 5; attempt++) {
			const res = await fetch(`${gpu.proxyUrl(podId, LOG_PORT)}/${path}`, { signal: AbortSignal.timeout(10 * 60000) }).catch(() => null);
			if (res?.ok) { const buf = Buffer.from(await res.arrayBuffer()); await writeFile(destination, buf, { mode: 0o600 }); return buf.length; }
			await sleep(Math.min(20000, 2000 * 2 ** attempt));
		}
		throw new MocapError(`Could not fetch ${path} from the GPU.`);
	}

	async function run(id, minutes, chosenLength) {
		let podId = '';
		const check = () => {
			if (cancelled.has(id)) throw new MocapError('cancelled');
			const pod = podId && db.getPod(podId);
			if (pod?.ended_at) throw new MocapError(`The GPU was shut down before the motion capture finished (${pod.end_reason}).`);
			if (podId) gpu.touch(podId);
		};
		try {
			const job = db.getJob(id);
			const params = JSON.parse(job.params);
			const people = JSON.parse(job.prompt || '[]');
			setStep(id, 'preparing', 'Putting your clip in Backblaze for the GPU');
			const b2 = await openB2(b2Config());
			const clip = db.getUpload(job.input_upload);
			const clipName = `pipeline/mocap/${id}/input${extname(clip.name).toLowerCase() || '.mp4'}`;
			await b2.upload(clipName, clip.path, clip.type);
			check();
			const env = {
				...(await gatedFiles()),
				MOCAP_VIDEO_URL: await b2.link(clipName, 4 * 3600),
				MOCAP_PROMPTS: people.length ? Buffer.from(JSON.stringify({ people })).toString('base64') : ''
			};
			check();
			setStep(id, 'starting', 'Starting the GPU');
			const pod = await gpu.start({ minutes, minVram: MIN_VRAM_GB, fastNetwork: true, wholeGpu: true, chosenLength, purpose: 'Motion capture', spec: mocapPodSpec(env) });
			podId = pod.id;
			db.updateJob(id, { pod_id: podId });

			setStep(id, 'loading', 'Setting up');
			let lastLog = '';
			let lastChange = clock();
			for (;;) {
				await sleep(pollMs);
				check();
				const log = await podText(podId, 'setup.log');
				if (log === null) { if (clock() - lastChange > stallMs) throw new MocapError(`The GPU never answered in ${Math.round(stallMs / 60000)} minutes, so it was shut down. Try again; another GPU is usually picked.`); continue; }
				if (log !== lastLog) { lastLog = log; lastChange = clock(); }
				const lines = log.trim().split('\n');
				if (lines.some((l) => l.startsWith('SETUP FAILED'))) {
					const tail = lines.filter((l) => !l.startsWith('SETUP FAILED')).slice(-6).join(' | ').slice(-600);
					throw new MocapError(`Motion capture failed on the GPU: ${tail || 'no details'}`);
				}
				const done = lines.find((l) => l.startsWith('MOCAP DONE'));
				if (done) break;
				const step = lines.filter((l) => l.startsWith('STEP ')).at(-1)?.replace(/^STEP /, '') || '';
				const progress = lines.filter((l) => l.startsWith('PROGRESS ')).at(-1)?.replace(/^PROGRESS /, '');
				const status = /^4\//.test(step) ? 'tracking' : /^5\//.test(step) ? 'checking' : 'loading';
				const detail = status === 'tracking' && progress ? `${step} · ${progress}` : step;
				const now = db.getJob(id);
				if (now.status !== status) setStep(id, status, detail);
				else if (detail && detail !== now.detail) db.updateJob(id, { detail });
				if (clock() - lastChange > stallMs) throw new MocapError(`Nothing changed on the GPU for ${Math.round(stallMs / 60000)} minutes, so it was shut down to stop charges.`);
			}

			setStep(id, 'saving', 'Bringing the joint data back');
			check();
			const qcText = await podText(podId, 'out/qc.json');
			let qc = null;
			try { qc = qcText ? JSON.parse(qcText) : null; } catch { qc = null; }
			const uploadId = randomUUID();
			const dir = join(uploadsDir, uploadId);
			await mkdir(dir, { recursive: true, mode: 0o700 });
			const name = `mocap-${new Date(clock()).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.zip`;
			const size = await podFile(podId, 'out/joints.zip', join(dir, name));
			db.insertUpload({ id: uploadId, name, type: 'application/zip', size, path: join(dir, name), created_at: clock() });
			db.claimUpload(uploadId, `job:${id}`);
			// A copy in Backblaze for the next steps (retargeting), with the report beside it.
			let b2Path = '';
			try {
				await b2.upload(`pipeline/mocap/${id}/joints.zip`, join(dir, name), 'application/zip');
				if (qcText) { const qcPath = join(dir, 'qc.json'); await writeFile(qcPath, qcText, { mode: 0o600 }); await b2.upload(`pipeline/mocap/${id}/qc.json`, qcPath, 'application/json'); }
				b2Path = `pipeline/mocap/${id}/`;
			} catch (err) { console.error('[mocap] Backblaze copy failed', err.message); }
			db.updateJob(id, { status: 'done', detail: '', result_upload: uploadId, params: JSON.stringify({ ...params, qc, b2Path }), ended_at: clock() });
		} catch (err) {
			const wasCancelled = cancelled.has(id);
			const known = err instanceof MocapError || err instanceof GpuError || err instanceof B2Error;
			if (!known) console.error('[mocap]', err);
			db.updateJob(id, {
				status: wasCancelled ? 'cancelled' : 'failed',
				detail: wasCancelled ? 'You cancelled this.' : known ? err.message : 'Something unexpected went wrong. The GPU has been shut down.',
				ended_at: clock()
			});
		} finally {
			cancelled.delete(id);
			if (podId && !db.getPod(podId)?.ended_at) {
				const reason = db.getJob(id).status === 'done' ? 'motion capture finished' : `motion capture ${db.getJob(id).status}`;
				await gpu.stop(podId, reason).catch((err) => console.error('[mocap] could not delete pod', podId, err.message));
			}
		}
	}

	/** Jobs left running by a restart cannot be resumed: close them and free the pod. */
	async function recover() {
		for (const j of mine().filter((x) => ACTIVE.has(x.status))) {
			db.updateJob(j.id, { status: 'failed', detail: 'The app was restarted during this motion capture. The GPU was shut down.', ended_at: clock() });
			if (j.pod_id && !db.getPod(j.pod_id)?.ended_at) await gpu.stop(j.pod_id, 'job interrupted by restart').catch(() => {});
		}
	}

	return {
		quote, create, recover, limits,
		list: () => mine().map(view),
		cancel(id) {
			const j = db.getJob(id);
			if (!j || j.kind !== 'mocap') return null;
			if (ACTIVE.has(j.status)) cancelled.add(id);
			return view(j);
		},
		async shutdown() {
			for (const id of running.keys()) cancelled.add(id);
			await Promise.allSettled([...running.values()]);
		}
	};
}
