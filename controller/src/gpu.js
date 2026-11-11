// RunPod pod lifecycle with a spend ledger. Rules enforced here, in code:
//   - one pod at a time, and only if its worst-case cost fits the remaining budget
//   - every pod has a fixed maximum lifetime, decided before it starts
//   - pods are terminated (never just stopped) when idle, when their time is up, or on request
//   - the pod also carries its own timer and deletes itself if the controller disappears
// Built against RunPod REST API v2 (https://api.runpod.io/v2); v1 retires 15 Nov 2026.

const REAL_API = 'https://api.runpod.io/v2';
const DEADMAN_GRACE_S = 120;
const HOUR_MS = 3600 * 1000;

export class GpuError extends Error {
	constructor(message, code = 'failed') { super(message); this.code = code; }
}

const usd = (n) => `$${n.toFixed(2)}`;
/** Round a cost up to the next cent so estimates never understate. */
const ceilCents = (n) => Math.ceil(n * 100 - 1e-9) / 100;

/**
 * Wrap a container start command so the pod deletes itself after `seconds`, using the
 * pod-scoped key RunPod injects. This is the backstop for a dead or offline controller.
 */
export function withDeadman(cmd, seconds) {
	const kill = `curl -s -X DELETE ${REAL_API}/pods/$RUNPOD_POD_ID -H "Authorization: Bearer $RUNPOD_API_KEY"; runpodctl pod delete $RUNPOD_POD_ID`;
	return `bash -c '(sleep ${Math.round(seconds)}; ${kill}) & ${cmd.replace(/'/g, `'\\''`)}'`;
}

export function createGpuManager({ db, clock = Date.now }) {
	const cfg = () => {
		const s = db.getSettings();
		return {
			key: s.runpodApiKey,
			base: (s.runpodBaseUrl || REAL_API).replace(/\/+$/, ''),
			cloud: s.podCloud === 'SECURE' ? 'SECURE' : 'COMMUNITY',
			budgetTotal: Math.max(0, Number.parseFloat(s.budgetTotal) || 0),
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

	function budget() {
		const total = cfg().budgetTotal;
		// Rounded up once, so "spent" and "remaining" always add up to the total on screen.
		const spent = ceilCents(db.listPods().reduce((sum, p) => sum + (p.actual_cost ?? accrued(p)), 0));
		return { total, spent, remaining: Math.max(0, total - spent) };
	}

	/** Cheapest GPU types that meet the VRAM floor and currently have capacity. */
	async function candidates(minVram) {
		const { cloud } = cfg();
		const side = cloud.toLowerCase();
		const { gpus = [] } = await call('GET', `/catalog/gpus?include=AVAILABILITY&product=POD&cloud=${cloud}`);
		return gpus
			.filter((g) => g[side] && g.memory >= minVram && g.availability !== 'NONE' && g.price?.[side] > 0)
			.map((g) => ({ id: g.id, name: g.name || g.id, memory: g.memory, rate: g.price[side], availability: g.availability }))
			.sort((a, b) => a.rate - b.rate)
			.slice(0, 3);
	}

	async function quote({ minutes, minVram = 24 }) {
		const c = cfg();
		minutes = Number(minutes);
		if (!Number.isFinite(minutes) || minutes < 1) throw new GpuError('Minutes must be at least 1.', 'invalid');
		const options = await candidates(minVram);
		const { remaining } = budget();
		if (!options.length) return { allowed: false, reason: `No GPU with ${minVram} GB or more is available right now.`, options, remaining };
		// Any of the options may be the one that has capacity, so budget for the dearest.
		const worstRate = Math.max(...options.map((o) => o.rate));
		const estimate = ceilCents(worstRate * minutes / 60);
		let reason = null;
		if (minutes > c.maxPodMinutes) reason = `${minutes} minutes is over the ${c.maxPodMinutes}-minute limit per pod.`;
		else if (db.listPods().some((p) => !p.ended_at)) reason = 'A pod is already running. Stop it first.';
		else if (estimate > remaining) reason = `This could cost up to ${usd(estimate)} but only ${usd(remaining)} of the budget is left.`;
		return {
			allowed: !reason, reason, options, minutes, estimate, remaining,
			summary: `${options[0].name} from ${usd(options[0].rate)}/h for up to ${minutes} min: at most ${usd(estimate)}. ${usd(remaining)} of the budget is left.`
		};
	}

	/**
	 * Start a pod. `spec` is { name, image, cmd, ports, env, disk }. The pod's lifetime is
	 * fixed at `minutes`; the worst case is checked against the budget before anything starts.
	 */
	async function start({ minutes, purpose = '', minVram = 24, spec }) {
		const q = await quote({ minutes, minVram });
		if (!q.allowed) throw new GpuError(q.reason, 'refused');
		const { cloud } = cfg();
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
					cloud,
					gpu: { id: gpu.id, count: 1 }
				});
			} catch (err) {
				lastError = err;
				if (err.code === 'unavailable') continue; // no capacity for this type: try the next
				throw err;
			}
			const now = clock();
			// Trust the rate RunPod reports for the pod it actually placed.
			const rate = Number(pod.cost) > 0 ? Number(pod.cost) : gpu.rate;
			db.insertPod({ id: pod.id, name: spec.name, gpu: gpu.name, rate, purpose, created_at: now, last_used_at: now, deadline_at: now + minutes * 60000 });
			return db.getPod(pod.id);
		}
		throw new GpuError(`None of the available GPUs could be started. ${lastError?.message || ''}`.trim(), 'unavailable');
	}

	async function stop(id, reason) {
		const pod = db.getPod(id);
		try { await call('DELETE', `/pods/${encodeURIComponent(id)}`); }
		catch (err) { if (err.code !== 'not_found') throw err; }
		if (pod && !pod.ended_at) db.endPod(id, clock(), reason);
		return db.getPod(id);
	}

	const touch = (id) => db.touchPod(id, clock());

	/** Periodic check: stop pods that are past their deadline or idle, and notice ones that vanished. */
	async function tick() {
		const { idleMinutes, key } = cfg();
		if (!key) return;
		const now = clock();
		for (const pod of db.listPods().filter((p) => !p.ended_at)) {
			try {
				if (now >= pod.deadline_at) { await stop(pod.id, 'time limit reached'); continue; }
				if (now - pod.last_used_at >= idleMinutes * 60000) { await stop(pod.id, 'idle'); continue; }
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

	async function status() {
		const c = cfg();
		const now = clock();
		const out = { configured: Boolean(c.key), limits: { maxPodMinutes: c.maxPodMinutes, idleMinutes: c.idleMinutes, cloud: c.cloud }, unknown: [], error: null };
		if (c.key) {
			try { await reconcile(); out.unknown = await unknownPods(); }
			catch (err) { out.error = err.message; }
		}
		const view = (p) => ({ ...p, cost: ceilCents(p.actual_cost ?? accrued(p, now)), final: p.actual_cost != null });
		const pods = db.listPods();
		out.active = pods.filter((p) => !p.ended_at).map((p) => ({
			...view(p),
			secondsLeft: Math.max(0, Math.round((p.deadline_at - now) / 1000)),
			idleStopInSeconds: Math.max(0, Math.round((p.last_used_at + c.idleMinutes * 60000 - now) / 1000))
		}));
		out.history = pods.filter((p) => p.ended_at).slice(0, 20).map(view);
		out.budget = budget();
		return out;
	}

	return { quote, start, stop, touch, tick, status, budget, activePod: () => db.listPods().find((p) => !p.ended_at) || null };
}

/** A do-nothing pod used to prove the lifecycle end to end before real workloads exist. */
export const TEST_POD = { name: 'assistant-test', image: 'runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404', cmd: 'sleep infinity', disk: 20 };
