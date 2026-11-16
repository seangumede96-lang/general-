import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { observability, silhouetteWidths, smallMask, buildEvidence, rle, LM } from '../public/photo.js';

// A synthetic upright person in a 100 x 200 image: landmarks in 0..1 coordinates, all clearly seen.
const person = () => { const l = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.95 }));
	const set = (i, x, y) => { l[i] = { x, y, z: 0, visibility: 0.95 }; };
	set(LM.nose, 0.5, 0.08); set(LM.lShoulder, 0.6, 0.2); set(LM.rShoulder, 0.4, 0.2); set(LM.lHip, 0.57, 0.5); set(LM.rHip, 0.43, 0.5);
	set(LM.lKnee, 0.56, 0.72); set(LM.rKnee, 0.44, 0.72); set(LM.lAnkle, 0.55, 0.94); set(LM.rAnkle, 0.45, 0.94); return l; };

test('observability: a front photo measures widths but not butt projection; a side photo the reverse; hidden points count as unseen', () => {
	const f = observability(person(), 'front');
	assert.equal(f.hipWidth, 'observed'); assert.equal(f.shoulderWidth, 'observed'); assert.equal(f.buttProjection, 'unknown');
	const s = observability(person(), 'left');
	assert.equal(s.hipWidth, 'unknown'); assert.equal(s.buttProjection, 'observed'); assert.equal(s.bellyDepth, 'observed');
	const q = observability(person(), 'rear_left');
	assert.equal(q.hipWidth, 'weak'); assert.equal(q.buttProjection, 'weak'); assert.equal(q.chestDepth, 'unknown');
	const h = observability(person(), 'front', [LM.lAnkle, LM.rAnkle]);
	assert.equal(h.legLength, 'unknown'); assert.equal(h.height, 'unknown');
});

test('silhouette widths read from the mask at body heights; masks shrink and run-length encode without photo pixels', () => {
	const W = 100, H = 200, data = new Float32Array(W * H);
	for (let y = 10; y < 190; y++) { const half = y < 60 ? 12 : y < 100 ? 9 : 15; for (let x = 50 - half; x < 50 + half; x++) data[y * W + x] = 1; }
	const w = silhouetteWidths({ width: W, height: H, data }, person());
	assert.equal(w.personHeightPx, 180);
	assert.equal(w.px.shoulders, 24); assert.equal(w.px.waist, 18); assert.equal(w.px.hips, 30);
	const m = smallMask({ width: W, height: H, data }, 50);
	assert.deepEqual([m.width, m.height], [25, 50]);
	assert.deepEqual(rle(Uint8Array.from([0, 0, 255, 255, 255, 0])), [0, 2, 255, 3, 0, 1]);
	const ev = buildEvidence({ landmarks: person(), mask: { width: W, height: H, data }, view: 'front', pose: 'standing', imageWidth: 1000, imageHeight: 2000, crop: { left: 0, right: 0, top: 0, bottom: 0 }, hidden: [LM.lKnee], edited: [LM.nose] });
	assert.equal(ev.format, 'photo-evidence/1'); assert.equal(ev.landmarks.length, 33);
	assert.equal(ev.landmarks[LM.lKnee].visibility, 0); assert.equal(ev.landmarks[LM.nose].edited, true);
	assert.ok(ev.mask.rle.length > 2 && !('data' in ev.mask));
});

let app, base, root;
before(async () => { root = mkdtempSync(join(tmpdir(), 'photo-')); app = createApp({ dataDir: root, watchdogMs: 0 }); base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`; });
after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });

test('the server stores evidence records, refuses other JSON, and serves the vendored MediaPipe files with the right types', async () => {
	const ev = buildEvidence({ landmarks: person(), mask: null, view: 'left', pose: 'standing', imageWidth: 10, imageHeight: 20, crop: {} });
	const ok = await fetch(`${base}/api/body/evidence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev) });
	assert.equal(ok.status, 200); const r = await ok.json(); assert.ok(r.id); assert.equal(r.observability.buttProjection, 'observed');
	const back = await (await fetch(`${base}/api/uploads/${r.id}`)).json(); assert.equal(back.view, 'left');
	const bad = await fetch(`${base}/api/body/evidence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hello: 1 }) });
	assert.equal(bad.status, 400);
	const wasm = await fetch(`${base}/vendor/mediapipe/wasm/vision_wasm_internal.wasm`);
	assert.equal(wasm.headers.get('content-type'), 'application/wasm');
	assert.equal((await fetch(`${base}/vendor/mediapipe/vision_bundle.mjs`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
	assert.ok(statSync(new URL('../public/vendor/mediapipe/pose_landmarker_lite.task', import.meta.url)).size > 5_000_000);
});
