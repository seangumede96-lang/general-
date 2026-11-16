import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { renderBody } from '../src/body-depth.js';
import { fitBody, profile, decodeMask, fittable } from '../src/body-fit.js';
import { rle } from '../public/photo.js';

const FRONT = { height: 'observed', shoulderWidth: 'observed', waistWidth: 'observed', hipWidth: 'observed', thighWidth: 'observed', legLength: 'observed', buttProjection: 'unknown', bellyDepth: 'unknown', chestDepth: 'unknown' };
/** Evidence made from the figure itself with known settings: a "photo" whose true answer we know. */
async function evidenceOf(values, view = 'front', angle = 0, obs = FRONT) {
	const r = await renderBody(values, { angleDeg: angle, width: 72, height: 108, raw: true });
	return { format: 'photo-evidence/1', consent: 'own-or-consenting-adult', view, observability: obs, landmarks: [], mask: { width: r.width, height: r.height, rle: rle(Uint8Array.from(r.mask, (x) => (x ? 255 : 0))) } };
}

test('fitting: a front "photo" of wide hips moves hips towards the truth, cuts the outline error, and leaves depths alone', async () => {
	const ev = await evidenceOf({ weight: 0.5, hips: 1, waist: -0.5, thighs: 0.75, shoulders: -0.5 });
	const f = await fitBody(ev, {});
	assert.ok(f.error.after < f.error.before * 0.5, `error ${f.error.before} -> ${f.error.after}`);
	assert.ok(f.values.hips >= 0.5, `hips ${f.values.hips}`);
	for (const k of ['glutes', 'buttOut', 'belly', 'bust']) { assert.ok(f.untouched.includes(k), `${k} not measurable from the front`); assert.equal(f.values[k] ?? 0, 0); }
	assert.ok(f.fitted.every((x) => x.trust === 'measured'));
	// the same body as the start needs no change
	const same = await fitBody(await evidenceOf({}), {}, { width: 72, height: 108, steps: [0.25] });
	assert.ok(same.fitted.every((x) => Math.abs(x.to - x.from) <= 0.25), JSON.stringify(same.fitted));
});

test('fitting refuses evidence without consent or an outline, and a front view can\'t fit butt projection', async () => {
	const ev = await evidenceOf({});
	await assert.rejects(fitBody({ ...ev, consent: undefined }), /consent/);
	await assert.rejects(fitBody({ ...ev, mask: null }), /outline/);
	assert.deepEqual(fittable(FRONT).map((p) => p.key).filter((k) => ['glutes', 'buttOut'].includes(k)), []);
	const side = fittable({ ...FRONT, hipWidth: 'unknown', waistWidth: 'unknown', thighWidth: 'unknown', shoulderWidth: 'unknown', buttProjection: 'observed', bellyDepth: 'weak' });
	assert.ok(side.some((p) => p.key === 'buttOut' && p.trust === 1) && side.some((p) => p.key === 'belly' && p.trust === 0.5) && !side.some((p) => p.key === 'hips'));
	const prof = profile(decodeMask(ev.mask)); assert.equal(prof.length, 48); assert.ok(prof.every((x) => x >= 0 && x < 1));
});

let app, base, root;
before(async () => { root = mkdtempSync(join(tmpdir(), 'fit-')); app = createApp({ dataDir: root, watchdogMs: 0 }); base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`; });
after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

test('POST /api/body/fit fits saved evidence and saves a body-fit/1 record', async () => {
	const ev = await evidenceOf({ hips: 1.2 });
	const saved = await post('/api/body/evidence', ev); assert.equal(saved.status, 200, JSON.stringify(saved.body));
	const r = await post('/api/body/fit', { evidence: saved.body.id, values: { base: 'female' } });
	assert.equal(r.status, 200, JSON.stringify(r.body));
	assert.equal(r.body.format, 'body-fit/1'); assert.equal(r.body.consent, 'own-or-consenting-adult'); assert.ok(r.body.id);
	assert.ok(r.body.values.hips > 0.3, `hips ${r.body.values.hips}`); assert.ok(r.body.error.after < r.body.error.before);
	assert.equal((await post('/api/body/fit', { evidence: 'nope' })).status, 404);
});
