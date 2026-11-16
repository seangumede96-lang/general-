import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { POSE_PRESETS } from '../public/pose.js';

let app, base, root;
// Blender from BLENDER, or Ubuntu's package, or a download in /opt.
const BLENDER = process.env.BLENDER || ['/usr/bin/blender', '/opt/blender/blender'].find((p) => existsSync(p)) || '';
const api = async (method, path, body) => {
	const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
};
const motion = (n = 12) => ({
	format: 'motion/1', skeleton: 'assistant-human/1', name: 'Test wave', fps: 10, frameCount: n, duration: n / 10,
	source: { kind: 'video', key: 'abc123', file: 'clip.mp4', people: 1 }, person: 1,
	frames: Array.from({ length: n }, (_, i) => ({ t: i / 10, root: [i * 2, 0, 0], pose: i % 4 < 2 ? POSE_PRESETS.Standing : POSE_PRESETS.Waving, conf: {} })),
	quality: { arms: { seen: 1 } }
});

before(async () => { root = mkdtempSync(join(tmpdir(), 'motions-')); app = createApp({ dataDir: root, watchdogMs: 0 }); base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`; });
after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });

test('motions are saved, listed, found by their video, and deleted', async () => {
	const { body: { id } } = await api('POST', '/api/motions', motion());
	assert.ok(id);
	assert.equal((await api('GET', '/api/motions')).body.motions[0].name, 'Test wave');
	assert.equal((await api('GET', '/api/motions?source=abc123')).body.motions.length, 1, 'the same clip is found, not analysed again');
	assert.equal((await api('GET', '/api/motions?source=other')).body.motions.length, 0);
	assert.equal((await api('GET', `/api/motions/${id}`)).body.frames.length, 12);
	assert.equal((await api('POST', '/api/motions', { format: 'nope' })).status, 400);
	await api('DELETE', `/api/motions/${id}`);
	assert.equal((await api('GET', '/api/motions')).body.motions.length, 0);
});

test('BVH download', async () => {
	const { body: { id } } = await api('POST', '/api/motions', motion());
	const r = await api('GET', `/api/motions/${id}.bvh`);
	assert.equal(r.status, 200);
	assert.match(r.headers.get('content-disposition'), /Test_wave\.bvh/);
	assert.match(r.body.toString(), /^HIERARCHY\nROOT hips/);
	assert.match(r.body.toString(), /Frames: 12/);
});

test('FBX without Blender says how to get it', async () => {
	await api('PUT', '/api/settings', { blenderPath: '/nonexistent/blender' });
	const { body: { id } } = await api('POST', '/api/motions', motion());
	const r = await api('GET', `/api/motions/${id}.fbx`);
	assert.equal(r.status, 501);
	assert.match(r.body.error, /apt install blender/);
});

test('FBX through Blender (when Blender is here)', { skip: !BLENDER && 'Blender not installed here' }, async () => {
	await api('PUT', '/api/settings', { blenderPath: BLENDER });
	const { body: { id } } = await api('POST', '/api/motions', motion());
	const r = await api('GET', `/api/motions/${id}.fbx?names=mixamo`);
	assert.equal(r.status, 200, r.body.error);
	assert.equal(r.body.subarray(0, 18).toString(), 'Kaydara FBX Binary');
	assert.ok(r.body.includes(Buffer.from('mixamorig:LeftForeArm')));
});
