import { randomBytes } from 'node:crypto';
import { createTracker, computeProgress, brainPlan } from './progress.js';
// RunPod pod lifecycle with a spend ledger. Rules enforced here, in code:
//   - the cheapest GPU that fits the job, in whichever cloud has it
//   - one pod at a time, and only if its worst-case cost fits the remaining budget
//   - every pod has a fixed maximum lifetime, decided before it starts
//   - pods are terminated (never just stopped) when idle, when their time is up, or on request
//   - the pod also carries its own timer and deletes itself if the controller disappears
// Built against RunPod REST API v2 (https://api.runpod.io/v2); v1 retires 15 Nov 2026.

const REAL_API = 'https://api.runpod.io/v2';
const REAL_GRAPHQL = 'https://api.runpod.io/graphql';
const BALANCE_MAX_AGE_MS = 60000;
const CATALOG_MAX_AGE_MS = 60000;
// How long a page may wait for RunPod before it is shown what is already known.
const STATUS_WAIT_MS = 4000;
const DEADMAN_GRACE_S = 120;
const HOUR_MS = 3600 * 1000;
const BRAIN_PORT = 8080;
// A pod that is still downloading its model is not idle; give it this long before the idle rule applies.
const STARTUP_GRACE_MS = 30 * 60000;

export class GpuError extends Error {
	constructor(message, code = 'failed') { super(message); this.code = code; }
}

const usd = (n) => `$${n.toFixed(2)}`;
/** Round a cost up to the next cent so estimates never understate. */
const ceilCents = (n) => Math.ceil(n * 100 - 1e-9) / 100;

/**
 * Build the pod's start arguments so that it deletes itself after `seconds`, using the
 * pod-scoped key RunPod injects. This is the backstop for a dead or offline controller.
 * The entrypoint is replaced with bash explicitly, so the timer works whatever ENTRYPOINT
 * the image declares; `cmd` must therefore be the full command line to run.
 */
export function withDeadman(cmd, seconds) {
	// Images differ in what they ship, so try every tool that could send the request.
	const url = `${REAL_API}/pods/$RUNPOD_POD_ID`;
	const auth = '"Authorization: Bearer $RUNPOD_API_KEY"';
	const kill = `curl -s -X DELETE ${url} -H ${auth}; wget -q -O- --method=DELETE --header=${auth} ${url}; runpodctl pod delete $RUNPOD_POD_ID`;
	return JSON.stringify({ entrypoint: ['bash', '-c'], cmd: [`(sleep ${Math.round(seconds)}; ${kill}) & ${cmd}`] });
}

export function createGpuManager({ db, clock = Date.now }) {
	const cfg = () => {
		const s = db.getSettings();
		return {
			key: s.runpodApiKey,
			base: (s.runpodBaseUrl || REAL_API).replace(/\/+$/, ''),
			clouds: s.podCloud === 'SECURE' ? ['SECURE'] : s.podCloud === 'COMMUNITY' ? ['COMMUNITY'] : ['COMMUNITY', 'SECURE'],
			graphql: s.runpodGraphqlUrl || REAL_GRAPHQL,
			cap: Math.max(0, Number.parseFloat(s.budgetTotal) || 0) || null,
			maxPodMinutes: Math.max(1, Number.parseInt(s.maxPodMinutes, 10) || 60),
			idleMinutes: Math.max(1, Number.parseInt(s.idleMinutes, 10) || 10)
		};
	};

	async function call(method, path, body) {
		const { key, base } = cfg();
		if (!key) throw new GpuError('No RunPod API key is saved yet. Add one on the System page.', 'not_configured');
		let res;
		try {
			res = await fetch(base + path, {
				method,
				headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(30000)
			});
		} catch (err) {
			throw new GpuError(`Could not reach RunPod (${err?.cause?.code || err.message}).`, 'network');
		}
		if (res.status === 204) return null;
		const data = await res.json().catch(() => ({}));
		if (res.ok) return data;
		const detail = data.detail || data.title || `HTTP ${res.status}`;
		if (res.status === 401) throw new GpuError('RunPod rejected the API key.', 'unauthorized');
		if (res.status === 402) throw new GpuError('RunPod reports the account balance is too low.', 'no_balance');
		if (res.status === 404) throw new GpuError(detail, 'not_found');
		throw new GpuError(`RunPod: ${detail}`, res.status === 400 || res.status === 403 ? 'unavailable' : 'failed');
	}

	const accrued = (pod, until = clock()) => pod.rate * Math.max(0, (pod.ended_at || until) - pod.created_at) / HOUR_MS;

	/** Last balance read from RunPod: { value, at, key } or null if it has never been read. */
	let balance = null;

	/**
	 * Read the account's real credit balance. RunPod's REST API has no balance route; this is
	 * the GraphQL query its own CLI uses. A failed read keeps the last known value.
	 */
	async function refreshBalance(force = false) {
		const { key, graphql } = cfg();
		if (!key) { balance = null; return; }
		if (balance && balance.key !== key) balance = null;
		if (!force && balance && clock() - balance.at < BALANCE_MAX_AGE_MS) return;
		try {
			const res = await fetch(graphql, {
				method: 'POST',
				headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ query: 'query { myself { clientBalance currentSpendPerHr } }' }),
				signal: AbortSignal.timeout(15000)
			});
			const value = (await res.json())?.data?.myself?.clientBalance;
			if (typeof value === 'number') balance = { value, at: clock(), key };
		} catch { /* offline or changed API: fall back to the cap, or refuse if there is none */ }
	}

	/**
	 * What may still be spent: the real RunPod balance, further limited by the optional cap.
	 * With neither a readable balance nor a cap, nothing may be spent.
	 */
	function budget() {
		const { cap } = cfg();
		// Rounded up once, so "spent" and "remaining" stay consistent on screen.
		const spent = ceilCents(db.listPods().reduce((sum, p) => sum + (p.actual_cost ?? accrued(p)), 0));
		const real = balance ? balance.value : null;
		const limits = [real, cap === null ? null : cap - spent].filter((n) => n !== null);
		const remaining = limits.length ? Math.max(0, Math.min(...limits)) : 0;
		return { total: remaining + spent, spent, remaining, balance: real, cap, known: limits.length > 0 };
	}

	/**
	 * Cheapest GPUs that meet the VRAM floor and have capacity now, across the allowed clouds.
	 * Stock changes by the minute, so up to three are returned as fallbacks, but only ones
	 * priced within twice the cheapest: a fallback must never be a much dearer card.
	 */
	async function candidates(minVram, fastNetwork = false, wholeGpu = false) {
		// Jobs that download tens of gigabytes go to RunPod's own data centres (Secure Cloud) when
		// one is free: privately hosted machines can be far too slow to download on.
		if (fastNetwork && cfg().clouds.includes('SECURE')) {
			const secure = await candidatesIn(['SECURE'], minVram, wholeGpu);
			if (secure.length) return secure;
		}
		return candidatesIn(cfg().clouds, minVram, wholeGpu);
	}

	/** RunPod's price list per cloud, kept for a minute: it is slow to fetch (seconds from a phone) and a quote is followed at once by a start. */
	const catalog = new Map();
	async function catalogFor(cloud) {
		const { key, base } = cfg();
		const hit = catalog.get(cloud);
		if (hit && hit.key === key + base && clock() - hit.at < CATALOG_MAX_AGE_MS) return hit.gpus;
		const { gpus = [] } = await call('GET', `/catalog/gpus?include=AVAILABILITY&product=POD&cloud=${cloud}`);
		catalog.set(cloud, { gpus, at: clock(), key: key + base });
		return gpus;
	}

	/** `wholeGpu` skips MIG slices: a fraction of a card's compute, far too slow for video. */
	async function candidatesIn(clouds, minVram, wholeGpu = false) {
		const found = [];
		const lists = await Promise.all(clouds.map((cloud) => catalogFor(cloud)));
		clouds.forEach((cloud, i) => {
			const side = cloud.toLowerCase();
			for (const g of lists[i]) {
				if (wholeGpu && /\bMIG\b/i.test(`${g.name || ''} ${g.id || ''}`)) continue;
				if (g[side] && g.memory >= minVram && g.availability !== 'NONE' && g.price?.[side] > 0) {
					found.push({ id: g.id, name: g.name || g.id, memory: g.memory, rate: g.price[side], cloud, availability: g.availability });
				}
			}
		});
		found.sort((a, b) => a.rate - b.rate);
		return found.filter((o) => o.rate <= found[0].rate * 2).slice(0, 3);
	}

	async function quote({ minutes, minVram = 0, fastNetwork = false, chosenLength = false, wholeGpu = false }) {
		const c = cfg();
		minutes = Number(minutes);
		if (!Number.isFinite(minutes) || minutes < 1) throw new GpuError('Minutes must be at least 1.', 'invalid');
		const options = await candidates(minVram, fastNetwork, wholeGpu);
		await refreshBalance();
		const { remaining, known } = budget();
		if (!options.length) return { allowed: false, reason: minVram ? `No GPU with ${minVram} GB or more is available right now.` : 'No GPU is available right now.', options, remaining };
		// Any of the options may be the one that has capacity, so budget for the dearest.
		const worstRate = Math.max(...options.map((o) => o.rate));
		const estimate = ceilCents(worstRate * minutes / 60);
		let reason = null;
		// The per-pod limit guards automatic lengths; a length the owner picked themselves is allowed.
		if (minutes > c.maxPodMinutes && !chosenLength) reason = `${minutes} minutes is over the ${c.maxPodMinutes}-minute limit per pod.`;
		else if (db.listPods().some((p) => !p.ended_at)) reason = 'A pod is already running. Stop it first.';
		else if (!known) reason = 'Could not read your RunPod balance, and no spending cap is set. Try again, or set a cap on the System page.';
		else if (estimate > remaining) reason = `This could cost up to ${usd(estimate)} but only ${usd(remaining)} is left.`;
		return {
			allowed: !reason, reason, options, minutes, estimate, remaining,
			// Stock moves between the quote and the start, so name the range, not just the cheapest.
			summary: `${options[0].name} at ${usd(options[0].rate)}/h${worstRate > options[0].rate ? `, or the next cheapest up to ${usd(worstRate)}/h,` : ''} for up to ${minutes} min: at most ${usd(estimate)}. ${usd(remaining)} is left.`
		};
	}

	/**
	 * Start a pod. `spec` is { name, image, cmd, ports, env, disk }. The pod's lifetime is
	 * fixed at `minutes`; the worst case is checked against the budget before anything starts.
	 */
	async function start({ minutes, purpose = '', minVram = 0, fastNetwork = false, chosenLength = false, wholeGpu = false, spec }) {
		const q = await quote({ minutes, minVram, fastNetwork, chosenLength, wholeGpu });
		if (!q.allowed) throw new GpuError(q.reason, 'refused');
		let lastError;
		for (const gpu of q.options) {
			let pod;
			try {
				pod = await call('POST', '/pods', {
					name: spec.name,
					image: spec.image,
					args: withDeadman(spec.cmd, minutes * 60 + DEADMAN_GRACE_S),
					disk: spec.disk || 20,
					ports: spec.ports || [],
					env: spec.env || {},
					cloud: gpu.cloud,
					gpu: { id: gpu.id, count: 1 }
				});
			} catch (err) {
				lastError = err;
				if (err.code === 'network') {
					// The request may have reached RunPod even though the answer did not reach
					// this phone: delete any pod of ours this app does not know about, so nothing
					// is left running (and charging) unseen.
					await removeUnknownPods(spec.name);
					throw new GpuError(`Could not reach RunPod to start the GPU (${err.message.replace(/^Could not reach RunPod \(|\)\.$/g, '')}). Nothing was left running. Check the phone's connection and try again.`, 'network');
				}
				catalog.clear(); // the list said this was in stock and it was not
				if (err.code === 'unavailable') continue; // no capacity for this type: try the next
				throw err;
			}
			const now = clock();
			// Trust the rate RunPod reports for the pod it actually placed.
			const rate = Number(pod.cost) > 0 ? Number(pod.cost) : gpu.rate;
			db.insertPod({ id: pod.id, name: spec.name, gpu: gpu.name, rate, purpose, created_at: now, last_used_at: now, deadline_at: now + minutes * 60000, kind: spec.kind, secret: spec.secret, model: spec.model });
			return db.getPod(pod.id);
		}
		throw new GpuError(`None of the available GPUs could be started. ${lastError?.message || ''}`.trim(), 'unavailable');
	}

	/** Delete running pods with this app's name that are not in its records (made during a dropped connection). */
	async function removeUnknownPods(name) {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const { pods = [] } = (await call('GET', '/pods')) || {};
				for (const p of pods) {
					if (p.name === name && p.status !== 'TERMINATED' && !db.getPod(p.id)) {
						await call('DELETE', `/pods/${encodeURIComponent(p.id)}`).catch(() => {});
					}
				}
				return;
			} catch { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); }
		}
	}

	/** Delete a pod. `reasonIfGone` is recorded instead when RunPod says it no longer exists. */
	async function stop(id, reason, reasonIfGone = reason) {
		const pod = db.getPod(id);
		let gone = false;
		try { await call('DELETE', `/pods/${encodeURIComponent(id)}`); }
		catch (err) { if (err.code !== 'not_found') throw err; gone = true; }
		if (pod && !pod.ended_at) db.endPod(id, clock(), gone ? reasonIfGone : reason);
		return db.getPod(id);
	}

	const touch = (id) => db.touchPod(id, clock());
	/** Readiness checks for pods that run a service: kind -> async (pod) that marks it ready when it answers. */
	const probes = new Map([['brain', () => probeBrain()]]);
	const registerProbe = (kind, fn) => probes.set(kind, fn);

	const proxyUrl = (podId, port) => db.getSettings().podProxyTemplate.replace('{id}', podId).replace('{port}', port).replace(/\/+$/, '');
	const brainPod = () => db.listPods().find((p) => !p.ended_at && p.kind === 'brain') || null;

	/** The pod spec for the private brain: llama.cpp serving one model, locked with a random key. */
	function brainSpec() {
		const s = db.getSettings();
		const model = s.brainModel.trim();
		if (!/^[\w.-]+\/[\w.-]+(:[\w.-]+)?$/.test(model)) throw new GpuError('The brain model must look like "owner/repository:QUANT" on Hugging Face.', 'invalid');
		const ctx = Math.max(2048, Number.parseInt(s.brainContext, 10) || 16384);
		const secret = randomBytes(24).toString('hex');
		return {
			kind: 'brain', secret, model, name: 'assistant-brain', image: 'ghcr.io/ggml-org/llama.cpp:server-cuda', disk: 40, ports: [`${BRAIN_PORT}/http`],
			// The pod's address is public, so the server only answers requests carrying this key.
			env: { LLAMA_API_KEY: secret },
			cmd: `/app/llama-server -hf ${model} --host 0.0.0.0 --port ${BRAIN_PORT} -ngl all -c ${ctx} -a brain`
		};
	}

	let brainStage = 'downloading';
	const brainTracker = createTracker(clock);
	/** Ask the brain pod whether its model has finished loading; remember the first yes. */
	async function probeBrain() {
		const pod = brainPod();
		if (!pod || pod.ready_at) return pod;
		try {
			const res = await fetch(`${proxyUrl(pod.id, BRAIN_PORT)}/health`, { signal: AbortSignal.timeout(8000) });
			if (res.ok) { db.setPodReady(pod.id, clock()); db.touchPod(pod.id, clock()); }
			// llama.cpp answers 503 once it is running and reading the model into memory; before
			// that the machine is still booting or downloading and nothing answers on the port.
			brainStage = res.ok ? 'ready' : res.status === 503 ? 'loading' : 'downloading';
		} catch { brainStage = 'downloading'; }
		if (brainStage !== 'ready') brainTracker.report(pod.id, brainStage === 'loading' ? 1 : 0, brainStage);
		return brainPod();
	}

	/** Where chat requests should go while the brain is up, or null to use the configured endpoint. */
	function brainEndpoint() {
		const pod = brainPod();
		if (!pod?.ready_at) return null;
		return { podId: pod.id, baseUrl: `${proxyUrl(pod.id, BRAIN_PORT)}/v1`, apiKey: pod.secret, model: 'brain' };
	}

	/** Periodic check: stop pods that are past their deadline or idle, and notice ones that vanished. */
	async function tick() {
		const { idleMinutes, key } = cfg();
		if (!key) return;
		const now = clock();
		if (db.listPods().some((p) => !p.ended_at)) await refreshBalance();
		for (const pod of db.listPods().filter((p) => !p.ended_at)) {
			try {
				if (now >= pod.deadline_at) { await stop(pod.id, 'time limit reached', 'deleted itself at its time limit'); continue; }
				if (probes.has(pod.kind) && !pod.ready_at) {
					// Still installing or downloading: that is not idleness, but it is not allowed to last forever.
					await probes.get(pod.kind)(pod);
					const fresh = db.getPod(pod.id);
					if (!fresh.ready_at && !fresh.ended_at) {
						if (now - pod.created_at >= STARTUP_GRACE_MS) await stop(pod.id, 'never became ready');
						continue;
					}
					if (fresh.ended_at) continue;
				} else if (now - pod.last_used_at >= idleMinutes * 60000) { await stop(pod.id, 'idle'); continue; }
				const remote = await call('GET', `/pods/${encodeURIComponent(pod.id)}`);
				if (remote.status === 'TERMINATED') db.endPod(pod.id, now, 'ended on RunPod');
				else if (remote.status === 'ERROR') await stop(pod.id, 'pod reported an error');
				else if (remote.status === 'EXITED') await stop(pod.id, 'pod stopped; terminated to end disk charges');
			} catch (err) {
				if (err.code === 'not_found') db.endPod(pod.id, now, 'ended on RunPod');
				else console.error('[gpu]', pod.id, err.message);
			}
		}
	}

	/** Pods on the account that this controller did not start, or has already written off. */
	async function unknownPods() {
		const mine = new Set(db.listPods().filter((p) => !p.ended_at).map((p) => p.id));
		const found = [];
		let cursor = '';
		do {
			const page = await call('GET', `/pods?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
			for (const p of page.pods || []) {
				if (p.status !== 'TERMINATED' && !mine.has(p.id)) found.push({ id: p.id, name: p.name, status: p.status, rate: Number(p.cost) || 0, gpu: p.gpu?.id || '' });
			}
			cursor = page.pagination?.hasNextPage ? page.pagination.nextCursor : '';
		} while (cursor);
		return found;
	}

	/** Replace the estimate with what RunPod actually billed, once it is available. */
	async function reconcile() {
		const now = clock();
		const pending = db.listPods().filter((p) => p.ended_at && p.actual_cost == null && now - p.ended_at > 10 * 60000).slice(0, 3);
		for (const pod of pending) {
			try {
				const start = new Date(pod.created_at - HOUR_MS).toISOString();
				const end = new Date(pod.ended_at + 2 * HOUR_MS).toISOString();
				const bill = await call('GET', `/billing/pods?podId=${encodeURIComponent(pod.id)}&bucketSize=hour&startTime=${start}&endTime=${end}`);
				const total = bill?.metadata?.totals?.totalAmount;
				if (typeof total === 'number' && total > 0) db.setPodActualCost(pod.id, total);
			} catch { /* billing can lag; try again on a later refresh */ }
		}
	}

	const remote = { pending: null, unknown: [], error: null };

	async function status() {
		const c = cfg();
		const now = clock();
		const out = { configured: Boolean(c.key), limits: { maxPodMinutes: c.maxPodMinutes, idleMinutes: c.idleMinutes, clouds: c.clouds }, unknown: [], error: null };
		if (c.key) {
			// RunPod can take many seconds to answer from a phone. Ask in the background and wait
			// only briefly, then show the last known answer, so the page never hangs on it.
			if (!remote.pending) {
				remote.pending = (async () => {
					try { await refreshBalance(); await reconcile(); remote.unknown = await unknownPods(); remote.error = null; }
					catch (err) { remote.error = err.message; }
				})().finally(() => { remote.pending = null; });
			}
			await Promise.race([remote.pending, new Promise((r) => { const t = setTimeout(r, STATUS_WAIT_MS); t.unref?.(); })]);
			out.unknown = remote.unknown;
			out.error = remote.error;
		}
		if (c.key) await probeBrain();
		const view = ({ secret, ...p }) => ({ ...p, cost: ceilCents(p.actual_cost ?? accrued(p, now)), final: p.actual_cost != null });
		const pods = db.listPods();
		out.active = pods.filter((p) => !p.ended_at).map((p) => ({
			...view(p),
			secondsLeft: Math.max(0, Math.round((p.deadline_at - now) / 1000)),
			idleStopInSeconds: Math.max(0, Math.round((p.last_used_at + c.idleMinutes * 60000 - now) / 1000))
		}));
		out.history = pods.filter((p) => p.ended_at).slice(0, 20).map(view);
		out.budget = budget();
		const brain = pods.find((p) => !p.ended_at && p.kind === 'brain');
		out.brain = { state: !brain ? 'off' : brain.ready_at ? 'ready' : 'starting', model: db.getSettings().brainModel };
		return out;
	}

	return { quote, start, stop, touch, tick, status, budget, brainSpec, brainEndpoint, probeBrain, brainPod, proxyUrl, registerProbe, brainStage: () => brainStage,
		brainProgress: (p, model) => computeProgress('brain', p.created_at, brainTracker.get(p.id), clock(), brainPlan(model)), activePod: () => db.listPods().find((p) => !p.ended_at) || null };
}

/**
 * Models offered in the chat's model picker for the private brain. Each id is a GGUF
 * repository on Hugging Face (checked to exist, with a Q4_K_M file of the size shown).
 */
export const BRAIN_PRESETS = [
	{ id: 'unsloth/Qwen3.6-35B-A3B-GGUF:Q4_K_M', label: 'Qwen 3.6 35B', note: 'Strongest all-round for planning and tools', sizeGb: 22 },
	{ id: 'mradermacher/Huihui-Qwen3.6-35B-A3B-abliterated-GGUF:Q4_K_M', label: 'Qwen 3.6 35B', uncensored: true, note: 'Fewer refusals; may be less reliable with tools', sizeGb: 21 },
	{ id: 'unsloth/gemma-4-26B-A4B-it-GGUF:Q4_K_M', label: 'Gemma 4 26B', note: 'Lighter; leaves GPU memory free', sizeGb: 17 },
	{ id: 'unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF:Q4_K_M', label: 'Mistral Small 3.2', note: 'Smallest and quickest to wake', sizeGb: 14 }
];
export const brainLabel = (id) => BRAIN_PRESETS.find((p) => p.id === id)?.label || id.split('/').pop().replace(/-GGUF(:.*)?$/i, '');

/** True for a preset marked uncensored, or any other model whose name says so. */
export const isUncensored = (id) => BRAIN_PRESETS.find((p) => p.id === id)?.uncensored ?? /abliterat|uncensored|heretic|unfiltered/i.test(id);

/** VRAM each kind of pod needs. A test pod runs nothing, so any GPU will do. */
export const MIN_VRAM = { test: 0, brain: 24, comfy: 24, image: 24 };

/** A do-nothing pod used to prove the lifecycle end to end before real workloads exist. */
export const TEST_POD = { kind: 'test', name: 'assistant-test', image: 'runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404', cmd: 'sleep infinity', disk: 20 };
