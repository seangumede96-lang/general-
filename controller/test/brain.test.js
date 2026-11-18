import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { resolveHfFile } from '../src/brain.js';
import { startMockRunpod } from './mock-runpod.js';
import { startMockModel } from './mock-model.js';

// "pod" stands in for the brain machine (its status server and llama.cpp); "everyday" for the
// endpoint saved in Settings. Time is driven by hand; app.brain.step() advances a start.
let app, base, rp, pod, everyday, root, now, n = 0;
const MIN = 60000, SEC = 1000;
const FILE = { file: 'Model.Q4_K_M.gguf', url: 'https://huggingface.co/a/b/resolve/main/Model.Q4_K_M.gguf', bytes: 21e9 };

const api = async (method, path, body) => {
	const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, body: await res.json() };
};
const startBrain = async (minutes = 30, model) => {
	const q = (await api('POST', '/api/system/quote', { minutes, kind: 'brain' })).body;
	return api('POST', '/api/system/pods', { minutes, confirmEstimate: q.estimate, kind: 'brain', ...(model ? { model } : {}) });
};
async function chat(text) {
	const id = (await api('POST', '/api/conversations')).body.id;
	await api('POST', `/api/conversations/${id}/messages`, { text });
	for (let i = 0; i < 200; i++) {
		const c = (await api('GET', `/api/conversations/${id}`)).body;
		if (!c.working) return c.messages;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error('turn did not finish');
}
/** What the machine's status server says: stage, bytes, speed, and a heartbeat time. */
let machine;
const say = (stage, done = 0, speed = 0) => { machine = { stage, done, speed, t: Math.floor(now / 1000) }; };
const event = (text) => pod.state.events.push(`${Math.floor(now / 1000)} ${text}`);
const logText = async () => (await api('GET', '/api/brains')).body.private.log.map((l) => l.text).join('\n');

before(async () => {
	rp = await startMockRunpod();
	pod = await startMockModel({ chunks: ['from the private brain'] });
	everyday = await startMockModel({ chunks: ['from the everyday endpoint'] });
	root = mkdtempSync(join(tmpdir(), 'controller-brain-'));
});
after(async () => { await app?.close(); await rp.close(); await pod.close(); await everyday.close(); rmSync(root, { recursive: true, force: true }); });

beforeEach(async () => {
	await app?.close();
	now = Date.UTC(2026, 10, 12, 9, 0, 0);
	Object.assign(rp.state, { noCapacity: new Set(), dcFull: new Set(), pods: new Map(), volumes: new Map(), created: [], deleted: [], seq: 0 });
	machine = null;
	Object.assign(pod.state, { loading: false, requests: [], lastAuth: '', events: [], extended: '', status: () => (machine ? `${machine.stage} ${machine.done} 21000000000 ${machine.speed} ${machine.t}\n` : '') });
	everyday.state.requests = [];
	app = createApp({ dataDir: join(root, `d${++n}`), clock: () => now, watchdogMs: 0, brainOptions: { resolveFile: async () => FILE } });
	base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
	await api('PUT', '/api/settings', {
		baseUrl: everyday.baseUrl, model: 'everyday-model',
		runpodApiKey: rp.state.key, runpodBaseUrl: rp.baseUrl, runpodGraphqlUrl: rp.graphqlUrl,
		podCloud: 'COMMUNITY',
		podProxyTemplate: pod.baseUrl.replace(/\/v1$/, '')  // every pod's address resolves to the mock
	});
});

/** Start and walk the machine to ready: news, download, load. */
async function startReady(minutes = 30, model) {
	const r = await startBrain(minutes, model);
	say('ready', 21e9); await app.brain.step();
	return r;
}

test('the two Qwen rows are named "Qwen 3.6 35B" and "Qwen 3.6 35B Uncensored"', async () => {
	const presets = (await api('GET', '/api/brains')).body.private.presets;
	assert.deepEqual(presets.slice(0, 2).map((p) => p.label), ['Qwen 3.6 35B', 'Qwen 3.6 35B Uncensored']);
	assert.deepEqual(presets.map((p) => Boolean(p.uncensored)), [false, true, false, false]);
});

test('the first start makes the model storage where GPUs are free, and the machine is set up without any of your keys', async () => {
	const q = (await api('POST', '/api/system/quote', { minutes: 30, kind: 'brain' })).body;
	assert.equal(q.allowed, true);
	assert.equal(rp.state.volumes.size, 0, 'a price quote makes nothing');
	assert.deepEqual(q.options.map((o) => `${o.name} ${o.where}`).slice(0, 2), ['RTX 3090 EU-RO-1', 'RTX 4090 EU-RO-1'], 'the storage data centre first, cheapest first');
	assert.ok(q.options.some((o) => o.where === 'any data centre'), 'with fallbacks anywhere else');

	const r = await startBrain(30);
	assert.equal(r.status, 200);
	assert.equal(r.body.phase, 'starting');
	const [vol] = [...rp.state.volumes.values()];
	assert.deepEqual([vol.name, vol.size, vol.dataCenter], ['assistant-models', 25, 'EU-RO-1'], 'EU-RO-1 has the most suitable GPUs in stock');

	const sent = rp.state.created[0];
	assert.equal(sent.image, 'ghcr.io/seangumede96-lang/assistant-brain-engine:latest');
	assert.deepEqual(sent.dataCenterIds, ['EU-RO-1']);
	assert.deepEqual(sent.mounts, { network: [{ volumeId: vol.id, path: '/workspace' }] });
	assert.deepEqual(sent.ports, ['8080/http', '8081/http']);
	assert.equal(sent.cloud, 'SECURE');
	assert.equal(sent.env.STORE, 'volume');
	assert.equal(sent.env.MODEL_FILE, FILE.file);
	assert.equal(sent.env.POD_SECONDS, String(30 * 60 + 120), 'the machine deletes itself when its time is up');
	assert.match(Buffer.from(sent.env.BRAIN_SCRIPT, 'base64').toString(), /busybox httpd -p 8081/);
	assert.ok(!JSON.stringify(sent).includes(rp.state.key), 'the RunPod key never goes to the machine');
	assert.ok(!('secret' in r.body));
	const log = await logText();
	assert.match(log, /Made 25 GB model storage in EU-RO-1 \(\$1\.75\/month\)/);
	assert.match(log, /GPU found: RTX 3090 in EU-RO-1 at \$0\.43\/h \(next to your model storage\)/);

	// The next start reuses the same storage.
	await api('DELETE', '/api/brains/run');
	await startBrain(30);
	assert.equal(rp.state.volumes.size, 1);
	assert.deepEqual(rp.state.created[1].mounts, sent.mounts);
});

test('progress is real: stages and events from the machine, GB done and a time left from the measured speed', async () => {
	await startBrain(30);
	let p = (await api('GET', '/api/brains')).body.private;
	assert.equal(p.state, 'starting');
	assert.equal(p.progress.steps[p.progress.index], 'Starting the machine');
	assert.equal(p.progress.etaSeconds, null, 'no time left is shown until there is a real speed');

	now += 20 * SEC; say('downloading', 0, 0); event('Machine is up: NVIDIA GeForce RTX 3090, 24576 MiB'); event('Downloading 21.0 GB to your storage (only needed once)');
	await app.brain.step();
	now += 10 * SEC; say('downloading', 1e9, 1e8); await app.brain.step();
	now += 10 * SEC; say('downloading', 2e9, 1e8);
	p = (await api('GET', '/api/brains')).body.private;
	assert.equal(p.progress.steps[p.progress.index], 'Downloading the model');
	assert.equal(p.progress.files[0].done, 2e9);
	assert.equal(p.progress.files[0].total, 21e9);
	assert.equal(Math.round(p.progress.files[0].speed), 1e8, '1 GB per 10 s, measured');
	assert.equal(p.progress.etaSeconds, 190, '19 GB left at 100 MB/s');
	assert.match(p.log.map((l) => l.text).join('\n'), /First news from the machine, 20 s after it was created[\s\S]*Machine is up: NVIDIA GeForce RTX 3090/);
	const up = p.log.find((l) => l.text.startsWith('Machine is up'));
	assert.equal(up.at, now - 20 * SEC, "the machine's own time is kept");

	now += 3 * MIN; say('loading', 21e9); pod.state.loading = true; await app.brain.step();
	p = (await api('GET', '/api/brains')).body.private;
	assert.equal(p.progress.steps[p.progress.index], 'Loading the model into the GPU');
	assert.equal((await chat('hi')).at(-1).content, 'from the everyday endpoint', 'chat waits for the brain');

	now += 40 * SEC; say('ready', 21e9); pod.state.loading = false; await app.brain.step();
	p = (await api('GET', '/api/brains')).body.private;
	assert.equal(p.state, 'ready');
	assert.match(p.log.at(-1).text, /^Ready: Qwen 3\.6 35B on RTX 3090, 260 s after you turned it on/);
	assert.equal((await chat('hi')).at(-1).content, 'from the private brain');
	assert.equal(pod.state.lastAuth, `Bearer ${rp.state.created[0].env.LLAMA_API_KEY}`);
});

test('a machine that sends no news for 90 s is deleted and the next GPU is tried, all in the log', async () => {
	await startBrain(30);
	now += 89 * SEC; await app.brain.step();
	assert.deepEqual(rp.state.deleted, []);
	now += 2 * SEC; await app.brain.step();
	assert.deepEqual(rp.state.deleted, ['pod1']);
	await app.brain.step();
	assert.equal(rp.state.created[1].gpu.id, 'NVIDIA GeForce RTX 4090', 'the next GPU type in the storage data centre');
	const log = await logText();
	assert.match(log, /No news from the machine for 91 s\. Deleting this machine \(RTX 3090\) and trying the next GPU/);
	assert.match(log, /GPU found: RTX 4090 in EU-RO-1/);

	// News, then silence again: also caught.
	say('downloading', 1e9, 5e7); await app.brain.step();
	now += 95 * SEC; await app.brain.step();
	assert.deepEqual(rp.state.deleted, ['pod1', 'pod2']);
});

test('a stalled download, or a machine that reports a failure, is deleted too', async () => {
	await startBrain(30);
	say('downloading', 5e9, 1e8); await app.brain.step();
	for (let i = 0; i < 10; i++) { now += 10 * SEC; say('downloading', 5e9, 0); await app.brain.step(); }
	assert.deepEqual(rp.state.deleted, ['pod1']);
	assert.match(await logText(), /The download made no progress for 90 s/);

	await app.brain.step();
	say('failed', 0); event('FAILED: the model did not load: out of memory'); await app.brain.step();
	assert.deepEqual(rp.state.deleted, ['pod1', 'pod2']);
	assert.match(await logText(), /FAILED: the model did not load: out of memory[\s\S]*The machine reported a failure\. Deleting this machine/);
});

test('when the storage data centre has no GPU free, a GPU elsewhere is used and downloads the model itself', async () => {
	rp.state.dcFull.add('EU-RO-1');
	const r = await startBrain(30);
	assert.equal(r.status, 200);
	const sent = rp.state.created.at(-1);
	assert.equal(sent.mounts, undefined);
	assert.equal(sent.dataCenterIds, undefined);
	assert.equal(sent.env.STORE, 'disk');
	assert.equal(sent.disk, 40);
	const log = await logText();
	assert.match(log, /RTX 3090 in EU-RO-1: none free\nRTX 4090 in EU-RO-1: none free\nGPU found: RTX 3090 in US-TX-3 at \$0\.22\/h \(model will be downloaded to it\)/);
});

test('with no GPU free anywhere it keeps trying, and a cancel leaves nothing running', async () => {
	rp.state.noCapacity = new Set(rp.state.gpus.map((g) => g.id));
	await startBrain(30);
	assert.equal(rp.state.pods.size, 0);
	let p = (await api('GET', '/api/brains')).body.private;
	assert.equal(p.state, 'starting');
	assert.equal(p.progress.steps[p.progress.index], 'Waiting for a GPU');
	const tries = rp.state.created.length;
	now += 5 * SEC; await app.brain.step();
	assert.equal(rp.state.created.length, tries, 'waits between rounds');
	now += 20 * SEC; await app.brain.step();
	assert.ok(rp.state.created.length > tries, 'tries again');
	assert.match(await logText(), /No GPU free right now; trying again in 20 s/);
	await api('DELETE', '/api/brains/run');
	p = (await api('GET', '/api/brains')).body.private;
	assert.equal(p.state, 'off');
	assert.match(p.log.at(-1).text, /Cancelled before any machine started: nothing was charged/);
});

test('when every GPU choice has failed it gives up, with nothing left running', async () => {
	await startBrain(30);
	for (let i = 0; i < 8; i++) { now += 91 * SEC; await app.brain.step(); await app.brain.step(); }
	const p = (await api('GET', '/api/brains')).body.private;
	assert.equal(p.state, 'off');
	assert.equal(p.phase, 'failed');
	assert.equal(rp.state.created.length, 4, 'two types next to the storage, two anywhere else');
	assert.equal([...rp.state.pods.values()].filter((x) => x.status !== 'TERMINATED').length, 0);
	assert.match(p.error, /every suitable GPU choice \(4\) was tried and failed to start\. Nothing is left running/);
});

test('session timer: the sooner of idle and the time limit; extending moves both, on the app and on the machine', async () => {
	await startReady(30);
	let s = (await api('GET', '/api/brains')).body.private.session;
	assert.equal(s.label, 'Qwen 3.6 35B');
	assert.equal(s.rate, 0.43);
	assert.equal(s.reason, 'idle');
	assert.equal(s.secondsLeft, 10 * 60, 'idle rule: 10 minutes without a message');
	now += 4 * MIN; await chat('hi');
	now += 3 * MIN;
	s = (await api('GET', '/api/brains')).body.private.session;
	assert.equal(s.secondsLeft, 7 * 60);
	now += 15 * MIN; await chat('hi');
	s = (await api('GET', '/api/brains')).body.private.session;
	assert.equal(s.reason, 'limit');
	assert.equal(s.secondsLeft, 8 * 60, '30 min limit, 22 min in');

	const r = await api('POST', '/api/brains/extend', { minutes: 30 });
	assert.equal(r.status, 200);
	assert.equal(r.body.secondsLeft, 38 * 60, '8 min left plus 30');
	const [key, until] = pod.state.extended.split(' ');
	assert.equal(key, rp.state.created[0].env.STATUS_KEY);
	assert.equal(Number(until), Math.floor((now + 38 * MIN) / 1000) + 120, "the machine's own timer moves too");

	// An extension also outlasts the idle rule, and a message does not shorten it.
	now += 1 * MIN; await chat('hi');
	assert.equal((await api('GET', '/api/brains')).body.private.session.secondsLeft, 37 * 60);
	now += 20 * MIN; await app.gpu.tick();
	assert.deepEqual(rp.state.deleted, [], 'no message for 20 min, but the session was extended');
	assert.match(await logText(), /Session extended by 30 min \(up to \$0\.22 more\)/);
	assert.equal((await api('POST', '/api/brains/extend', { minutes: 1 })).status, 409);
});

test('a brain starts with the model named in the request; the running one stays until turned off', async () => {
	const presets = (await api('GET', '/api/brains')).body.private.presets;
	await api('PUT', '/api/settings', { brainModel: presets[1].id });
	await startBrain(30, presets[3].id);
	await api('PUT', '/api/settings', { brainModel: presets[0].id });
	const b = (await api('GET', '/api/brains')).body;
	assert.equal(b.private.label, 'Mistral Small 3.2');
	assert.equal(b.private.model, presets[3].id);
	assert.equal(b.private.selected, presets[0].id);
});

test('choosing "everyday" overrides an awake brain', async () => {
	await startReady(30);
	assert.equal((await api('GET', '/api/brains')).body.using, 'private');
	await api('PUT', '/api/settings', { chatBrain: 'everyday' });
	assert.equal((await chat('hi')).at(-1).content, 'from the everyday endpoint');
	await api('PUT', '/api/settings', { chatBrain: 'private' });
	assert.equal((await chat('hi')).at(-1).content, 'from the private brain');
});

test('uncensored models are flagged, including ones typed in by hand; a name that could inject commands is refused', async () => {
	await api('PUT', '/api/settings', { brainModel: 'someone/Some-Model-abliterated-GGUF:Q4_K_M' });
	assert.equal((await api('GET', '/api/brains')).body.private.uncensored, true);
	const presets = (await api('GET', '/api/brains')).body.private.presets;
	const r = await startBrain(30, presets[1].id);
	assert.equal(r.body.label, 'Qwen 3.6 35B Uncensored');
	assert.equal(rp.state.pods.get('pod1') && (await api('GET', '/api/system')).body.active[0].purpose, 'Private brain · Qwen 3.6 35B Uncensored');
	await api('DELETE', '/api/brains/run');
	await api('PUT', '/api/settings', { brainModel: 'a/b; rm -rf /' });
	assert.equal((await startBrain(30)).status, 409);
});

test('chatting keeps the brain awake; silence lets it be shut down; chat then falls back', async () => {
	await startReady(60);
	now += 8 * MIN;
	await chat('still there?');
	now += 8 * MIN;
	await app.gpu.tick();
	assert.deepEqual(rp.state.deleted, [], '16 min after start but only 8 since the last message');
	now += 3 * MIN;
	await app.gpu.tick();
	assert.deepEqual(rp.state.deleted, ['pod1']);
	assert.equal((await api('GET', '/api/brains')).body.private.state, 'off');
	assert.equal((await chat('hello')).at(-1).content, 'from the everyday endpoint');
});

test('the model file is looked up on Hugging Face: the chosen quant, never the vision add-on', async () => {
	const fake = async (url) => ({ ok: true, json: async () => [
		{ path: 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf', size: 22134528992, lfs: { size: 22134528992 } },
		{ path: 'mmproj-F16.gguf', size: 899283680 },
		{ path: 'Qwen3.6-35B-A3B-Q8_0.gguf', size: 37e9 }
	], url });
	const f = await resolveHfFile('unsloth/Qwen3.6-35B-A3B-GGUF:Q4_K_M', { fetchImpl: fake });
	assert.deepEqual(f, { file: 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf', url: 'https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf', bytes: 22134528992 });
});
