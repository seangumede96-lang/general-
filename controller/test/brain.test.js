import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { startMockRunpod } from './mock-runpod.js';
import { startMockModel } from './mock-model.js';

// "pod" stands in for llama.cpp on the rented pod; "everyday" for the endpoint saved in Settings.
let app, base, rp, pod, everyday, root, now, n = 0;
const MIN = 60000;

const api = async (method, path, body) => {
	const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, body: await res.json() };
};
const startBrain = async (minutes = 30) => {
	const q = (await api('POST', '/api/system/quote', { minutes, kind: 'brain' })).body;
	return api('POST', '/api/system/pods', { minutes, confirmEstimate: q.estimate, kind: 'brain' });
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
	Object.assign(rp.state, { noCapacity: new Set(), pods: new Map(), created: [], deleted: [], seq: 0 });
	Object.assign(pod.state, { loading: false, requests: [], lastAuth: '' });
	everyday.state.requests = [];
	app = createApp({ dataDir: join(root, `d${++n}`), clock: () => now, watchdogMs: 0 });
	base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
	await api('PUT', '/api/settings', {
		baseUrl: everyday.baseUrl, model: 'everyday-model',
		runpodApiKey: rp.state.key, runpodBaseUrl: rp.baseUrl, runpodGraphqlUrl: rp.graphqlUrl,
		podCloud: 'COMMUNITY',
		podProxyTemplate: pod.baseUrl.replace(/\/v1$/, '')  // every pod's address resolves to the mock
	});
});

test('the brain pod runs llama.cpp with the chosen model, a self-delete timer and a private key', async () => {
	const r = await startBrain(30);
	assert.equal(r.status, 200);
	assert.equal(r.body.kind, 'brain');
	assert.ok(!('secret' in r.body), 'the key protecting the pod is not sent to the browser');

	const sent = rp.state.created[0];
	assert.equal(sent.image, 'ghcr.io/ggml-org/llama.cpp:server-cuda');
	assert.deepEqual(sent.ports, ['8080/http']);
	assert.match(sent.env.LLAMA_API_KEY, /^[0-9a-f]{48}$/);
	const { entrypoint, cmd } = JSON.parse(sent.args);
	assert.deepEqual(entrypoint, ['bash', '-c']);
	assert.match(cmd[0], /^\(sleep 1920; .*\) & \/app\/llama-server -hf unsloth\/Qwen3\.6-35B-A3B-GGUF:Q4_K_M --host 0\.0\.0\.0 --port 8080 -ngl all -c 16384 -a brain$/);
	assert.ok(!cmd[0].includes(sent.env.LLAMA_API_KEY), 'the key is not on the command line');
	assert.ok(!JSON.stringify((await api('GET', '/api/system')).body).includes(sent.env.LLAMA_API_KEY));
});

test('a model name that could inject shell commands is refused', async () => {
	await api('PUT', '/api/settings', { brainModel: 'a/b; rm -rf /' });
	const r = await startBrain(30);
	assert.equal(r.status, 409);
	assert.equal(rp.state.created.length, 0);
});

test('chat uses the everyday endpoint until the brain is ready, then switches to it', async () => {
	pod.state.loading = true;
	await startBrain(30);
	assert.equal((await api('GET', '/api/system')).body.brain.state, 'starting');
	assert.equal((await chat('hi')).at(-1).content, 'from the everyday endpoint');

	pod.state.loading = false;
	assert.equal((await api('GET', '/api/system')).body.brain.state, 'ready');
	assert.equal((await chat('hi')).at(-1).content, 'from the private brain');
	assert.equal(pod.state.requests.at(-1).model, 'brain');
	assert.equal(pod.state.lastAuth, `Bearer ${rp.state.created[0].env.LLAMA_API_KEY}`);
});

test('the model picker data shows what is in use, and choosing "everyday" overrides an awake brain', async () => {
	let b = (await api('GET', '/api/brains')).body;
	assert.equal(b.using, 'everyday');
	assert.equal(b.private.state, 'off');
	assert.ok(b.private.presets.length >= 3);
	assert.equal(b.everyday.model, 'everyday-model');

	await api('PUT', '/api/settings', { brainModel: b.private.presets[2].id });
	await startBrain(30);
	b = (await api('GET', '/api/brains')).body;
	assert.equal(b.using, 'private');
	assert.equal(b.private.label, 'Gemma 4 26B');
	assert.equal(b.private.podId, 'pod1');
	assert.match(rp.state.created[0].args, /-hf unsloth\/gemma-4-26B-A4B-it-GGUF:Q4_K_M /);

	// Selecting another preset while this one is awake does not change what is running.
	await api('PUT', '/api/settings', { brainModel: b.private.presets[0].id });
	b = (await api('GET', '/api/brains')).body;
	assert.equal(b.private.label, 'Gemma 4 26B');
	assert.equal(b.private.selected, b.private.presets[0].id);

	await api('PUT', '/api/settings', { chatBrain: 'everyday' });
	assert.equal((await api('GET', '/api/brains')).body.using, 'everyday');
	assert.equal((await chat('hi')).at(-1).content, 'from the everyday endpoint');
	await api('PUT', '/api/settings', { chatBrain: 'private' });
	assert.equal((await chat('hi')).at(-1).content, 'from the private brain');
});

test('chatting keeps the brain awake; silence lets it be shut down; chat then falls back', async () => {
	await startBrain(60);
	await api('GET', '/api/system');
	now += 8 * MIN;
	await chat('still there?');
	now += 8 * MIN;
	await app.gpu.tick();
	assert.deepEqual(rp.state.deleted, [], '16 min after start but only 8 since the last message');
	now += 3 * MIN;
	await app.gpu.tick();
	assert.deepEqual(rp.state.deleted, ['pod1']);
	assert.equal((await api('GET', '/api/system')).body.brain.state, 'off');
	assert.equal((await chat('hello')).at(-1).content, 'from the everyday endpoint');
});

test('a brain that is still downloading is not treated as idle, but is not left forever', async () => {
	pod.state.loading = true;
	await startBrain(60);
	now += 15 * MIN;
	await app.gpu.tick();
	assert.deepEqual(rp.state.deleted, []);
	now += 6 * MIN;
	await app.gpu.tick();
	assert.deepEqual(rp.state.deleted, ['pod1']);
	assert.equal((await api('GET', '/api/system')).body.history[0].end_reason, 'never became ready');
});
