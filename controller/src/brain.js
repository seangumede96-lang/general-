// Starting the private brain, with real progress from the machine and automatic retries.
//
//   waiting for a GPU -> starting the machine -> downloading the model -> loading it into the GPU -> ready
//
// - The machine runs brain-pod.sh, which starts a tiny status server before anything else and
//   reports its stage, bytes downloaded and download speed every 2 seconds, plus a list of events.
// - The model is kept on the owner's RunPod network volume (made on the first start, in the data
//   centre that has the most suitable GPUs free), so it downloads once and is then reused. When
//   no GPU is free there, a GPU anywhere else is used and the model is downloaded to it directly.
// - GPU types are tried in order of price. A machine that sends no news for 90 seconds, whose
//   download stalls for 90 seconds, or whose model fails to load is deleted at once, and the next
//   GPU type or data centre is tried, all written to the backend log.
// - Nothing is left running after a failure: the app deletes the machine, and the machine also
//   deletes itself if it fails, or when its time runs out and the app cannot be reached.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { GpuError, BRAIN_PRESETS, brainLabel, isUncensored } from './gpu.js';

export const STATUS_PORT = 8081;
export const BRAIN_PORT = 8080;
export const MIN_VRAM_GB = 24;
export const VOLUME_NAME = 'assistant-models';
/** RunPod's network volume price: $0.07 per GB per month. */
export const VOLUME_USD_PER_GB_MONTH = 0.07;
const SCRIPT = readFileSync(new URL('./brain-pod.sh', import.meta.url));
const MODEL_RE = /^[\w.-]+\/[\w.-]+(:[\w.-]+)?$/;
const STEPS = ['Waiting for a GPU', 'Starting the machine', 'Downloading the model', 'Loading the model into the GPU'];
const PHASE_INDEX = { gpu: 0, starting: 1, downloading: 2, loading: 3, ready: 3 };
const usd = (n) => `$${n.toFixed(2)}`;
const ceilCents = (n) => Math.ceil(n * 100 - 1e-9) / 100;
const gbText = (b) => (b / 1e9).toFixed(1);

/**
 * Find the GGUF file behind "owner/repo:QUANT" on Hugging Face (public models need no token).
 * Returns { file, url, bytes }. The vision add-on (mmproj) files are skipped: chat does not use them.
 */
export async function resolveHfFile(model, { fetchImpl = fetch, base = 'https://huggingface.co' } = {}) {
	const [repo, quant = 'Q4_K_M'] = model.split(':');
	const res = await fetchImpl(`${base}/api/models/${repo}/tree/main?recursive=true`, { signal: AbortSignal.timeout(20000) });
	if (!res.ok) throw new GpuError(`Could not look up ${repo} on Hugging Face (HTTP ${res.status}).`, 'invalid');
	const files = (await res.json()).filter((f) => /\.gguf$/i.test(f.path) && !/mmproj/i.test(f.path) && f.path.toUpperCase().includes(quant.toUpperCase()));
	if (!files.length) throw new GpuError(`${repo} has no ${quant} file.`, 'invalid');
	if (files.length > 1 && files.every((f) => /-\d{5}-of-\d{5}/.test(f.path))) throw new GpuError(`${repo} ${quant} is split into parts, which is not supported yet.`, 'invalid');
	const f = files.sort((a, b) => a.path.length - b.path.length)[0];
	const bytes = f.lfs?.size || f.size;
	return { file: f.path.split('/').pop(), url: `${base}/${repo}/resolve/main/${encodeURI(f.path)}`, bytes };
}

export function createBrain({ db, gpu, clock = Date.now, fetchImpl = fetch, resolveFile = (m) => resolveHfFile(m, { fetchImpl }),
	retryMs = 20000, silenceMs = 90000, loadLimitMs = 8 * 60000, gpuWaitLimitMs = 15 * 60000, maxMachines = 5 }) {
	/** The current or last start: everything the progress card and the backend log show. */
	let run = null;
	const files = new Map(); // model -> resolved file, kept for the session

	const log = (text, at = clock()) => {
		if (!run) return;
		run.log.push({ at, text });
		if (run.log.length > 300) run.log.splice(0, run.log.length - 300);
	};
	const statusUrl = (podId, path) => `${gpu.proxyUrl(podId, STATUS_PORT)}${path}`;

	// ---- the owner's model storage (a RunPod network volume) ----
	const volumeSetting = () => { try { return JSON.parse(db.getSettings().brainVolume || 'null'); } catch { return null; } };
	const volumeGb = () => Math.max(10, Number.parseInt(db.getSettings().brainVolumeGb, 10) || 25);

	/** Suitable GPUs in RunPod's own data centres, each with its per-data-centre stock. */
	async function secureGpus() {
		const list = await gpu.catalogFor('SECURE');
		return list.filter((g) => g.secure && g.memory >= MIN_VRAM_GB && g.price?.secure > 0 && !/\bMIG\b/i.test(`${g.name || ''} ${g.id || ''}`))
			.map((g) => ({ id: g.id, name: g.name || g.id, memory: g.memory, rate: g.price.secure, cloud: 'SECURE', availability: g.availability, dataCenters: g.dataCenters || [] }))
			.sort((a, b) => a.rate - b.rate);
	}
	const dcId = (d) => d.id || d.dataCenterId || d.name;
	const SCORE = { HIGH: 3, MEDIUM: 2, LOW: 1 };

	/**
	 * The volume to use: the saved one if it still exists, else a new one in the best data centre.
	 * With `create` false (a price quote) nothing is made: the data centre it would go in is returned.
	 */
	async function ensureVolume(create = true) {
		const saved = volumeSetting();
		if (saved?.id) {
			try { await gpu.call('GET', `/network-volumes/${encodeURIComponent(saved.id)}`); return saved; }
			catch (err) { if (err.code !== 'not_found') throw err; log('Your model storage no longer exists on RunPod; making a new one'); }
		}
		// One left over from before (for example after the app's data was reset).
		const listed = (await gpu.call('GET', '/network-volumes'))?.networkVolumes || [];
		const mine = listed.find((v) => v.name === VOLUME_NAME);
		if (mine) {
			const v = { id: mine.id, dataCenter: mine.dataCenter || mine.dataCenterId };
			db.setSettings({ brainVolume: JSON.stringify(v) });
			log(`Using your existing model storage in ${v.dataCenter}`);
			return v;
		}
		const dcs = (await gpu.call('GET', '/catalog/datacenters'))?.dataCenters || [];
		const volumeDcs = new Set(dcs.filter((d) => !d.networkVolumeTypes || d.networkVolumeTypes.length).map(dcId));
		const score = new Map();
		for (const g of (await secureGpus()).filter((x) => x.rate <= 1.2)) {
			for (const d of g.dataCenters) {
				const id = dcId(d);
				if (volumeDcs.size && !volumeDcs.has(id)) continue;
				score.set(id, (score.get(id) || 0) + (SCORE[d.availability] || 0));
			}
		}
		const best = [...score.entries()].sort((a, b) => b[1] - a[1])[0];
		if (!best || best[1] === 0) throw new GpuError('No data centre with storage has a suitable GPU free right now.', 'unavailable');
		const size = volumeGb();
		if (!create) return { id: null, dataCenter: best[0] };
		const made = await gpu.call('POST', '/network-volumes', { name: VOLUME_NAME, size, dataCenter: best[0] });
		const v = { id: made.id, dataCenter: made.dataCenter || best[0] };
		db.setSettings({ brainVolume: JSON.stringify(v) });
		log(`Made ${size} GB model storage in ${v.dataCenter} (${usd(size * VOLUME_USD_PER_GB_MONTH)}/month), where suitable GPUs are most often free`);
		return v;
	}

	/**
	 * The ordered list of machines to try: first GPU types in the storage's data centre (the model
	 * is already there), then GPU types anywhere (the model is downloaded to the machine itself).
	 */
	async function plan({ quiet = false, create = true } = {}) {
		const out = [];
		let volume = null;
		try { volume = await ensureVolume(create); }
		catch (err) { if (!quiet) log(`Model storage unavailable (${err.message}); downloading to the machine instead`); }
		if (volume) {
			const here = (await secureGpus()).filter((g) => {
				const d = g.dataCenters.find((x) => dcId(x) === volume.dataCenter);
				return g.dataCenters.length ? d && d.availability !== 'NONE' : g.availability !== 'NONE';
			});
			for (const g of here.slice(0, 4)) out.push({ gpu: g, where: volume.dataCenter, placement: { dataCenterIds: [volume.dataCenter], volumeId: volume.id, path: '/workspace' }, store: 'volume' });
		}
		const anywhere = await gpu.candidates(MIN_VRAM_GB, false, true, true);
		for (const g of anywhere.slice(0, 4)) out.push({ gpu: g, where: 'any data centre', placement: null, store: 'disk' });
		return out;
	}
	const key = (a) => `${a.gpu.id}|${a.where}|${a.gpu.cloud}`;

	/** The worst-case price for a start of `minutes`, covering every machine that may be tried. */
	async function quote({ minutes }) {
		minutes = Number(minutes);
		if (!Number.isFinite(minutes) || minutes < 1) throw new GpuError('Minutes must be at least 1.', 'invalid');
		const options = await plan({ quiet: true, create: false });
		await gpu.refreshBalance();
		const { remaining, known } = gpu.budget();
		if (!options.length) return { allowed: false, reason: `No GPU with ${MIN_VRAM_GB} GB or more is available right now.`, options: [], remaining };
		const worst = Math.max(...options.map((o) => o.gpu.rate));
		const estimate = ceilCents(worst * minutes / 60);
		let reason = null;
		if (db.listPods().some((p) => !p.ended_at) || busy()) reason = 'A GPU is already running or starting. Stop it first.';
		else if (!known) reason = 'Could not read your RunPod balance, and no spending cap is set. Try again, or set a cap on the System page.';
		else if (estimate > remaining) reason = `This could cost up to ${usd(estimate)} but only ${usd(remaining)} is left.`;
		const first = options[0].gpu;
		return {
			allowed: !reason, reason, minutes, estimate, remaining,
			options: options.map((o) => ({ id: o.gpu.id, name: o.gpu.name, rate: o.gpu.rate, cloud: o.gpu.cloud, where: o.where })),
			summary: `${first.name} at ${usd(first.rate)}/h${worst > first.rate ? `, or another up to ${usd(worst)}/h,` : ''} for up to ${minutes} min: at most ${usd(estimate)}. ${usd(remaining)} is left.`
		};
	}

	const busy = () => Boolean(run && ['gpu', 'starting', 'downloading', 'loading'].includes(run.phase));

	/** Start a brain. Resolves after the first try at getting a machine; the rest runs in the background. */
	async function start({ minutes, confirmEstimate, model }) {
		model = String(model || db.getSettings().brainModel).trim();
		if (!MODEL_RE.test(model)) throw new GpuError('The brain model must look like "owner/repository:QUANT" on Hugging Face.', 'invalid');
		if (busy()) throw new GpuError('A brain is already starting.', 'refused');
		const q = await quote({ minutes });
		if (!q.allowed) throw new GpuError(q.reason, 'refused');
		if (confirmEstimate !== q.estimate) throw new GpuError(`The price changed to ${q.estimate.toFixed(2)} USD. Review the new quote and confirm again.`, 'refused');
		const file = files.get(model) || await resolveFile(model);
		files.set(model, file);
		const preset = BRAIN_PRESETS.find((p) => p.id === model);
		run = {
			model, label: preset?.label || brainLabel(model), file, minutes: q.minutes, phase: 'gpu', startedAt: clock(), log: [],
			podId: null, attempt: null, bad: new Set(), machines: 0, nextTryAt: 0, seen: 0, status: null,
			lastNewsAt: 0, lastProgress: null, speeds: [], phaseSince: clock(), error: null
		};
		log(`Turning on ${run.label} (${gbText(file.bytes)} GB) for up to ${q.minutes} min; at most ${usd(q.estimate)}`);
		await step();
		return view();
	}

	/** The pod spec for one machine. The keys are made per pod; none of the owner's keys go to it. */
	function spec(store) {
		const s = db.getSettings();
		const secret = randomBytes(24).toString('hex');
		return {
			kind: 'brain', secret, model: run.model, name: 'assistant-brain', image: s.brainImage || 'ghcr.io/seangumede96-lang/assistant-brain-engine:latest',
			disk: store === 'volume' ? 10 : 40, ports: [`${BRAIN_PORT}/http`, `${STATUS_PORT}/http`], selfTimer: true,
			env: {
				LLAMA_API_KEY: secret, STATUS_KEY: secret, MODEL_URL: run.file.url, MODEL_FILE: run.file.file, MODEL_BYTES: String(run.file.bytes),
				STORE: store, CTX: String(Math.max(2048, Number.parseInt(s.brainContext, 10) || 16384)), BRAIN_SCRIPT: SCRIPT.toString('base64')
			},
			cmd: 'echo "$BRAIN_SCRIPT" | base64 -d > /srv-brain.sh && exec bash /srv-brain.sh'
		};
	}

	/** Try the machines in order until one is created. */
	async function tryMachines() {
		let options;
		try { options = await plan(); }
		catch (err) { log(`Could not read GPU stock (${err.message}); trying again in ${Math.round(retryMs / 1000)} s`); run.nextTryAt = clock() + retryMs; return; }
		const left = options.filter((a) => !run.bad.has(key(a)));
		if (options.length && !left.length) return fail(`every suitable GPU choice (${run.bad.size}) was tried and failed to start. Nothing is left running`);
		for (const a of left) {
			try {
				const pod = await gpu.createOne({ gpu: a.gpu, spec: spec(a.store), minutes: run.minutes, purpose: `Private brain · ${run.label}${isUncensored(run.model) && !/uncensored/i.test(run.label) ? ' (uncensored)' : ''}`, placement: a.placement });
				run.machines++;
				Object.assign(run, { podId: pod.id, attempt: a, phase: 'starting', phaseSince: clock(), seen: 0, status: null, lastNewsAt: 0, lastProgress: null, speeds: [] });
				log(`GPU found: ${a.gpu.name} in ${pod.dataCenter || a.where} at ${usd(pod.rate)}/h${a.store === 'volume' ? ' (next to your model storage)' : ' (model will be downloaded to it)'}`);
				return;
			} catch (err) {
				if (err.code === 'unavailable') { log(`${a.gpu.name} in ${a.where}: none free`); continue; }
				throw err;
			}
		}
		run.nextTryAt = clock() + retryMs;
		log(`No GPU free right now; trying again in ${Math.round(retryMs / 1000)} s`);
	}

	/** Give up on the current machine: delete it (so it stops charging) and move on to the next. */
	async function abandon(reason) {
		const a = run.attempt;
		log(`${reason}. Deleting this machine (${a.gpu.name}) and trying the next GPU`);
		// stopSoon keeps retrying in the background if RunPod cannot be reached this moment.
		const r = await gpu.stopSoon(run.podId, reason).catch((err) => ({ error: err.message }));
		if (r?.stopping) log('RunPod could not be reached to delete it; retrying every 15 s (it also deletes itself)');
		else if (r?.error) log(`Delete failed: ${r.error}`);
		run.bad.add(key(a));
		Object.assign(run, { podId: null, attempt: null, phase: 'gpu', phaseSince: clock(), nextTryAt: 0 });
		if (run.machines >= maxMachines) fail(`${run.machines} machines failed to start. Nothing is left running`);
	}
	function fail(why) {
		log(`Gave up: ${why}`);
		Object.assign(run, { phase: 'failed', error: why, podId: null });
	}

	/** Read the machine's status server: its stage line and any new events. */
	async function readStatus() {
		const get = async (path) => {
			const res = await fetchImpl(statusUrl(run.podId, `${path}?t=${clock()}`), { signal: AbortSignal.timeout(6000) });
			return res.ok ? res.text() : null;
		};
		let line;
		try { line = await get('/state'); } catch { line = null; }
		if (!line || !/^\w+ \d+ \d+ \d+ \d+/.test(line.trim())) return null;
		const [stage, done, total, speed, t] = line.trim().split(/\s+/);
		const s = { stage, done: Number(done), total: Number(total), speed: Number(speed), t: Number(t), events: [] };
		try { s.events = ((await get('/events')) || '').split('\n').filter(Boolean); }
		catch { /* the stage line is what matters */ }
		return s;
	}

	/** Watch one machine: progress, silence, stalls, failures, ready. */
	async function watchMachine() {
		const now = clock();
		const s = await readStatus();
		if (s) {
			if (!run.status || s.t !== run.status.t) {
				if (!run.lastNewsAt) log(`First news from the machine, ${Math.round((now - (db.getPod(run.podId)?.created_at || now)) / 1000)} s after it was created: its status reporter is up`);
				run.lastNewsAt = now;
			}
			for (const l of s.events.slice(run.seen)) {
				const m = /^(\d+) (.*)$/.exec(l);
				if (m) log(m[2], Number(m[1]) * 1000);
			}
			run.seen = Math.max(run.seen, s.events.length);
			run.status = s;
			if (s.stage === 'downloading') {
				if (!run.lastProgress || s.done > run.lastProgress.done) {
					if (run.lastProgress && now > run.lastProgress.at) run.speeds.push((s.done - run.lastProgress.done) / ((now - run.lastProgress.at) / 1000));
					if (run.speeds.length > 8) run.speeds.shift();
					run.lastProgress = { done: s.done, at: now };
				}
			}
			const phase = { starting: 'starting', downloading: 'downloading', loading: 'loading', ready: 'loading', failed: 'failed' }[s.stage] || 'starting';
			if (phase !== run.phase && phase !== 'failed') Object.assign(run, { phase, phaseSince: now });
			if (s.stage === 'failed') return abandon('The machine reported a failure');
			if (s.stage === 'ready') {
				// The model answers on the machine; confirm it answers through RunPod's address too.
				const pod = await gpu.probeBrain();
				if (pod?.ready_at) {
					Object.assign(run, { phase: 'ready', phaseSince: now });
					log(`Ready: ${run.label} on ${run.attempt.gpu.name}, ${Math.round((now - run.startedAt) / 1000)} s after you turned it on. Chat is using it`);
					return;
				}
			}
		}
		const since = run.lastNewsAt || db.getPod(run.podId)?.created_at || now;
		if (now - since >= silenceMs) return abandon(`No news from the machine for ${Math.round((now - since) / 1000)} s`);
		if (run.phase === 'downloading' && run.lastProgress && now - run.lastProgress.at >= silenceMs) return abandon(`The download made no progress for ${Math.round((now - run.lastProgress.at) / 1000)} s`);
		if (run.phase === 'loading' && now - run.phaseSince >= loadLimitMs) return abandon(`Loading into the GPU took over ${Math.round(loadLimitMs / 60000)} min`);
	}

	/** Advance the start by one step; called every few seconds and whenever the app asks for status. */
	let stepping = null;
	function step() {
		if (!stepping) stepping = doStep().catch((err) => { if (run && busy()) log(`Problem: ${err.message}`); }).finally(() => { stepping = null; });
		return stepping;
	}
	async function doStep() {
		if (!run) adopt();
		if (!run || !busy()) return;
		// The machine may have been deleted elsewhere (stopped by you, its time limit, idle).
		if (run.podId) {
			const pod = db.getPod(run.podId);
			if (!pod || pod.ended_at) {
				log(`The machine was stopped (${pod?.end_reason || 'gone'})`);
				Object.assign(run, { phase: 'off', podId: null });
				return;
			}
			return watchMachine();
		}
		if (clock() - run.startedAt >= gpuWaitLimitMs) return fail(`no GPU could be started in ${Math.round(gpuWaitLimitMs / 60000)} min. Nothing is running or charging`);
		if (clock() >= run.nextTryAt) return tryMachines();
	}

	/** After an app restart, pick up a brain machine that is already running. */
	function adopt() {
		const pod = db.listPods().find((p) => !p.ended_at && p.kind === 'brain');
		if (!pod) return;
		const preset = BRAIN_PRESETS.find((p) => p.id === pod.model);
		run = {
			model: pod.model, label: preset?.label || brainLabel(pod.model), file: files.get(pod.model) || { bytes: (preset?.sizeGb || 0) * 1e9, file: '' },
			minutes: Math.round((pod.deadline_at - pod.created_at) / 60000), phase: pod.ready_at ? 'ready' : 'starting', startedAt: pod.created_at, log: [],
			podId: pod.id, attempt: { gpu: { name: pod.gpu, id: pod.gpu, cloud: '' }, where: '' }, bad: new Set(), machines: 1, nextTryAt: 0, seen: 0,
			status: null, lastNewsAt: clock(), lastProgress: null, speeds: [], phaseSince: clock(), error: null
		};
		log('The app restarted; picking up the running machine');
	}

	/** Stop: cancel a start that is still waiting for a GPU, or delete the machine. */
	async function stop(reason = 'stopped by you') {
		if (!run) adopt();
		if (!run) return;
		const id = run.podId || db.listPods().find((p) => !p.ended_at && p.kind === 'brain')?.id;
		if (id) await gpu.stop(id, reason);
		if (busy() || run.phase === 'ready') log(id ? 'Turned off: the machine was deleted, charges stopped' : 'Cancelled before any machine started: nothing was charged');
		Object.assign(run, { phase: 'off', podId: null });
	}

	/** Give the session more time: on the app's records and on the machine's own self-delete timer. */
	async function extend(minutes) {
		minutes = Number(minutes);
		if (!(minutes >= 5 && minutes <= 240)) throw new GpuError('Add between 5 and 240 minutes.', 'invalid');
		const pod = db.listPods().find((p) => !p.ended_at && p.kind === 'brain');
		if (!pod) throw new GpuError('The private brain is not on.', 'invalid');
		await gpu.refreshBalance();
		const extra = ceilCents(pod.rate * minutes / 60);
		const { remaining, known } = gpu.budget();
		if (!known || extra > remaining) throw new GpuError(`${minutes} more minutes could cost ${usd(extra)} but only ${usd(remaining)} is left.`, 'refused');
		// "Add 30 min" means 30 more minutes than the chip shows now, whichever rule would end it:
		// the time limit moves out, and the idle rule cannot end it before then either.
		const now = clock();
		const current = session();
		const newEnd = now + (current.secondsLeft + minutes * 60) * 1000;
		const deadline = Math.max(pod.deadline_at, newEnd);
		const res = await fetchImpl(statusUrl(pod.id, '/cgi-bin/extend'), { method: 'POST', body: `${pod.secret} ${Math.floor(deadline / 1000) + 120}`, signal: AbortSignal.timeout(10000) }).catch(() => null);
		const onMachine = res?.ok && /ok/.test(await res.text());
		if (!onMachine) throw new GpuError('Could not reach the machine to extend its timer. Try again in a moment.', 'failed');
		db.setPodDeadline(pod.id, deadline);
		db.touchPod(pod.id, newEnd - current.idleMinutes * 60000);
		if (!run) adopt();
		log(`Session extended by ${minutes} min (up to ${usd(extra)} more)`);
		return session();
	}

	/** Time left in the session: the sooner of the idle shut-down and the session's time limit. */
	function session() {
		const pod = db.listPods().find((p) => !p.ended_at && p.kind === 'brain');
		if (!pod) return null;
		const now = clock();
		const idleMin = Math.max(1, Number.parseInt(db.getSettings().idleMinutes, 10) || 10);
		const idleAt = pod.ready_at ? pod.last_used_at + idleMin * 60000 : Infinity;
		const endsAt = Math.min(idleAt, pod.deadline_at);
		return {
			podId: pod.id, label: BRAIN_PRESETS.find((p) => p.id === pod.model)?.label || brainLabel(pod.model), gpu: pod.gpu, rate: pod.rate,
			ready: Boolean(pod.ready_at), secondsLeft: Math.max(0, Math.round((endsAt - now) / 1000)),
			reason: idleAt < pod.deadline_at ? 'idle' : 'limit', idleMinutes: idleMin,
			idleSecondsLeft: Number.isFinite(idleAt) ? Math.max(0, Math.round((idleAt - now) / 1000)) : null,
			limitSecondsLeft: Math.max(0, Math.round((pod.deadline_at - now) / 1000))
		};
	}

	/** What the progress card and the log show. */
	function view() {
		if (!run) adopt();
		if (!run) return { phase: 'off', log: [] };
		const now = clock();
		const s = run.status;
		const total = s?.total || run.file?.bytes || 0;
		const done = run.phase === 'downloading' ? s?.done || 0 : run.phase === 'loading' || run.phase === 'ready' ? total : 0;
		// Speed from the bytes actually received over the last readings; the machine's own figure until then.
		const measured = run.speeds.length ? run.speeds.reduce((a, b) => a + b, 0) / run.speeds.length : 0;
		const speed = run.phase === 'downloading' ? (measured || s?.speed || 0) : 0;
		const index = PHASE_INDEX[run.phase] ?? 0;
		const fraction = run.phase === 'ready' ? 1 : run.phase === 'loading' ? 0.93 : run.phase === 'downloading' && total ? 0.05 + 0.85 * (done / total) : index * 0.02;
		const progress = busy() ? {
			steps: STEPS, index, fraction,
			// Time left only once there is a real download speed to calculate it from.
			etaSeconds: run.phase === 'downloading' && speed > 0 ? Math.round((total - done) / speed) : null,
			elapsedSeconds: Math.round((now - run.startedAt) / 1000),
			detail: run.phase === 'gpu' ? (run.nextTryAt > now ? 'none free yet, trying again shortly' : '')
				: run.phase === 'starting' ? `${run.attempt?.gpu.name || ''}${run.lastNewsAt ? '' : ', waiting for its first news'}`
					: run.phase === 'loading' ? `${Math.round((now - run.phaseSince) / 1000)} s so far` : '',
			files: run.phase === 'downloading' ? [{ name: 'Model file', done, total, speed }] : [],
			quietSeconds: run.podId ? Math.round((now - (run.lastNewsAt || db.getPod(run.podId)?.created_at || now)) / 1000) : 0,
			quietLimitSeconds: 45
		} : null;
		return { phase: run.phase, model: run.model, label: run.label, error: run.error, startedAt: run.startedAt, podId: run.podId, progress, log: run.log };
	}

	return { quote, start, step, stop, extend, session, view, volume: volumeSetting, busy };
}
