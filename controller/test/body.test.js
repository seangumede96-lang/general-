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
	for (const s of body.SLIDERS) if (!['height', 'armPose', 'stance', 'hipDipHeight'].includes(s.key)) {
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

test('the arms hang at the sides by default and rise with "Arms out"; male and female differ', () => {
	const marker = (p, [start, count]) => { let x = 0, y = 0; for (let i = start; i < start + count; i++) { x += p[i * 3]; y += p[i * 3 + 1]; } return [x / count, y / count]; };
	const angle = (p) => { const u = marker(p, human.markers['upperarm01.L']), w = marker(p, human.markers['wrist.L']); return (Math.atan2(Math.abs(w[0] - u[0]), u[1] - w[1]) * 180) / Math.PI; };
	const down = angle(body.shapeBody(body.defaults()));
	const out = angle(body.shapeBody({ ...body.defaults(), armPose: 1 }));
	assert.ok(down > 4 && down < 15, `arms down at ${down} degrees`);
	assert.ok(out > 35, `arms out at ${out} degrees`);
	assert.ok(human.morphs.female.idx.length > 1000 && human.morphs.male.idx.length > 1000, 'gender shapes are present');
	const f = body.shapeBody(body.defaults('female')), m = body.shapeBody(body.defaults('male'));
	let diff = 0;
	for (let i = 0; i < f.length; i++) diff = Math.max(diff, Math.abs(f[i] - m[i]));
	assert.ok(diff > 2, 'male and female bodies differ');
});

test('feet stand close together by default and spread with "Feet apart"', () => {
	const marker = (p, [start, count]) => { let x = 0; for (let i = start; i < start + count; i++) x += p[i * 3]; return x / count; };
	const spread = (v) => { const p = body.shapeBody(v); return marker(p, human.markers['foot.L']) - marker(p, human.markers['foot.R']); };
	const together = Math.abs(spread(body.defaults())), apart = Math.abs(spread({ ...body.defaults(), stance: 1 }));
	assert.ok(together < apart * 0.75, `feet ${together} vs ${apart}`);
	assert.ok(together > 5, 'the feet do not cross');
});

test('the hip dip height slider moves the dip up and down', () => {
	const w = (h) => body.weights({ ...body.defaults(), hipDips: 1, hipDipHeight: h });
	assert.deepEqual(Object.keys(w(-1)).filter((k) => k.startsWith('hip-dips')), ['hip-dips-0-up']);
	assert.deepEqual(Object.keys(w(1)).filter((k) => k.startsWith('hip-dips')), ['hip-dips-4-up']);
	const mid = w(0.25);
	assert.ok(mid['hip-dips-2-up'] > 0 && mid['hip-dips-3-up'] > 0);
	for (let n = 0; n < 5; n++) assert.ok(human.morphs[`hip-dips-${n}-up`]?.idx.length > 20, `dip ${n} missing`);
	assert.equal(Object.keys(body.weights({ ...body.defaults(), hipDipHeight: 0.5 })).filter((k) => k.startsWith('hip-dips')).length, 0);
});
