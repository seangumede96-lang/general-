// The Video Studio's job runner. One job = rent a GPU, set up the video engine, send it the
// clip and the character picture, wait for the result, save it on the phone, delete the pod.
// The pod is deleted however the job ends.
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createComfyClient, ComfyError } from './comfy.js';
import { comfyPodSpec, buildWorkflow, minutesFor, outputSize, WORKFLOW_URL, COMFY_PORT, LOG_PORT } from './video-recipe.js';
import { GpuError, MIN_VRAM } from './gpu.js';
import { createTracker, computeProgress, parseStep } from './progress.js';
import { MINUTES_PER_CLIP_SECOND } from './video-recipe.js';

/** Run lengths the owner can pick for a video GPU, in minutes (besides automatic and until done). */
export const RUN_CHOICES = [30, 45, 60, 90, 120, 180];
/** "Until done" backstop: deletes the GPU if this phone goes offline mid-job. */
export const UNTIL_DONE_MAX_MINUTES = 720;

export class VideoError extends Error {}
const ACTIVE = new Set(['starting', 'loading', 'uploading', 'generating', 'saving']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createVideoStudio({ db, gpu, uploadsDir, clock = Date.now, pollMs = 5000 }) {
	const cancelled = new Set();
	const tracker = createTracker(clock);
	const running = new Map(); // job id -> promise of its run
	let workflowTemplate = null;

	const limits = () => ({ maxClipSeconds: Math.max(1, Number.parseInt(db.getSettings().maxClipSeconds, 10) || 10) });

	/** Setup progress while the machine starts; a plain estimate while the clip is generated. */
	function progressOf(j) {
		const params = JSON.parse(j.params || '{}');
		if (j.status === 'starting' || j.status === 'loading') {
			const pod = j.pod_id && db.getPod(j.pod_id);
			return computeProgress('video', pod?.created_at || j.created_at, tracker.get(j.id), clock());
		}
		if (j.status === 'generating') {
			const est = Math.max(60, (params.seconds || 5) * MINUTES_PER_CLIP_SECOND * 60);
			const inStep = (clock() - j.step_started_at) / 1000;
			return { steps: ['Replacing the character'], index: 0, detail: '', fraction: Math.min(0.95, inStep / est), elapsedSeconds: Math.round(inStep), etaSeconds: Math.round(Math.max(est - inStep, 30)), quietSeconds: 0, quietLimitSeconds: 1e9 };
		}
		return null;
	}

	const view = (j) => ({
		progress: ACTIVE.has(j.status) ? progressOf(j) : null,
		id: j.id, kind: j.kind, status: j.status, detail: j.detail, prompt: j.prompt, params: JSON.parse(j.params || '{}'),
		input: j.input_upload, reference: j.ref_upload, result: j.result_upload || null,
		created_at: j.created_at, step_started_at: j.step_started_at, ended_at: j.ended_at, active: ACTIVE.has(j.status),
		// How long the GPU may still run before its time limit stops it.
		gpuSecondsLeft: (() => { const p = ACTIVE.has(j.status) && j.pod_id && db.getPod(j.pod_id); return p && !p.ended_at ? Math.max(0, Math.round((p.deadline_at - clock()) / 1000)) : null; })()
	});

	const setStep = (id, status, detail = '') => db.updateJob(id, { status, detail, step_started_at: clock() });

	/** Jobs left "running" by a crash or restart cannot be resumed yet: close them and free the pod. */
	async function recover() {
		for (const j of db.listJobs().filter((x) => ACTIVE.has(x.status))) {
			db.updateJob(j.id, { status: 'failed', detail: 'The app was restarted while this was running.', ended_at: clock() });
			if (j.pod_id) await gpu.stop(j.pod_id, 'job interrupted by restart').catch(() => {});
		}
	}

	function validate({ kind, input, reference, seconds }) {
		if (kind !== 'replace') throw new VideoError('Only character replacement is available so far.');
		const video = db.getUpload(String(input || ''));
		if (!video || !video.type.startsWith('video/')) throw new VideoError('Choose a video first.');
		const image = db.getUpload(String(reference || ''));
		if (!image || !image.type.startsWith('image/')) throw new VideoError('Choose a picture of the character first.');
		if (!(Number(seconds) > 0)) throw new VideoError('Could not read the length of that video.');
		return { video, image, seconds: Math.min(Number(seconds), limits().maxClipSeconds) };
	}

	/**
	 * How long the GPU may run: 'auto' (estimated for the clip), a number of minutes the owner
	 * picked, or 'until-done' (no fixed limit: the GPU stops when the video is done, fails or is
	 * cancelled; a backstop of UNTIL_DONE_MAX_MINUTES, or what the balance covers, still deletes
	 * it if this phone goes offline mid-job).
	 */
	function runChoice(request) {
		const r = request.runMinutes;
		if (r === 'until-done') return 'until-done';
		const n = Number(r);
		return RUN_CHOICES.includes(n) ? n : 'auto';
	}

	async function quote(request) {
		const { seconds } = validate(request);
		if (db.listJobs().some((j) => ACTIVE.has(j.status))) throw new VideoError('A video is already being processed.');
		const needed = minutesFor(seconds);
		const run = runChoice(request);
		const base = { minVram: MIN_VRAM.comfy, fastNetwork: true, chosenLength: run !== 'auto' };
		let minutes = run === 'auto' ? needed : run === 'until-done' ? UNTIL_DONE_MAX_MINUTES : run;
		let q = await gpu.quote({ ...base, minutes });
		if (run === 'until-done' && !q.allowed && q.options?.length && q.estimate > 0) {
			// Not enough balance for the full backstop: run for as long as the balance covers.
			const perMinute = q.estimate / minutes;
			const affordable = Math.floor((q.remaining - 0.01) / perMinute);
			if (affordable >= needed) { minutes = affordable; q = await gpu.quote({ ...base, minutes }); }
			else q = { ...q, reason: `The balance covers about ${Math.max(0, affordable)} minutes of GPU time, but this clip needs about ${needed}.` };
		}
		const warning = typeof run === 'number' && run < needed ? `This clip is estimated to need about ${needed} minutes; with ${run} the GPU may shut down before the video is done.` : '';
		return { ...q, seconds, minutes, needed, run, warning, trimmed: Number(request.seconds) > seconds, maxClipSeconds: limits().maxClipSeconds };
	}

	async function create(request) {
		if (request.rightsConfirmed !== true) throw new VideoError('Confirm that you have the right to use this footage first.');
		const { video, image, seconds } = validate(request);
		const q = await quote(request);
		if (!q.allowed) throw new VideoError(q.reason);
		if (request.confirmEstimate !== q.estimate) throw new VideoError(`The price changed to $${q.estimate.toFixed(2)}. Review the new price and confirm again.`);

		const id = randomUUID();
		// From here the files belong to this job, so the unsent-upload cleanup leaves them alone.
		if (!db.claimUpload(video.id, `job:${id}`)) throw new VideoError('That clip was already used. Choose it again.');
		// The character picture may be one made on the Characters page, which already has an owner.
		db.claimUpload(image.id, `job:${id}`);
		const size = outputSize(Number(request.width), Number(request.height));
		const now = clock();
		db.insertJob({
			id, kind: 'replace', status: 'starting', input_upload: video.id, ref_upload: image.id,
			prompt: String(request.prompt || '').trim().slice(0, 500),
			params: { ...size, seconds, minutes: q.minutes, run: q.run, estimate: q.estimate }, rights_confirmed_at: now, created_at: now
		});
		const task = run(id, q.minutes, q.run !== 'auto').catch((err) => console.error('[video]', err)).finally(() => running.delete(id));
		running.set(id, task);
		return view(db.getJob(id));
	}

	async function loadTemplate() {
		if (workflowTemplate) return workflowTemplate;
		const url = db.getSettings().videoWorkflowUrl || WORKFLOW_URL;
		const res = await fetch(url, { signal: AbortSignal.timeout(30000) }).catch(() => null);
		if (!res?.ok) throw new VideoError('Could not download the workflow file. Check the phone is online.');
		workflowTemplate = await res.json();
		return workflowTemplate;
	}

	/** Latest progress line from the pod's setup log, and whether setup has failed. */
	async function setupProgress(podId) {
		try {
			const res = await fetch(`${gpu.proxyUrl(podId, LOG_PORT)}/setup.log`, { signal: AbortSignal.timeout(8000) });
			if (!res.ok) return {};
			const lines = (await res.text()).trim().split('\n');
			const failed = lines.some((l) => l.startsWith('SETUP FAILED'));
			const step = lines.filter((l) => l.startsWith('STEP ')).at(-1);
			return { step: step?.replace(/^STEP /, ''), failed, tail: lines.filter((l) => !l.startsWith('SETUP FAILED')).slice(-4).join(' | ').slice(-400) };
		} catch { return {}; }
	}

	async function run(id, minutes, chosenLength = false) {
		let podId = '';
		const check = () => {
			if (cancelled.has(id)) throw new VideoError('cancelled');
			const pod = podId && db.getPod(podId);
			if (pod?.ended_at) throw new VideoError(`The GPU was shut down before the video finished (${pod.end_reason}). Nothing more was charged.`);
			if (podId) gpu.touch(podId); // a job in progress is activity, not idleness
		};
		try {
			const job = db.getJob(id);
			const params = JSON.parse(job.params);
			const template = await loadTemplate();
			buildWorkflow(template, { video: 'x', image: 'x', prompt: '', seed: 0, ...params }); // fail before renting if the file is wrong

			const pod = await gpu.start({ minutes, minVram: MIN_VRAM.comfy, fastNetwork: true, chosenLength, purpose: 'Video: character replacement', spec: comfyPodSpec() });
			podId = pod.id;
			db.updateJob(id, { pod_id: podId });
			const comfy = createComfyClient(gpu.proxyUrl(podId, COMFY_PORT));

			setStep(id, 'loading', 'Starting the GPU');
			for (;;) {
				check();
				if (await comfy.ready()) break;
				const p = await setupProgress(podId);
				if (p.failed) throw new VideoError(`Setting up the video engine failed: ${p.tail || 'no details available'}`);
				if (p.step) { const parsed = parseStep(p.step); if (parsed) tracker.report(id, parsed.index, p.step); }
				if (/Downloading/.test(p.step || '')) {
					const f = await fetch(`${gpu.proxyUrl(podId, LOG_PORT)}/files.txt`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
					if (f?.ok) tracker.files(id, await f.text());
				}
				if (p.step && p.step !== db.getJob(id).detail) db.updateJob(id, { detail: p.step });
				await sleep(pollMs);
			}

			setStep(id, 'uploading', 'Sending your video to the GPU');
			check();
			const input = db.getUpload(job.input_upload);
			const ref = db.getUpload(job.ref_upload);
			const video = await comfy.upload(input.path, `in-${id}-${input.name}`, input.type);
			const image = await comfy.upload(ref.path, `ref-${id}-${ref.name}`, ref.type);

			setStep(id, 'generating', 'Replacing the character');
			check();
			const prompt = job.prompt || 'a person, natural lighting, detailed, realistic';
			const promptId = await comfy.queue(buildWorkflow(template, { video, image, prompt, seed: Math.floor(Math.random() * 2 ** 31), ...params }), id);
			let files;
			for (;;) {
				await sleep(pollMs);
				check();
				const r = await comfy.result(promptId);
				if (r.done) { files = r.files; break; }
			}
			const out = files.find((f) => /\.(mp4|webm|mov)$/i.test(f.filename)) || files[0];
			if (!out) throw new VideoError('The video engine finished but produced no video.');

			setStep(id, 'saving', 'Saving the result to your phone');
			const uploadId = randomUUID();
			const dir = join(uploadsDir, uploadId);
			await mkdir(dir, { recursive: true, mode: 0o700 });
			const name = `replaced-${new Date(clock()).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.mp4`;
			const saved = await comfy.download(out, join(dir, name));
			db.insertUpload({ id: uploadId, name, type: 'video/mp4', size: saved.size, path: join(dir, name), created_at: clock() });
			db.claimUpload(uploadId, `job:${id}`);
			db.updateJob(id, { status: 'done', detail: '', result_upload: uploadId, ended_at: clock() });
		} catch (err) {
			const wasCancelled = cancelled.has(id);
			const known = err instanceof VideoError || err instanceof ComfyError || err instanceof GpuError;
			if (!known) console.error('[video]', err);
			db.updateJob(id, {
				status: wasCancelled ? 'cancelled' : 'failed',
				detail: wasCancelled ? 'You cancelled this.' : known ? err.message : 'Something unexpected went wrong. The GPU has been shut down.',
				ended_at: clock()
			});
		} finally {
			cancelled.delete(id);
			// The pod is deleted on every path out of here; its own timer is the backstop.
			if (podId && !db.getPod(podId)?.ended_at) {
				const reason = db.getJob(id).status === 'done' ? 'video finished' : `video ${db.getJob(id).status}`;
				await gpu.stop(podId, reason).catch((err) => console.error('[video] could not delete pod', podId, err.message));
			}
		}
	}

	return {
		quote, create, recover, limits,
		/** On shutdown: cancel what is running and wait for each job to delete its pod. */
		async shutdown() {
			for (const id of running.keys()) cancelled.add(id);
			await Promise.allSettled([...running.values()]);
		},
		list: () => db.listJobs().map(view),
		get: (id) => { const j = db.getJob(id); return j ? view(j) : null; },
		cancel(id) {
			const j = db.getJob(id);
			if (!j) return null;
			if (ACTIVE.has(j.status)) cancelled.add(id);
			return view(j);
		}
	};
}
