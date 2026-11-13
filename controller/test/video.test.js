import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { buildWorkflow, outputSize, minutesFor, comfyPodSpec } from '../src/video-recipe.js';
import { startMockRunpod } from './mock-runpod.js';
import { startMockComfy, TEMPLATE } from './mock-comfy.js';

let app, base, rp, comfy, root, n = 0;

const api = async (method, path, body) => {
	const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, body: await res.json() };
};
const upload = async (name, type, bytes = 'DATA') => (await (await fetch(`${base}/api/uploads?name=${name}`, { method: 'POST', headers: { 'Content-Type': type }, body: bytes })).json()).id;
const newRequest = async (extra = {}) => ({ kind: 'replace', input: await upload('clip.mp4', 'video/mp4'), reference: await upload('face.jpg', 'image/jpeg'), seconds: 5, width: 720, height: 1280, prompt: '', ...extra });
async function startJob(request, extra = {}) {
	const q = (await api('POST', '/api/video/quote', request)).body;
	return api('POST', '/api/video/jobs', { ...request, rightsConfirmed: true, confirmEstimate: q.estimate, ...extra });
}
async function finished(id) {
	for (let i = 0; i < 400; i++) {
		const job = (await api('GET', '/api/video')).body.jobs.find((j) => j.id === id);
		if (!job.active) return job;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error('job did not finish');
}
const podGone = async () => { for (let i = 0; i < 100 && !rp.state.deleted.length; i++) await new Promise((r) => setTimeout(r, 10)); return rp.state.deleted; };

before(async () => { rp = await startMockRunpod(); comfy = await startMockComfy(); root = mkdtempSync(join(tmpdir(), 'controller-video-')); });
after(async () => { await app?.close(); await rp.close(); await comfy.close(); rmSync(root, { recursive: true, force: true }); });
beforeEach(async () => {
	await app?.close();
	Object.assign(rp.state, { noCapacity: new Set(), pods: new Map(), created: [], deleted: [], seq: 0, balance: 61.38 });
	Object.assign(comfy.state, { ready: true, pollsUntilDone: 2, outcome: 'ok', template: TEMPLATE, uploads: [], prompts: [], historyChecks: 0, setupLog: 'STEP 3/4 Downloading models\n' });
	app = createApp({ dataDir: join(root, `d${++n}`), watchdogMs: 0, videoPollMs: 5 });
	base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
	await api('PUT', '/api/settings', { maxPodMinutes: '90', runpodApiKey: rp.state.key, runpodBaseUrl: rp.baseUrl, runpodGraphqlUrl: rp.graphqlUrl, podCloud: 'COMMUNITY', podProxyTemplate: comfy.baseUrl, videoWorkflowUrl: `${comfy.baseUrl}/workflow.json` });
});

test('a job runs end to end: rent, set up, upload, generate, save, delete the pod', async () => {
	const request = await newRequest({ prompt: 'a woman in a red dress' });
	const q = (await api('POST', '/api/video/quote', request)).body;
	assert.equal(q.allowed, true);
	assert.equal(q.minutes, 42, '28 setup + 5 s x 2 + 4 headroom');
	assert.equal(rp.state.created.length, 0, 'a quote rents nothing');

	const started = await startJob(request);
	assert.equal(started.status, 200);
	const job = await finished(started.body.id);
	assert.equal(job.status, 'done');

	const pod = rp.state.created[0];
	assert.equal(pod.image, 'wlsdml1114/multitalk-base:1.7');
	assert.deepEqual(pod.ports, ['8188/http', '8189/http']);
	assert.match(JSON.parse(pod.args).cmd[0], /^\(sleep 2640; .*\) & mkdir -p \/srv\/log/);
	assert.equal(pod.cloud, 'COMMUNITY', 'this test pins Community Cloud');
	assert.deepEqual(comfy.state.uploads.map((u) => u.name.replace(/^(in|ref)-[\w-]{36}-/, '$1:')), ['in:clip.mp4', 'ref:face.jpg']);

	const wf = comfy.state.prompts[0].prompt;
	assert.equal(wf['65'].inputs.positive_prompt, 'a woman in a red dress');
	assert.deepEqual([wf['150'].inputs.value, wf['151'].inputs.value], [480, 832], 'portrait clip -> portrait output');
	assert.equal(wf['63'].inputs.frame_load_cap, 80);
	assert.match(wf['63'].inputs.video, /^in-.*clip\.mp4$/);

	const res = await fetch(`${base}/api/uploads/${job.result}`);
	assert.equal(res.headers.get('content-type'), 'video/mp4');
	assert.equal(await res.text(), 'RESULT-VIDEO-BYTES');
	assert.deepEqual(await podGone(), ['pod1']);
	assert.equal((await api('GET', '/api/system')).body.history[0].end_reason, 'video finished');
});

test('nothing starts without the rights confirmation or the quoted price', async () => {
	const request = await newRequest();
	const q = (await api('POST', '/api/video/quote', request)).body;
	let r = await api('POST', '/api/video/jobs', { ...request, confirmEstimate: q.estimate });
	assert.equal(r.status, 409);
	assert.match(r.body.error, /right to use this footage/);
	r = await api('POST', '/api/video/jobs', { ...request, rightsConfirmed: true, confirmEstimate: 0.01 });
	assert.equal(r.status, 409);
	assert.match(r.body.error, /price changed/);
	assert.equal(rp.state.created.length, 0);
});

test('inputs are checked: a video, a picture, and a clip length', async () => {
	const video = await upload('clip.mp4', 'video/mp4');
	const image = await upload('face.jpg', 'image/jpeg');
	const bad = async (req) => (await api('POST', '/api/video/quote', { kind: 'replace', seconds: 5, ...req })).body.error;
	assert.match(await bad({ input: image, reference: image }), /Choose a video/);
	assert.match(await bad({ input: video, reference: video }), /picture of the character/);
	assert.match(await bad({ input: video, reference: image, seconds: 0 }), /length/);
	assert.match(await bad({ input: video, reference: image, kind: 'style' }), /Only character replacement/);
});

test('long clips are trimmed to the limit and the quote says so', async () => {
	const q = (await api('POST', '/api/video/quote', await newRequest({ seconds: 42 }))).body;
	assert.equal(q.seconds, 10);
	assert.equal(q.trimmed, true);
	assert.equal(q.minutes, 52);
});

test('setup progress from the pod is shown while it loads, then generation starts', async () => {
	comfy.state.ready = false;
	const started = await startJob(await newRequest());
	let job;
	for (let i = 0; i < 200; i++) {
		job = (await api('GET', '/api/video')).body.jobs[0];
		if (job.detail === '3/4 Downloading models') break;
		await new Promise((r) => setTimeout(r, 10));
	}
	assert.equal(job.status, 'loading');
	assert.equal(job.detail, '3/4 Downloading models');
	comfy.state.ready = true;
	assert.equal((await finished(started.body.id)).status, 'done');
});

for (const [outcome, pattern, setup] of [
	['reject', /rejected the workflow: VHS_LoadVideo: Invalid video file/],
	['error', /Generation failed in WanVideoSampler: CUDA out of memory/],
	['empty', /produced no video/],
	['ok', /Setting up the video engine failed: .*No space left/, () => { comfy.state.ready = false; comfy.state.setupLog = 'STEP 3/4 Downloading models\nwget: No space left on device\nSETUP FAILED\n'; }]
]) {
	test(`failure is reported in plain words and the pod is deleted (${pattern.source.slice(0, 28)})`, async () => {
		comfy.state.outcome = outcome;
		setup?.();
		const started = await startJob(await newRequest());
		const job = await finished(started.body.id);
		assert.equal(job.status, 'failed');
		assert.match(job.detail, pattern);
		assert.deepEqual(await podGone(), ['pod1']);
	});
}

test('cancelling stops the job and deletes the pod', async () => {
	comfy.state.pollsUntilDone = 1e9;
	const started = await startJob(await newRequest());
	for (let i = 0; i < 200 && (await api('GET', '/api/video')).body.jobs[0].status !== 'generating'; i++) await new Promise((r) => setTimeout(r, 10));
	await api('POST', `/api/video/jobs/${started.body.id}/cancel`);
	const job = await finished(started.body.id);
	assert.equal(job.status, 'cancelled');
	assert.deepEqual(await podGone(), ['pod1']);
});

test('only one video at a time, and a wrong workflow file fails before anything is rented', async () => {
	comfy.state.pollsUntilDone = 1e9;
	const first = await startJob(await newRequest());
	const second = await api('POST', '/api/video/quote', await newRequest());
	assert.match(second.body.error, /already being processed/);
	await api('POST', `/api/video/jobs/${first.body.id}/cancel`);
	await finished(first.body.id);

	Object.assign(rp.state, { created: [], deleted: [] });
	comfy.state.template = { ...TEMPLATE, '63': { class_type: 'SomethingElse', inputs: {} } };
	await app.close();
	app = createApp({ dataDir: join(root, `d${n}`), watchdogMs: 0, videoPollMs: 5 });
	base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
	const job = await finished((await startJob(await newRequest())).body.id);
	assert.equal(job.status, 'failed');
	assert.equal(rp.state.created.length, 0);
});

test('a job interrupted by a restart is closed and its pod deleted', async () => {
	comfy.state.pollsUntilDone = 1e9;
	const started = await startJob(await newRequest());
	for (let i = 0; i < 200 && !rp.state.created.length; i++) await new Promise((r) => setTimeout(r, 10));
	await new Promise((r) => setTimeout(r, 30));
	rp.state.deleted = [];
	await app.close(); // closing does not run the job's cleanup to completion in a real crash; simulate by restarting
	app = createApp({ dataDir: join(root, `d${n}`), watchdogMs: 0, videoPollMs: 5 });
	base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
	await new Promise((r) => setTimeout(r, 100));
	const job = (await api('GET', '/api/video')).body.jobs.find((j) => j.id === started.body.id);
	assert.equal(job.active, false);
	assert.ok(['failed', 'cancelled'].includes(job.status));
	assert.equal((await api('GET', '/api/system')).body.active.length, 0);
});

const cmd0 = () => comfyPodSpec().cmd;
test('recipe details', () => {
	assert.deepEqual(outputSize(1920, 1080), { width: 832, height: 480 });
	assert.deepEqual(outputSize(1080, 1920), { width: 480, height: 832 });
	assert.deepEqual(outputSize(1000, 1000), { width: 640, height: 640 });
	assert.equal(minutesFor(5), 42);
	assert.match(cmd0(), /aria2c -q -x 16[\s\S]*Downloading models \(\$\(ls/);
	const cmd = comfyPodSpec().cmd;
	assert.match(cmd, /STEP 1\/4[\s\S]*STEP 2\/4[\s\S]*STEP 3\/4[\s\S]*STEP 4\/4/);
	assert.match(cmd, /Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ\.safetensors/);
	assert.throws(() => buildWorkflow({}, { video: 'v', image: 'i', prompt: '', seed: 1, width: 480, height: 832, seconds: 5 }), /not the expected version/);
});

test('the owner picks how long the GPU may run: a chosen length is used, even past the per-pod limit', async () => {
	const request = await newRequest({ runMinutes: '120' });
	const q = (await api('POST', '/api/video/quote', request)).body;
	assert.equal(q.allowed, true, q.reason);
	assert.equal(q.minutes, 120, 'over the 90-minute per-pod setting, allowed because it was picked');
	assert.equal(q.run, 120);
	assert.equal(q.warning, '');
	const job = await finished((await startJob(request)).body.id);
	assert.equal(job.status, 'done');
	assert.match(JSON.parse(rp.state.created[0].args).cmd[0], /^\(sleep 7320; /, 'the pod deletes itself after 120 min + grace');
	assert.equal(job.params.run, 120);
	// a length shorter than the estimate is allowed, with a warning
	const short = (await api('POST', '/api/video/quote', await newRequest({ runMinutes: '30', seconds: 5 }))).body;
	assert.equal(short.minutes, 30);
	assert.match(short.warning, /about 42 minutes/);
	// automatic stays capped by the per-pod setting
	const auto = (await api('POST', '/api/video/quote', await newRequest({ runMinutes: 'auto' }))).body;
	assert.equal(auto.minutes, 42);
	assert.equal(auto.run, 'auto');
});

test('"until done" has no fixed limit: the GPU stops when the video is done, with a 12-hour offline backstop', async () => {
	const request = await newRequest({ runMinutes: 'until-done' });
	const q = (await api('POST', '/api/video/quote', request)).body;
	assert.equal(q.allowed, true, q.reason);
	assert.equal(q.run, 'until-done');
	assert.equal(q.minutes, 720);
	const job = await finished((await startJob(request)).body.id);
	assert.equal(job.status, 'done');
	assert.deepEqual(await podGone(), ['pod1'], 'deleted as soon as the video is done');
	assert.match(JSON.parse(rp.state.created[0].args).cmd[0], /^\(sleep 43320; /);
});

test('"until done" with a small balance runs as long as the balance covers, or explains why it cannot start', async () => {
	rp.state.balance = 2;
	const q = (await api('POST', '/api/video/quote', await newRequest({ runMinutes: 'until-done' }))).body;
	assert.equal(q.allowed, true, q.reason);
	assert.ok(q.minutes >= q.needed && q.minutes < 720, `minutes ${q.minutes}`);
	assert.ok(q.estimate <= 2);
	rp.state.balance = 0.05;
	await app.close();
	app = createApp({ dataDir: join(root, `d${++n}`), watchdogMs: 0, videoPollMs: 5 });
	base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
	await api('PUT', '/api/settings', { maxPodMinutes: '90', runpodApiKey: rp.state.key, runpodBaseUrl: rp.baseUrl, runpodGraphqlUrl: rp.graphqlUrl, podCloud: 'COMMUNITY', podProxyTemplate: comfy.baseUrl, videoWorkflowUrl: `${comfy.baseUrl}/workflow.json` });
	const poor = (await api('POST', '/api/video/quote', await newRequest({ runMinutes: 'until-done' }))).body;
	assert.equal(poor.allowed, false);
	assert.match(poor.reason, /covers about \d+ minutes/);
});

test('unknown run lengths fall back to automatic, and the GPU time left is shown while running', async () => {
	for (const bad of ['999', '-5', 'forever', null, 1e9]) {
		const q = (await api('POST', '/api/video/quote', await newRequest({ runMinutes: bad }))).body;
		assert.equal(q.run, 'auto', String(bad));
		assert.equal(q.minutes, 42);
	}
	comfy.state.pollsUntilDone = 40;
	const started = await startJob(await newRequest({ runMinutes: '60' }));
	let seen = null;
	for (let i = 0; i < 200 && seen === null; i++) {
		const job = (await api('GET', '/api/video')).body.jobs.find((j) => j.id === started.body.id);
		if (job.gpuSecondsLeft != null) seen = job.gpuSecondsLeft;
		await new Promise((r) => setTimeout(r, 5));
	}
	assert.ok(seen > 3500 && seen <= 3600, `time left ${seen}`);
	await finished(started.body.id);
});

test('a stuck job is stopped even with no time limit: setup with no progress, or generating far too long', async () => {
	// setup that never changes
	await app.close();
	app = createApp({ dataDir: join(root, `d${++n}`), watchdogMs: 0, videoPollMs: 5, videoStallMs: 150, videoGenerateFactor: 4 });
	base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
	await api('PUT', '/api/settings', { maxPodMinutes: '90', runpodApiKey: rp.state.key, runpodBaseUrl: rp.baseUrl, runpodGraphqlUrl: rp.graphqlUrl, podCloud: 'COMMUNITY', podProxyTemplate: comfy.baseUrl, videoWorkflowUrl: `${comfy.baseUrl}/workflow.json` });
	comfy.state.ready = false;
	const stuck = await finished((await startJob(await newRequest({ runMinutes: 'until-done' }))).body.id);
	assert.equal(stuck.status, 'failed');
	assert.match(stuck.detail, /made no progress/);
	assert.deepEqual(await podGone(), ['pod1'], 'the GPU is deleted');

	// setup that keeps changing is not stuck
	comfy.state.ready = false;
	let steps = 0;
	const timer = setInterval(() => { comfy.state.setupLog = `STEP 3/4 Downloading models ${++steps}\n`; if (steps > 12) comfy.state.ready = true; }, 40);
	const moving = await finished((await startJob(await newRequest({ runMinutes: 'until-done' }))).body.id);
	clearInterval(timer);
	assert.equal(moving.status, 'done', moving.detail);
});

test('generating far past its estimate stops the GPU', async () => {
	let now = Date.now();
	await app.close();
	app = createApp({ dataDir: join(root, `d${++n}`), clock: () => now, watchdogMs: 0, videoPollMs: 5 });
	base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
	await api('PUT', '/api/settings', { maxPodMinutes: '90', runpodApiKey: rp.state.key, runpodBaseUrl: rp.baseUrl, runpodGraphqlUrl: rp.graphqlUrl, podCloud: 'COMMUNITY', podProxyTemplate: comfy.baseUrl, videoWorkflowUrl: `${comfy.baseUrl}/workflow.json` });
	comfy.state.pollsUntilDone = 1e9;
	const started = await startJob(await newRequest({ runMinutes: 'until-done' }));
	for (let i = 0; i < 200; i++) {
		const job = (await api('GET', '/api/video')).body.jobs.find((j) => j.id === started.body.id);
		if (job.status === 'generating') break;
		await new Promise((r) => setTimeout(r, 5));
	}
	now += 61 * 60000; // 5 s clip: limit is max(60, 5 x 2 x 4) = 60 minutes
	const job = await finished(started.body.id);
	assert.equal(job.status, 'failed');
	assert.match(job.detail, /Generating took over 60 minutes/);
	assert.deepEqual(await podGone(), ['pod1']);
});
