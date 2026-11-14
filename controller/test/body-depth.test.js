import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { createApp } from '../src/server.js';

let app, base, root;
const api = async (method, path, body) => {
	const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, body: await res.json() };
};
/** Decode the app's own grey PNGs (one IDAT, filter 0 rows). */
function gray(buf) {
	const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
	let idat = []; let o = 8;
	while (o < buf.length) { const len = buf.readUInt32BE(o); const type = buf.toString('ascii', o + 4, o + 8); if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len)); o += 12 + len; }
	const raw = inflateSync(Buffer.concat(idat));
	const px = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) px.set(raw.subarray(y * (w + 1) + 1, (y + 1) * (w + 1)), y * w);
	return { w, h, px };
}
before(async () => { root = mkdtempSync(join(tmpdir(), 'body-depth-')); app = createApp({ dataDir: root, watchdogMs: 0 }); base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`; });
after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });

test('the server makes the body editor\'s depth map from a body code and an angle, ready for pictures', async () => {
	const r = await api('POST', '/api/body/depth', { values: { base: 'female', armL: 'hip' }, angle: 90, width: 512, height: 768 });
	assert.equal(r.status, 200, JSON.stringify(r.body));
	assert.deepEqual([r.body.width, r.body.height, r.body.angle], [512, 768, 90]);
	const res = await fetch(`${base}/api/uploads/${r.body.depth}`);
	assert.equal(res.headers.get('content-type'), 'image/png');
	const d = gray(Buffer.from(await res.arrayBuffer()));
	assert.deepEqual([d.w, d.h], [512, 768]);
	assert.equal(d.px[0], 0, 'background is black');
	const lit = d.px.filter((v) => v > 0);
	assert.ok(lit.length > 512 * 768 * 0.05 && lit.length < 512 * 768 * 0.5, `body covers ${(lit.length / d.px.length * 100).toFixed(1)}%`);
	assert.ok(Math.max(...lit) >= 250 && Math.min(...lit) <= 40, 'near is white, far is dark');
	// another angle gives a different map; a size name works too
	const front = await api('POST', '/api/body/depth', { values: { base: 'female' }, angle: 0, size: 'square' });
	assert.deepEqual([front.body.width, front.body.height], [1024, 1024]);
	const f = gray(Buffer.from(await (await fetch(`${base}/api/uploads/${front.body.depth}`)).arrayBuffer()));
	assert.notEqual(f.px.filter((v) => v > 0).length, lit.length);
	assert.ok(r.body.preview && r.body.preview !== r.body.depth);
	// bad input
	assert.equal((await api('POST', '/api/body/depth', { width: 99999, height: 10 })).status, 400);
	assert.equal((await api('POST', '/api/body/depth', { values: [1, 2] })).status, 400);
});

test('pose points and solving through the server helpers', async () => {
	const { posePoints, solvePose, renderBody } = await import('../src/body-depth.js');
	const { points } = await posePoints({});
	assert.ok(points['hand.L'][0] > 10 && points.head[1] > 140);
	const r = await solvePose({ pose: { 'upperArm.R': { lift: 90 } } }, { 'hand.R': [-30, 165, 0] });
	assert.equal(r.values.posing, true);
	assert.ok(r.missed['hand.R'] < 3, `missed by ${r.missed['hand.R']}`);
	await assert.rejects(solvePose({}, { tail: [0, 0, 0] }), /Unknown point/);
	const still = await renderBody({}, { width: 256, height: 384 });
	const posedOut = await renderBody({ posing: true, pose: { 'upperArm.L': { lift: 170 } } }, { width: 256, height: 384 });
	assert.notDeepEqual(still.depth, posedOut.depth);
});

test('remote control API: guide, points, solve, and the shared current body', async () => {
	const guide = await api('GET', '/api/body/pose/guide');
	assert.equal(guide.status, 200);
	assert.ok(guide.body.parts.some((p) => p.key === 'upperArm.L' && p.axes.some((a) => a.key === 'lift')));
	assert.ok(guide.body.presets.Waving);
	const points = await api('POST', '/api/body/pose/points', { values: { posing: true, pose: guide.body.presets['Arms up'] } });
	assert.ok(points.body.points['hand.L'][1] > 180, 'hands overhead');
	const solved = await api('POST', '/api/body/pose/solve', { values: {}, goals: { 'hand.L': [30, 160, 5] } });
	assert.equal(solved.status, 200);
	assert.ok(solved.body.missed['hand.L'] < 3);
	assert.equal((await api('POST', '/api/body/pose/solve', { goals: { 'hand.L': [1, 2] } })).status, 400);
	assert.equal((await api('POST', '/api/body/pose/solve', { goals: { wing: [1, 2, 3] } })).status, 400);
	assert.equal((await api('PUT', '/api/body/current', { values: 'x' })).status, 400);
	const first = await api('GET', '/api/body/current');
	const put = await api('PUT', '/api/body/current', { values: solved.body.values, source: 'claude' });
	assert.equal(put.body.rev, first.body.rev + 1);
	const now = await api('GET', '/api/body/current');
	assert.equal(now.body.source, 'claude');
	assert.deepEqual(now.body.values.pose, solved.body.values.pose);
	const depth = await api('POST', '/api/body/depth', { values: now.body.values, size: 'square' });
	assert.equal(depth.status, 200);
});
