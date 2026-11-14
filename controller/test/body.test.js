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
	for (const s of body.SLIDERS) if (!['height', 'armPose', 'stance', 'hipDipHeight', 'fupaHeight'].includes(s.key)) {
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

test('any mix of slider values, including extremes and junk, gives a sound figure', () => {
	let seed = 12345;
	const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
	const keys = body.SLIDERS.map((s) => s.key);
	const cases = [];
	for (const base of ['female', 'male']) {
		cases.push(Object.fromEntries(body.SLIDERS.map((s) => [s.key, s.max])), Object.fromEntries(body.SLIDERS.map((s) => [s.key, s.min])));
		for (let i = 0; i < 40; i++) cases.push({ base, headShape: Object.keys(body.HEAD_SHAPES)[i % 6], ...Object.fromEntries(body.SLIDERS.map((s) => [s.key, s.min + rnd() * (s.max - s.min)])) });
		for (const name of Object.keys(body.PRESETS[base])) cases.push({ ...body.defaults(base), ...body.PRESETS[base][name] });
	}
	for (const name of Object.keys(body.BREAST_TYPES)) cases.push(body.applyType(body.defaults(), 'breast', name));
	for (const name of Object.keys(body.BUTT_TYPES)) cases.push(body.applyType(body.defaults(), 'butt', name));
	cases.push(body.applyType(body.defaults(), 'butt', 'no such type'));
	for (const raw of cases) {
		const v = body.migrate({ version: 2, ...raw });
		const p = body.shapeBody(v);
		assert.ok(p.every(Number.isFinite), `non-finite position for ${JSON.stringify(raw).slice(0, 80)}`);
		const fine = body.subdivide(p);
		assert.ok(fine.every(Number.isFinite));
		const n = body.baseNormals(p);
		assert.ok(n.every(Number.isFinite));
		let top = 0, bottom = Infinity;
		for (let i = 0; i < human.eyes[0][0]; i++) { top = Math.max(top, p[i * 3 + 1]); bottom = Math.min(bottom, p[i * 3 + 1]); }
		assert.ok(Math.abs(bottom) < 1e-3, 'stands on the floor');
		assert.ok(top >= v.height * 0.9 && top <= v.height * 1.1, `height ${top} for ${v.height}`);
	}
	// junk in saved values is ignored
	for (const junk of [{ height: 'tall', bust: NaN, glutes: Infinity, waist: '0.5', base: 'robot', headShape: 'cube' }, 42, 'text', [], { version: 2, weight: 1e9, hipDipHeight: -1e9 }]) {
		const v = body.migrate(junk);
		for (const s of body.SLIDERS) assert.ok(Number.isFinite(v[s.key]) && v[s.key] >= s.min && v[s.key] <= s.max, `${s.key}=${v[s.key]}`);
		assert.ok(body.shapeBody(v).every(Number.isFinite));
	}
	assert.equal(keys.length, new Set(keys).size, 'slider keys are unique');
});

test('waist-to-chest length makes the figure taller or shorter; width and belly button move their region', () => {
	const tall = (v) => { const p = body.shapeBody(v); let t = 0; for (let i = 0; i < human.eyes[0][0]; i++) t = Math.max(t, p[i * 3 + 1]); return t; };
	const base = tall(body.defaults());
	assert.ok(tall({ ...body.defaults(), waistLength: 1.5 }) > base + 5, 'longer');
	assert.ok(tall({ ...body.defaults(), waistLength: -1 }) < base - 3, 'shorter');
	for (const key of ['midWidth', 'navelHeight', 'fupaHeight', 'hipDipHeight']) assert.ok(body.SLIDERS.some((s) => s.key === key), key);
	const w = body.weights({ ...body.defaults(), fupa: 1, fupaHeight: 0.5 });
	assert.ok(w['fupa-3-up'] > 0);
	for (let n = 0; n < 5; n++) assert.ok(human.morphs[`fupa-${n}-up`]?.idx.length > 10, `fupa ${n}`);
});

test('arm poses: a hand on the hip or behind the head, each arm on its own; kept in saved bodies', () => {
	const marker = (p, [start, count]) => { let x = 0, y = 0, z = 0; for (let i = start; i < start + count; i++) { x += p[i * 3]; y += p[i * 3 + 1]; z += p[i * 3 + 2]; } return [x / count, y / count, z / count]; };
	const p = body.shapeBody({ ...body.defaults(), armL: 'hip', armR: 'head' });
	const top = Math.max(...Array.from({ length: human.eyes[0][0] }, (_, i) => p[i * 3 + 1]));
	const hipWrist = marker(p, human.markers['wrist.L']), headWrist = marker(p, human.markers['wrist.R']);
	assert.ok(hipWrist[1] > top * 0.5 && hipWrist[1] < top * 0.65, `hand on hip at ${(hipWrist[1] / top).toFixed(2)} of height`);
	assert.ok(headWrist[1] > top * 0.85, `hand behind head at ${(headWrist[1] / top).toFixed(2)} of height`);
	const eye = marker(p, human.eyes[0]);
	assert.ok(headWrist[2] < eye[2] - 3, 'the hand is behind the face');
	assert.ok(p.every(Number.isFinite));
	const v = body.migrate({ version: 2, base: 'female', armL: 'hip', armR: 'nonsense' });
	assert.deepEqual([v.armL, v.armR], ['hip', 'down']);
});

// ---------- Pose mode ----------

const pts = (v) => body.createPoser(v).points(v.pose);
const posed = (pose) => ({ ...body.defaults(), posing: true, pose });

test('Pose mode off draws the body exactly as before; on, the default pose stands on the floor at full height', () => {
	const v = body.defaults();
	assert.deepEqual(body.shapeBody({ ...v, posing: false, pose: body.POSE_PRESETS.Running }), body.shapeBody(v));
	const e = extent(body.shapeBody({ ...v, posing: true }), skin());
	assert.ok(Math.abs(e.lo) < 0.01, 'stands on the floor');
	assert.ok(Math.abs(e.hi - v.height) < 2, `height ${e.hi}`);
});

test('every preset poses cleanly: finite, on the floor, limits respected', () => {
	for (const [name, pose] of Object.entries(body.POSE_PRESETS)) {
		assert.deepEqual(body.cleanPose(pose), pose, `${name} is within limits`);
		const p = body.shapeBody(posed(pose));
		assert.ok(p.every(Number.isFinite), `${name} finite`);
		assert.ok(Math.abs(extent(p, skin()).lo) < 0.01, `${name} on the floor`);
	}
	const sit = extent(body.shapeBody(posed(body.POSE_PRESETS['Sitting (chair)'])), skin()).hi;
	const lie = extent(body.shapeBody(posed(body.POSE_PRESETS['Lying on back'])), skin()).hi;
	assert.ok(sit < 140 && sit > 100, `sitting height ${sit}`);
	assert.ok(lie < 45, `lying height ${lie}`);
});

test('joint axes move the body the way their meanings say (her left is +x, her front +z)', () => {
	const base = pts(posed({}));
	const at = (pose, k) => pts(posed(pose))[k];
	assert.ok(at({ 'upperArm.L': { lift: 90 } }, 'hand.L')[0] > base['hand.L'][0] + 40, 'lift raises her left arm out to her left');
	assert.ok(at({ 'upperArm.R': { lift: 90 } }, 'hand.R')[0] < base['hand.R'][0] - 40, 'and her right arm to her right');
	assert.ok(at({ 'upperArm.L': { lift: 90, toward: 90 } }, 'hand.L')[2] > base['hand.L'][2] + 40, 'toward 90 is forward');
	assert.ok(at({ 'forearm.L': { bend: 90 } }, 'hand.L')[2] > base['hand.L'][2] + 15, 'the elbow bends forward');
	assert.ok(at({ 'thigh.L': { forward: 90 } }, 'knee.L')[2] > base['knee.L'][2] + 30, 'the thigh lifts forward');
	assert.ok(at({ 'shin.L': { bend: 90 }, 'thigh.R': {} }, 'foot.L')[2] < base['foot.L'][2] - 25, 'the knee bends back');
	assert.ok(at({ head: { turn: 45 } }, 'head')[0] > -5, 'head turn stays on the neck');
	assert.ok(at({ waist: { lean: 20 } }, 'head')[0] > base.head[0] + 10, 'lean + goes to her left');
});

test('cleaning and mirroring poses', () => {
	assert.deepEqual(body.cleanPose({ 'shin.L': { bend: 999, nonsense: 3 }, nope: { a: 1 }, 'forearm.R': { bend: 'x' } }), { 'shin.L': { bend: 155 } });
	assert.deepEqual(body.mirrorPose({ 'upperArm.L': { lift: 50 }, head: { turn: 20, bend: 5 } }), { 'upperArm.R': { lift: 50 }, head: { bend: 5, turn: -20 } });
	const v = body.migrate({ version: 2, posing: true, pose: { 'shin.L': { bend: 40 } } });
	assert.equal(v.posing, true);
	assert.deepEqual(v.pose, { 'shin.L': { bend: 40 } });
	assert.equal(body.migrate({ version: 2 }).posing, false);
});

test('dragging a point: the hand reaches a target, planted feet stay put when the hips drop', () => {
	const v = posed(body.DEFAULT_POSE);
	const P = body.createPoser(v);
	const goal = [-25, 175, -5];
	let pose = v.pose;
	for (let i = 0; i < 3; i++) pose = P.solve(pose, { 'hand.R': goal }, { iterations: 30, floor: P.floor(v.pose) });
	const hand = P.points(pose, P.floor(v.pose))['hand.R'];
	assert.ok(Math.hypot(hand[0] - goal[0], hand[1] - goal[1], hand[2] - goal[2]) < 3, `hand at ${hand}`);
	for (const part of Object.keys(pose)) for (const [axis, x] of Object.entries(pose[part])) {
		const spec = body.POSE_PARTS.find((p) => p.key === part).axes.find((a) => a.key === axis);
		assert.ok(x >= spec.min && x <= spec.max, `${part}.${axis} within limits`);
	}
	const floor = P.floor(v.pose), pins = P.pins(v.pose), before = P.points(v.pose, floor);
	let crouch = v.pose;
	for (let i = 0; i < 4; i++) crouch = P.solve(crouch, { hips: [before.hips[0], before.hips[1] - 25, before.hips[2]] }, { iterations: 30, floor, pins, anchor: v.pose });
	const after = P.points(crouch, floor);
	assert.ok(after.hips[1] < before.hips[1] - 15, 'hips went down');
	assert.ok((crouch['shin.L']?.bend || 0) > 20, 'knees bent');
	for (const f of ['foot.L', 'foot.R']) assert.ok(Math.hypot(...after[f].map((x, k) => x - before[f][k])) < 2.5, `${f} stayed planted`);
});

test('joint correctives: nothing changes at rest, and fewer triangles are crushed at bent joints', () => {
	if (!human.rig) return; // a model without the rig: nothing to correct
	const skin = human.eyes[0][0];
	const idx = human.index;
	const restP = body.shapeBody({ ...body.defaults(), posing: true, pose: {} });
	const area = (p, t) => { const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3; const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]]; return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]); };
	const crushed = (p) => { let n = 0; for (let t = 0; t < idx.length; t += 3) { if (idx[t] >= skin || idx[t + 1] >= skin || idx[t + 2] >= skin) continue; const r = area(restP, t); if (r > 1e-6 && area(p, t) < 0.3 * r) n++; } return n; };
	// at rest the correctives do nothing
	const off = body.shapeBody({ ...body.defaults(), posing: true, pose: {}, correctives: false });
	assert.ok(restP.every((x, i) => Math.abs(x - off[i]) < 1e-6), 'no change at rest');
	const cases = {
		'deep squat': { 'thigh.L': { forward: 130 }, 'thigh.R': { forward: 130 }, 'shin.L': { bend: 150 }, 'shin.R': { bend: 150 } },
		'knee 155': { 'shin.L': { bend: 155 } },
		'elbow 150': { 'forearm.L': { bend: 150 } }
	};
	for (const [name, pose] of Object.entries(cases)) {
		const plain = crushed(body.shapeBody({ ...body.defaults(), posing: true, pose, correctives: false }));
		const fixed = body.shapeBody({ ...body.defaults(), posing: true, pose });
		assert.ok(fixed.every(Number.isFinite), `${name}: finite`);
		const after = crushed(fixed);
		assert.ok(after < plain || plain === 0, `${name}: crushed ${plain} -> ${after}`);
	}
});
