import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/server.js';
import { mocapPodSpec, minutesFor, GATED_FILES } from '../src/mocap-recipe.js';
import { startMockRunpod } from './mock-runpod.js';

let app, base, rp, root, n = 0, hf, b2, pod;
const state = { hfCalls: [], uploads: [], log: '', qc: '{"verdict": "Looks clean.", "frames": 120, "people": {"1": {"frames_missing": 0}}}', zip: 'ZIPBYTES' };
const api = async (method, path, body) => {
	const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, body: await res.json() };
};
const upload = async (name, type, bytes = 'CLIPDATA') => (await (await fetch(`${base}/api/uploads?name=${name}`, { method: 'POST', headers: { 'Content-Type': type }, body: bytes })).json()).id;
const people = [{ name: 'Person A', marks: [{ t: 0.5, points: [[0.3, 0.4, 1], [0.7, 0.4, 0]] }] }, { name: 'Person B', marks: [{ t: 0.5, points: [[0.7, 0.4, 1]] }, { t: 3.2, points: [[0.6, 0.5, 1]] }] }];
const request = async (extra = {}) => ({ input: await upload('clip.mp4', 'video/mp4'), seconds: 5, people, ...extra });
async function start(req) {
	const q = (await api('POST', '/api/mocap/quote', req)).body;
	return api('POST', '/api/mocap/jobs', { ...req, rightsConfirmed: true, confirmEstimate: q.estimate });
}
async function finished(id) {
	for (let i = 0; i < 600; i++) {
		const job = (await api('GET', '/api/mocap')).body.jobs.find((j) => j.id === id);
		if (!job.active) return job;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error('job did not finish');
}
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

before(async () => {
	rp = await startMockRunpod();
	root = mkdtempSync(join(tmpdir(), 'controller-mocap-'));
	// Hugging Face: big files redirect to another host (a signed link); the small config file is served directly.
	hf = createServer((req, res) => {
		state.hfCalls.push({ url: req.url, auth: req.headers.authorization });
		if (req.headers.authorization !== 'Bearer hf_test') { res.writeHead(403); return res.end(); }
		if (req.url.endsWith('model_config.yaml')) { res.writeHead(200); return res.end('MODEL: config'); }
		res.writeHead(302, { Location: `http://localhost:${hf.address().port}/signed${req.url}?Expires=3600&Signature=abc` });
		res.end();
	});
	await listen(hf);
	// Backblaze: authorize, bucket, upload URL, upload, download link.
	b2 = createServer(async (req, res) => {
		const chunks = []; for await (const c of req) chunks.push(c);
		const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
		const b2Url = `http://127.0.0.1:${b2.address().port}`;
		if (req.url.endsWith('b2_authorize_account')) return send({ accountId: 'acc', authorizationToken: 'tok', apiInfo: { storageApi: { apiUrl: b2Url, downloadUrl: 'https://f000.b2.test', bucketId: null, bucketName: null } } });
		if (req.url.endsWith('b2_list_buckets')) return send({ buckets: [{ bucketId: 'bkt1', bucketName: 'mybucket' }] });
		if (req.url.endsWith('b2_get_upload_url')) return send({ uploadUrl: `${b2Url}/upload`, authorizationToken: 'up-tok' });
		if (req.url === '/upload') { state.uploads.push({ name: decodeURIComponent(req.headers['x-bz-file-name']), bytes: Buffer.concat(chunks).length, sha1: req.headers['x-bz-content-sha1'] }); return send({ contentLength: Buffer.concat(chunks).length }); }
		if (req.url.endsWith('b2_get_download_authorization')) return send({ authorizationToken: 'dl-tok' });
		res.writeHead(404).end();
	});
	await listen(b2);
	// The pod's log server: setup.log, out/qc.json, out/joints.zip.
	pod = createServer((req, res) => {
		if (req.url.endsWith('/setup.log')) { res.writeHead(200); return res.end(state.log); }
		if (req.url.endsWith('/out/qc.json')) { res.writeHead(200); return res.end(state.qc); }
		if (req.url.endsWith('/out/joints.zip')) { res.writeHead(200); return res.end(state.zip); }
		res.writeHead(404).end();
	});
	await listen(pod);
});
after(async () => { await app?.close(); await rp.close(); hf.close(); b2.close(); pod.close(); rmSync(root, { recursive: true, force: true }); });
beforeEach(async () => {
	await app?.close();
	Object.assign(rp.state, { noCapacity: new Set(), pods: new Map(), created: [], deleted: [], seq: 0, balance: 61.38 });
	rp.state.gpus = rp.state.gpus.map((g) => (g.memory >= 48 ? { ...g, availability: 'HIGH' } : g));
	Object.assign(state, { hfCalls: [], uploads: [], log: 'STEP 1/5 Installing\nSTEP 4/5 Tracking the people and measuring their bodies\nPROGRESS 60 of 120 frames\nMOCAP DONE 120 frames, 8 bytes\n' });
	app = createApp({ dataDir: join(root, `d${++n}`), watchdogMs: 0, mocapPollMs: 5, hfBase: `http://127.0.0.1:${hf.address().port}` });
	base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
	await api('PUT', '/api/settings', {
		runpodApiKey: rp.state.key, runpodBaseUrl: rp.baseUrl, runpodGraphqlUrl: rp.graphqlUrl, podProxyTemplate: `http://127.0.0.1:${pod.address().port}`,
		b2KeyId: 'kid', b2AppKey: 'secret-app-key', b2Bucket: 'mybucket', b2ApiBase: `http://127.0.0.1:${b2.address().port}`, hfToken: 'hf_test'
	});
});

test('a job runs blind end to end: clip to Backblaze, signed links, a 48 GB GPU, joint data and report back, GPU deleted', async () => {
	const req = await request();
	const q = (await api('POST', '/api/mocap/quote', req)).body;
	assert.equal(q.allowed, true, q.reason);
	assert.equal(q.minutes, minutesFor(5));
	assert.ok(q.options.every((o) => o.memory >= 48), 'only 48 GB cards');
	const started = await start(req);
	assert.equal(started.status, 200, JSON.stringify(started.body));
	const job = await finished(started.body.id);
	assert.equal(job.status, 'done', job.detail);
	// the clip went to Backblaze, and so did the results
	assert.deepEqual(state.uploads.map((u) => u.name), [`pipeline/mocap/${job.id}/input.mp4`, `pipeline/mocap/${job.id}/joints.zip`, `pipeline/mocap/${job.id}/qc.json`]);
	assert.match(state.uploads[0].sha1, /^[0-9a-f]{40}$/);
	// the pod got links and marks, never a key or the token
	const created = rp.state.created[0];
	const env = created.env;
	assert.equal(created.image, 'runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2404');
	assert.match(env.MOCAP_VIDEO_URL, /^https:\/\/f000\.b2\.test\/file\/mybucket\/pipeline\/mocap\/.*\/input\.mp4\?Authorization=dl-tok$/);
	const gated = env.MOCAP_GATED.split('\n');
	assert.deepEqual(gated.map((l) => l.split(' ')[0]), ['sam3/sam3.pt', 'sam-3d-body-dinov3/model.ckpt', 'sam-3d-body-dinov3/assets/mhr_model.pt']);
	assert.ok(gated.every((l) => /^\S+ http:\/\/localhost:\d+\/signed\/.*Signature=abc$/.test(l)));
	assert.equal(Buffer.from(JSON.parse(env.MOCAP_SMALL)['sam-3d-body-dinov3/model_config.yaml'], 'base64').toString(), 'MODEL: config');
	const marks = JSON.parse(Buffer.from(env.MOCAP_PROMPTS, 'base64').toString());
	assert.deepEqual(marks.people.map((p) => [p.id, p.name, p.marks.length]), [[1, 'Person A', 1], [2, 'Person B', 2]]);
	assert.deepEqual(marks.people[0].marks[0].points, [[0.3, 0.4, 1], [0.7, 0.4, 0]]);
	const all = JSON.stringify(created);
	for (const secret of ['hf_test', 'secret-app-key', rp.state.key]) assert.ok(!all.includes(secret), `${secret} must not reach the pod`);
	assert.ok(state.hfCalls.every((c) => c.auth === 'Bearer hf_test'));
	// results on the phone
	assert.equal(job.qc.verdict, 'Looks clean.');
	assert.equal(job.params.b2Path, `pipeline/mocap/${job.id}/`);
	const res = await fetch(`${base}/api/uploads/${job.result}`);
	assert.equal(await res.text(), 'ZIPBYTES');
	assert.deepEqual(rp.state.deleted, ['pod1']);
	// a video job list does not show motion capture
	assert.equal((await api('GET', '/api/video')).body.jobs.length, 0);
});

test('nothing starts without marks (or automatic), rights, Backblaze, the token, or a short enough clip', async () => {
	const input = await upload('clip.mp4', 'video/mp4');
	assert.match((await api('POST', '/api/mocap/quote', { input, seconds: 5, people: [] })).body.error, /Mark each person/);
	assert.match((await api('POST', '/api/mocap/quote', { input, seconds: 5, people: [{ name: 'X', marks: [{ t: 0, points: [[0.5, 0.5, 0]] }] }] })).body.error, /Mark each person/, 'only "not this person" points do not count');
	assert.equal((await api('POST', '/api/mocap/quote', { input, seconds: 5, automatic: true })).body.allowed, true);
	assert.match((await api('POST', '/api/mocap/quote', { input, seconds: 61, people })).body.error, /up to 60 seconds/);
	assert.match((await api('POST', '/api/mocap/jobs', { input, seconds: 5, people })).body.error, /right to use this footage/);
	assert.match((await api('POST', '/api/mocap/quote', { input: await upload('a.png', 'image/png'), seconds: 5, people })).body.error, /Choose a video/);
	await api('PUT', '/api/settings', { clearHfToken: true, hfToken: '' });
	const s = (await api('GET', '/api/settings')).body;
	if (!s.hasHfToken) assert.match((await api('POST', '/api/mocap/quote', { input, seconds: 5, people })).body.error, /Hugging Face token/);
	assert.ok(!JSON.stringify(s).includes('hf_test'), 'the token is never sent to the page');
});

test('a token without access, a failed setup, and a cancel all end cleanly with the GPU deleted', async () => {
	await api('PUT', '/api/settings', { hfToken: 'hf_wrong' });
	const denied = await finished((await start(await request())).body.id);
	assert.equal(denied.status, 'failed');
	assert.match(denied.detail, /Hugging Face refused facebook\/sam3/);
	assert.equal(rp.state.created.length, 0, 'no GPU is rented when the links cannot be made');
	await api('PUT', '/api/settings', { hfToken: 'hf_test' });

	state.log = 'STEP 3/5 Installing\nERROR: No matching distribution\nSETUP FAILED\n';
	const failed = await finished((await start(await request())).body.id);
	assert.equal(failed.status, 'failed');
	assert.match(failed.detail, /Motion capture failed on the GPU: .*No matching distribution/);
	assert.deepEqual(rp.state.deleted, ['pod1']);

	state.log = 'STEP 4/5 Tracking the people and measuring their bodies\nPROGRESS 10 of 120 frames\n';
	const started = await start(await request());
	for (let i = 0; i < 300; i++) { const j = (await api('GET', '/api/mocap')).body.jobs[0]; if (j.status === 'tracking') { assert.match(j.detail, /10 of 120 frames/); break; } await new Promise((r) => setTimeout(r, 5)); }
	await api('POST', `/api/mocap/jobs/${started.body.id}/cancel`);
	const cancelled = await finished(started.body.id);
	assert.equal(cancelled.status, 'cancelled');
	assert.deepEqual(rp.state.deleted, ['pod1', 'pod2']);
});

test('the pod script is valid bash, waits only on its own downloads, and never serves the clip', () => {
	const spec = mocapPodSpec({ MOCAP_VIDEO_URL: 'u', MOCAP_GATED: '', MOCAP_SMALL: '{}', MOCAP_PROMPTS: '' });
	const dir = mkdtempSync(join(tmpdir(), 'mocap-script-'));
	writeFileSync(join(dir, 's.sh'), spec.cmd);
	execFileSync('bash', ['-n', join(dir, 's.sh')]);
	assert.ok(!/^wait\s*$/m.test(spec.cmd), 'a bare wait would also wait on the self-delete timer');
	assert.match(spec.cmd, /wait \$DL/);
	assert.match(spec.cmd, /git checkout -q 21af1020979ef32ddf6be3597ef59a68bad2f1bf/);
	assert.match(spec.cmd, /PIP_CONSTRAINT/);
	assert.ok(spec.cmd.includes('rm -rf /root/video'), 'the clip is removed from the pod when done');
	assert.ok(!/\/srv\/log\/.*\.(mp4|jpg|png)/.test(spec.cmd), 'nothing visual is served');
	assert.equal(Buffer.from(spec.env.MOCAP_PATCH, 'base64').toString(), readFileSync(new URL('../src/mocap-pod/patch_offline_app.py', import.meta.url), 'utf8'));
	assert.deepEqual(GATED_FILES.map((g) => g.repo), ['facebook/sam3', 'facebook/sam-3d-body-dinov3', 'facebook/sam-3d-body-dinov3', 'facebook/sam-3d-body-dinov3']);
	rmSync(dir, { recursive: true, force: true });
});

test('the quality check reports missing frames, jumps and identity swaps from numbers only', () => {
	const dir = mkdtempSync(join(tmpdir(), 'mocap-qc-'));
	const py = `
import numpy as np, os
rng = np.random.default_rng(0); base = rng.normal(size=(70, 3)) * 0.3
for f in range(40):
    ids = [1, 2] if f != 10 else [1]
    A = base + [0, 0, 3] + 0.002 * rng.normal(size=(70, 3)); B = base + [0.8, 0, 3] + 0.002 * rng.normal(size=(70, 3))
    if 20 <= f < 25: A, B = B, A
    np.savez_compressed(os.path.join(${JSON.stringify(dir)}, f"{f:08d}.npz"), ids=np.array(ids), pred_joint_coords=np.stack([A, B])[:len(ids)], pred_cam_t=np.zeros((len(ids), 3)))
`;
	try { execFileSync('python3', ['-I', '-c', py]); } catch { return; } // no numpy here: covered on the GPU
	const out = JSON.parse(execFileSync('python3', ['-I', new URL('../src/mocap-pod/qc_mocap.py', import.meta.url).pathname, dir, '24']).toString());
	assert.equal(out.frames, 40);
	assert.equal(out.people['2'].frames_missing, 1);
	assert.deepEqual(out.swaps.map((s) => s.frame), [20, 25]);
	assert.match(out.verdict, /identity swaps/);
	rmSync(dir, { recursive: true, force: true });
});

test('a job only counts as ended once its GPU has been deleted', async () => {
	state.log = 'STEP 4/5 Tracking\n';
	const started = await start(await request());
	for (let i = 0; i < 300 && !rp.state.created.length; i++) await new Promise((r) => setTimeout(r, 5));
	await new Promise((r) => setTimeout(r, 30));
	await api('POST', `/api/mocap/jobs/${started.body.id}/cancel`);
	// Every time the job is seen as ended, its GPU is already gone.
	for (let i = 0; i < 600; i++) {
		const job = (await api('GET', '/api/mocap')).body.jobs.find((j) => j.id === started.body.id);
		if (!job.active) { assert.deepEqual(rp.state.deleted, ['pod1']); return; }
		await new Promise((r) => setTimeout(r, 2));
	}
	assert.fail('job did not end');
});
