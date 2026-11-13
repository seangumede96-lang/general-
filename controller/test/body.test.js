import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The body editor runs in the browser; here its model files are read from disk instead of fetched.
globalThis.fetch = async (url) => {
	const data = await readFile(fileURLToPath(url));
	return { ok: true, json: async () => JSON.parse(data), arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
};
const body = await import('../public/body.js');
const human = await body.loadHuman();

function extent(p, skin) {
	let lo = Infinity, hi = -Infinity, w = 0;
	for (let i = 0; i < skin; i++) { lo = Math.min(lo, p[i * 3 + 1]); hi = Math.max(hi, p[i * 3 + 1]); w = Math.max(w, Math.abs(p[i * 3])); }
	return { lo, hi, w };
}
const skin = () => human.eyes[0][0];

test('every slider, preset and head shape drives morph targets that exist in the model', () => {
	const all = { ...body.defaults('female') };
	for (const s of body.SLIDERS) if (s.key !== 'height') all[s.key] = s.max;
	for (const v of [all, { ...all, base: 'male' }, ...Object.keys(body.HEAD_SHAPES).map((headShape) => ({ ...body.defaults(), headShape }))]) {
		for (const name of Object.keys(body.weights(v))) assert.ok(human.morphs[name], `missing morph ${name}`);
	}
	for (const s of body.SLIDERS) if (s.key !== 'height') {
		const lo = body.weights({ ...body.defaults(), [s.key]: s.min });
		const hi = body.weights({ ...body.defaults(), [s.key]: s.max });
		assert.notDeepEqual(lo, hi, `${s.key} changes nothing`);
	}
	for (const base of ['female', 'male']) for (const preset of Object.values(body.PRESETS[base])) {
		for (const key of Object.keys(preset)) assert.ok(body.SLIDERS.some((s) => s.key === key), `preset uses unknown slider ${key}`);
	}
});

test('the figure stands on the floor at exactly the chosen height, and sliders change its shape', () => {
	for (const height of [140, 168, 205]) {
		const e = extent(body.shapeBody({ ...body.defaults(), height }), skin());
		assert.ok(Math.abs(e.lo) < 1e-3 && Math.abs(e.hi - height) < 1e-3, `height ${height}: ${e.lo}..${e.hi}`);
	}
	const slim = extent(body.shapeBody({ ...body.defaults(), weight: -1, hips: -1 }), skin());
	const wide = extent(body.shapeBody({ ...body.defaults(), weight: 1, hips: 1.5 }), skin());
	assert.ok(wide.w > slim.w);
	const p = body.shapeBody(body.defaults());
	assert.ok(p.every(Number.isFinite));
});

test('saves from the first mannequin are converted onto the new sliders', () => {
	const old = { base: 'female', headShape: 'round', height: 172, waist: 0.8, hips: 1.25, bust: 1.6, glutes: 1, legLength: 1.05 };
	const v = body.migrate(old);
	assert.equal(v.version, body.defaults().version);
	assert.equal(v.height, 172);
	assert.equal(v.headShape, 'round');
	assert.ok(v.waist < 0 && v.hips > 0 && v.bust > 0 && v.legLength > 0);
	assert.equal(v.glutes, 0);
	for (const s of body.SLIDERS) assert.ok(v[s.key] >= s.min && v[s.key] <= s.max);
	assert.deepEqual(body.migrate(v), v);
	assert.deepEqual(body.migrate(null), body.defaults());
});
