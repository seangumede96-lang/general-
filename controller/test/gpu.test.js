import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { withDeadman } from '../src/gpu.js';
import { startMockRunpod } from './mock-runpod.js';

let app, base, rp, root, now, n = 0;
const MIN = 60000;

const api = async (method, path, body) => {
	const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, body: await res.json() };
};
// These tests pin Community Cloud so the expected prices are easy to follow; the cross-cloud
// choice has its own tests below.
const startPod = async (minutes) => {
	const q = (await api('POST', '/api/system/quote', { minutes })).body;
	return api('POST', '/api/system/pods', { minutes, confirmEstimate: q.estimate });
};

before(async () => { rp = await startMockRunpod(); root = mkdtempSync(join(tmpdir(), 'controller-gpu-')); });
after(async () => { await app?.close(); await rp.close(); rmSync(root, { recursive: true, force: true }); });

// A fresh database and a clean fake RunPod account for every test; time is driven by hand.
beforeEach(async () => {
	await app?.close();
	now = Date.UTC(2026, 10, 12, 9, 0, 0);
	Object.assign(rp.state, { noCapacity: new Set(), insufficientBalance: false, pods: new Map(), billing: new Map(), created: [], deleted: [], seq: 0, balance: 61.38 });
	app = createApp({ dataDir: join(root, `d${++n}`), clock: () => now, watchdogMs: 0 });
	base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
	await api('PUT', '/api/settings', { runpodApiKey: rp.state.key, runpodBaseUrl: rp.baseUrl, runpodGraphqlUrl: rp.graphqlUrl, budgetTotal: '50', maxPodMinutes: '60', idleMinutes: '10', podCloud: 'COMMUNITY' });
});

test('without a key nothing is attempted and the page says so', async () => {
	await api('PUT', '/api/settings', { clearRunpodApiKey: true });
	const s = (await api('GET', '/api/system')).body;
	assert.equal(s.configured, false);
	assert.equal((await api('POST', '/api/system/quote', { minutes: 10 })).status, 400);
});

test('the RunPod key is never returned', async () => {
	const s = (await api('GET', '/api/settings')).body;
	assert.equal(s.hasRunpodApiKey, true);
	assert.ok(!JSON.stringify(s).includes(rp.state.key));
});

test('a test pod takes the cheapest GPU of any size; the estimate covers the dearest fallback', async () => {
	const q = (await api('POST', '/api/system/quote', { minutes: 30 })).body;
	assert.deepEqual(q.options.map((o) => o.name), ['RTX A4000', 'RTX 3090', 'RTX 4090'], 'the card with no stock is excluded');
	assert.equal(q.estimate, 0.17, '30 min at $0.34/h');
	assert.equal(q.allowed, true);
});

test('a brain pod only considers GPUs with 24 GB or more', async () => {
	const q = (await api('POST', '/api/system/quote', { minutes: 30, kind: 'brain' })).body;
	assert.deepEqual(q.options.map((o) => o.name), ['RTX 3090', 'RTX 4090']);
});

test('with both clouds allowed, the cheapest wins wherever it is', async () => {
	await api('PUT', '/api/settings', { podCloud: 'ANY' });
	rp.state.gpus.find((g) => g.name === 'RTX A4000').price.secure = 0.12;
	try {
		const q = (await api('POST', '/api/system/quote', { minutes: 30 })).body;
		assert.deepEqual(q.options.map((o) => [o.name, o.cloud]), [['RTX A4000', 'SECURE'], ['RTX A4000', 'COMMUNITY'], ['RTX 3090', 'COMMUNITY']]);
		const r = await api('POST', '/api/system/pods', { minutes: 30, confirmEstimate: q.estimate });
		assert.equal(r.status, 200);
		assert.equal(rp.state.created[0].cloud, 'SECURE');
		assert.equal(r.body.rate, 0.12);
	} finally { rp.state.gpus.find((g) => g.name === 'RTX A4000').price.secure = 0.25; }
});

test('a much dearer card is never offered as a fallback', async () => {
	const saved = rp.state.gpus;
	rp.state.gpus = [
		{ id: 'small', name: 'RTX 2000 Ada', memory: 16, secure: true, community: true, price: { secure: 0.24, community: 0.2 }, availability: 'LOW' },
		{ id: 'big', name: 'RTX PRO 5000', memory: 48, secure: true, community: true, price: { secure: 0.9, community: 0.82 }, availability: 'LOW' },
		{ id: 'huge', name: 'H200 SXM', memory: 141, secure: true, community: true, price: { secure: 3.99, community: 3.59 }, availability: 'LOW' }
	];
	try {
		const q = (await api('POST', '/api/system/quote', { minutes: 5 })).body;
		assert.deepEqual(q.options.map((o) => o.name), ['RTX 2000 Ada']);
		assert.equal(q.estimate, 0.02);
	} finally { rp.state.gpus = saved; }
});

test('starting needs the quoted price echoed back', async () => {
	const r = await api('POST', '/api/system/pods', { minutes: 30, confirmEstimate: 0.01 });
	assert.equal(r.status, 409);
	assert.equal(rp.state.created.length, 0);
});

test('a started pod is on the cheapest GPU, in Community Cloud, with its own self-delete timer', async () => {
	const r = await startPod(30);
	assert.equal(r.status, 200);
	const sent = rp.state.created[0];
	assert.equal(sent.gpu.id, 'NVIDIA RTX A4000');
	assert.equal(sent.cloud, 'COMMUNITY');
	const args = JSON.parse(sent.args);
	assert.deepEqual(args.entrypoint, ['bash', '-c']);
	assert.match(args.cmd[0], /^\(sleep 1920; curl -s -X DELETE https:\/\/api\.runpod\.io\/v2\/pods\/\$RUNPOD_POD_ID .*\) & sleep infinity$/);
	const s = (await api('GET', '/api/system')).body;
	assert.equal(s.active.length, 1);
	assert.equal(s.active[0].rate, 0.17);
	assert.equal(s.active[0].secondsLeft, 1800);
	assert.deepEqual(s.unknown, []);
});

test('falls back to the next GPU when the first has no capacity', async () => {
	rp.state.noCapacity.add('NVIDIA RTX A4000');
	const r = await startPod(30);
	assert.equal(r.status, 200);
	assert.equal(r.body.gpu, 'RTX 3090');
	assert.equal(r.body.rate, 0.22);
});

test('only one pod at a time', async () => {
	await startPod(10);
	const q = (await api('POST', '/api/system/quote', { minutes: 10 })).body;
	assert.equal(q.allowed, false);
	assert.match(q.reason, /already running/);
});

test('refuses a pod longer than the per-pod limit', async () => {
	const q = (await api('POST', '/api/system/quote', { minutes: 61 })).body;
	assert.equal(q.allowed, false);
	assert.match(q.reason, /60-minute limit/);
});

test('refuses a pod whose worst case exceeds the remaining budget', async () => {
	await api('PUT', '/api/settings', { budgetTotal: '0.10' });
	const q = (await api('POST', '/api/system/quote', { minutes: 30 })).body;
	assert.equal(q.allowed, false);
	assert.match(q.reason, /only \$0\.10 is left/);
	assert.equal((await api('POST', '/api/system/pods', { minutes: 30, confirmEstimate: q.estimate })).status, 409);
	assert.equal(rp.state.created.length, 0);
});

test('cost accrues with time and counts against the budget', async () => {
	await startPod(60);
	now += 30 * MIN;
	app.gpu.touch('pod1');
	const s = (await api('GET', '/api/system')).body;
	assert.equal(s.active[0].cost, 0.09, '30 min at $0.17/h, rounded up');
	assert.equal(s.budget.spent, 0.09);
	assert.ok(Math.abs(s.budget.remaining - 49.91) < 1e-9);
});

test('the watchdog deletes an idle pod', async () => {
	await startPod(60);
	now += 9 * MIN;
	await app.gpu.tick();
	assert.deepEqual(rp.state.deleted, []);
	now += 1 * MIN;
	await app.gpu.tick();
	assert.deepEqual(rp.state.deleted, ['pod1']);
	const s = (await api('GET', '/api/system')).body;
	assert.equal(s.active.length, 0);
	assert.equal(s.history[0].end_reason, 'idle');
});

test('the watchdog deletes a busy pod at its deadline', async () => {
	await startPod(20);
	for (let i = 0; i < 4; i++) { now += 5 * MIN; app.gpu.touch('pod1'); if (i < 3) await app.gpu.tick(); }
	assert.deepEqual(rp.state.deleted, []);
	await app.gpu.tick();
	assert.deepEqual(rp.state.deleted, ['pod1']);
	assert.equal((await api('GET', '/api/system')).body.history[0].end_reason, 'time limit reached');
});

test('a pod found already gone at its deadline is recorded as having deleted itself', async () => {
	// What the first real test showed: the app was off, the pod's own timer removed it.
	await startPod(5);
	rp.state.pods.get('pod1').status = 'TERMINATED';
	now += 8 * MIN;
	await app.gpu.tick();
	assert.equal((await api('GET', '/api/system')).body.history[0].end_reason, 'deleted itself at its time limit');
});

test('a pod that vanished on RunPod is closed in the ledger', async () => {
	await startPod(30);
	rp.state.pods.get('pod1').status = 'TERMINATED';
	now += MIN;
	await app.gpu.tick();
	const s = (await api('GET', '/api/system')).body;
	assert.equal(s.active.length, 0);
	assert.equal(s.history[0].end_reason, 'ended on RunPod');
});

test('a pod that merely stopped is deleted so its disk stops billing', async () => {
	await startPod(30);
	rp.state.pods.get('pod1').status = 'EXITED';
	now += MIN;
	await app.gpu.tick();
	assert.deepEqual(rp.state.deleted, ['pod1']);
});

test('manual stop deletes the pod; the ledger survives a restart', async () => {
	await startPod(30);
	now += 6 * MIN;
	assert.equal((await api('DELETE', '/api/system/pods/pod1')).status, 200);
	assert.deepEqual(rp.state.deleted, ['pod1']);
	await app.close();
	app = createApp({ dataDir: join(root, `d${n}`), clock: () => now, watchdogMs: 0 });
	base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
	const s = (await api('GET', '/api/system')).body;
	assert.equal(s.history[0].cost, 0.02, '6 min at $0.17/h, rounded up');
	assert.equal(s.budget.spent, 0.02);
});

test('the actual bill replaces the estimate once RunPod reports it', async () => {
	await startPod(30);
	now += 6 * MIN;
	await api('DELETE', '/api/system/pods/pod1');
	rp.state.billing.set('pod1', 0.05);
	now += 11 * MIN;
	const s = (await api('GET', '/api/system')).body;
	assert.equal(s.history[0].cost, 0.05);
	assert.equal(s.history[0].final, true);
	assert.equal(s.budget.spent, 0.05);
});

test('pods the controller did not start are reported, not touched', async () => {
	rp.state.pods.set('stray', { id: 'stray', name: 'left-running', status: 'RUNNING', cost: 0.69, gpu: { id: 'NVIDIA GeForce RTX 4090' } });
	const s = (await api('GET', '/api/system')).body;
	assert.deepEqual(s.unknown.map((p) => p.id), ['stray']);
	assert.deepEqual(rp.state.deleted, []);
});

test('with no cap, the budget is the real RunPod balance', async () => {
	await api('PUT', '/api/settings', { budgetTotal: '' });
	const s = (await api('GET', '/api/system')).body;
	assert.equal(s.budget.remaining, 61.38);
	assert.equal(s.budget.balance, 61.38);
	assert.equal(s.budget.cap, null);
	const q = (await api('POST', '/api/system/quote', { minutes: 30 })).body;
	assert.match(q.summary, /RTX A4000 at \$0\.17\/h, or the next cheapest up to \$0\.34\/h, for up to 30 min: at most \$0\.17\. \$61\.38 is left\./);
});

test('a balance lower than the cap wins, and an empty balance refuses pods', async () => {
	rp.state.balance = 0.05;
	const q = (await api('POST', '/api/system/quote', { minutes: 30 })).body;
	assert.equal(q.remaining, 0.05);
	assert.equal(q.allowed, false);
	assert.match(q.reason, /only \$0\.05 is left/);
});

test('the cap still limits spending when the balance is larger', async () => {
	await api('PUT', '/api/settings', { budgetTotal: '0.10' });
	const s = (await api('GET', '/api/system')).body;
	assert.equal(s.budget.remaining, 0.1);
	assert.equal(s.budget.balance, 61.38);
});

test('if the balance cannot be read: the cap is used if set, otherwise pods are refused', async () => {
	rp.state.balance = null;
	assert.equal((await api('POST', '/api/system/quote', { minutes: 5 })).body.allowed, true, 'cap of $50 still applies');
	await api('PUT', '/api/settings', { budgetTotal: '' });
	const q = (await api('POST', '/api/system/quote', { minutes: 5 })).body;
	assert.equal(q.allowed, false);
	assert.match(q.reason, /Could not read your RunPod balance/);
	assert.equal(rp.state.created.length, 0);
});

test('RunPod errors are passed on in plain words', async () => {
	rp.state.insufficientBalance = true;
	const r = await startPod(10);
	assert.equal(r.status, 502);
	assert.match(r.body.error, /balance is too low/);
	await api('PUT', '/api/settings', { runpodApiKey: 'wrong' });
	assert.match((await api('POST', '/api/system/quote', { minutes: 10 })).body.error, /rejected the API key/);
});

test('deadman wrapper replaces the entrypoint and keeps the original command intact', () => {
	const args = JSON.parse(withDeadman("python -c 'print(1)'", 600));
	assert.deepEqual(args.entrypoint, ['bash', '-c']);
	assert.equal(args.cmd.length, 1);
	assert.match(args.cmd[0], /^\(sleep 600; curl .*runpodctl pod delete \$RUNPOD_POD_ID\) & python -c 'print\(1\)'$/);
});
