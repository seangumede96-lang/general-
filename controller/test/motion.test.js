import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as body from '../public/body.js';
import { rigFrames, effectorAt, POSE_PRESETS } from '../public/pose.js';
import { trackPeople, cleanTrack, retarget, addRootMotion, buildMotion, toBVH, rotations, LM, SKELETON, describe, poseFromLandmarks } from '../public/motion.js';

// Synthetic "video": MediaPipe-style points made from known poses of the figure itself, so the
// right answer is known. Real footage is checked by the owner; no frames are looked at here.
let poser, rest, upc;
before(async () => {
	await body.loadHuman(undefined, (url) => readFile(url));
	poser = body.createPoser(body.defaults('female'));
	rest = poser.rest;
	upc = 1 / (rest.piv[0][1] > 0 ? 1 : 1) * 0; // replaced below
	// Units per cm, from the poser: toUnits([1,0,0]) - toUnits([0,0,0]).
	upc = poser.toUnits([1, 0, 0], 0)[0] - poser.toUnits([0, 0, 0], 0)[0];
});

/** MediaPipe-like points for a pose: world (metres, around the hips, MediaPipe axes) and image. */
function landmarks(pose, { offsetCm = [0, 0, 0], hide = [] } = {}) {
	const f = rigFrames(rest, pose, upc);
	const E = (n) => effectorAt(rest, f, n);
	const P = (i) => f.pp[rest.names.indexOf(i)];
	const pts = new Array(33).fill(null);
	const head = E('head');
	const put = (name, p) => { pts[LM[name]] = p; };
	for (const s of ['L', 'R']) {
		put(`shoulder${s}`, E(`shoulder.${s}`)); put(`elbow${s}`, E(`elbow.${s}`)); put(`wrist${s}`, E(`hand.${s}`));
		put(`hip${s}`, P(`thigh.${s}`)); put(`knee${s}`, E(`knee.${s}`)); put(`ankle${s}`, E(`foot.${s}`)); put(`toe${s}`, E(`toe.${s}`)); put(`heel${s}`, E(`foot.${s}`));
	}
	put('nose', [head[0], head[1], head[2] + 1]); put('earL', [head[0] + 0.7, head[1], head[2]]); put('earR', [head[0] - 0.7, head[1], head[2]]);
	const hm = pts[LM.hipL].map((x, k) => (x + pts[LM.hipR][k]) / 2);
	const world = pts.map((p, j) => {
		if (!p) return { x: 0, y: 0, z: 0, visibility: 0 };
		const m = p.map((x, k) => (x - hm[k]) / upc / 100);
		return { x: m[0], y: -m[1], z: -m[2], visibility: hide.includes(j) ? 0.05 : 0.98 };
	});
	// A camera 4 m away with a 1200 px focal length (as the app assumes), 1000 x 1000 image.
	const image = pts.map((p, j) => {
		if (!p) return { x: 0, y: 0, visibility: 0 };
		const cm = p.map((x, k) => x / upc + offsetCm[k]);
		const z = 400 - cm[2];
		return { x: 0.5 + 1.2 * cm[0] / z, y: 0.5 - 1.2 * (cm[1] - 100) / z, visibility: world[j].visibility };
	});
	return { image, world };
}
const err = (a, b) => {
	const fa = rigFrames(rest, a, upc), fb = rigFrames(rest, b, upc);
	const names = ['hand.L', 'hand.R', 'elbow.L', 'elbow.R', 'knee.L', 'knee.R', 'foot.L', 'foot.R', 'head'];
	const h = (f) => f.pp[0];
	return Math.max(...names.map((n) => { const x = effectorAt(rest, fa, n), y = effectorAt(rest, fb, n); const ha = h(fa), hb = h(fb); return Math.hypot(...x.map((v, k) => (v - ha[k]) - (y[k] - hb[k]))) / upc; }));
};

test('canonical skeleton: 19 joints, a single root, Mixamo names', () => {
	assert.equal(SKELETON.joints.length, 19);
	assert.equal(SKELETON.joints.filter((j) => !j.parent).length, 1);
	assert.equal(SKELETON.joints.find((j) => j.name === 'forearm.R').mixamo, 'mixamorig:RightForeArm');
	assert.deepEqual(rest.names.slice().sort(), SKELETON.joints.map((j) => j.name).sort(), 'the same parts as the body figure');
});

test('poses are recovered from their own points within a few centimetres', () => {
	for (const name of ['Standing', 'Walking', 'Waving', 'Arms up', 'Hands on hips', 'Running', 'Sitting (chair)']) {
		const target = POSE_PRESETS[name];
		const frames = Array.from({ length: 4 }, (_, i) => ({ t: i / 10, poses: [landmarks(target)] }));
		const [track] = trackPeople(frames);
		for (const size of [null, 1000]) {
			// From the 3D points only, and with the on-screen points projected back through the lens.
			const out = retarget(rest, upc, cleanTrack(track, { fps: 10 }), { iterations: 25, width: size, height: size });
			const e = err(out.frames.at(-1).pose, target);
			assert.ok(e < 6, `${name}${size ? ' (screen points)' : ''}: worst point ${e.toFixed(1)} cm off`);
		}
	}
});

test('a point not seen is not made up: the part keeps its last angles and is marked unsure', () => {
	const walk = POSE_PRESETS.Walking;
	const frames = Array.from({ length: 30 }, (_, i) => ({ t: i / 10, poses: [landmarks(i < 5 ? POSE_PRESETS.Standing : walk, { hide: i >= 5 ? [LM.kneeL, LM.ankleL, LM.toeL, LM.heelL] : [] })] }));
	const clean = cleanTrack(trackPeople(frames)[0], { fps: 10 });
	const out = retarget(rest, upc, clean);
	const last = out.frames.at(-1);
	assert.ok(last.conf['shin.L'] < 0.5);
	assert.ok(last.conf['shin.R'] > 0.9);
	assert.ok(Math.abs((last.pose['thigh.L']?.forward || 0) - (out.frames[4].pose['thigh.L']?.forward || 0)) < 3, 'the hidden leg stays as it was');
	assert.ok((last.pose['thigh.R']?.forward || 0) < -5, `the seen leg follows the video: ${JSON.stringify(last.pose)}`);
	const m = buildMotion({ name: 't', source: {}, fps: 10, track: { id: 1 }, motion: out });
	assert.ok(m.quality.legs.seen < 0.8);
});

test('two people are kept apart and get their own tracks', () => {
	const a = landmarks(POSE_PRESETS.Standing, { offsetCm: [-80, 0, 0] }), b = landmarks(POSE_PRESETS['Arms up'], { offsetCm: [80, 0, 0] });
	// The detector lists them in either order from frame to frame.
	const frames = Array.from({ length: 20 }, (_, i) => ({ t: i / 10, poses: i % 3 ? [a, b] : [b, a] }));
	const tracks = trackPeople(frames);
	assert.equal(tracks.length, 2);
	for (const tr of tracks) {
		const lifts = tr.frames.map((f) => f.image[LM.wristL].y < f.image[LM.shoulderL].y);
		assert.ok(lifts.every((x) => x === lifts[0]), 'each track is always the same person');
	}
});

test('root motion: walking towards the camera and across, with the feet kept on the floor', () => {
	const frames = Array.from({ length: 30 }, (_, i) => ({ t: i / 10, poses: [landmarks(POSE_PRESETS.Standing, { offsetCm: [i * 4, 0, i * 5] })] }));
	const clean = cleanTrack(trackPeople(frames)[0], { fps: 10 });
	const m = addRootMotion(retarget(rest, upc, clean), clean, { width: 1000, height: 1000, footHeight: (pose) => 0 * pose });
	const end = m.frames.at(-1).root, start = m.frames[0].root;
	assert.ok(Math.abs(end[0] - start[0] - 116) < 30, `across ${end[0] - start[0]} cm (true 116)`);
	assert.ok(Math.abs(end[2] - start[2] - 145) < 40, `towards the camera ${end[2] - start[2]} cm (true 145)`);
	assert.match(describe({ fps: 10, frames: m.frames }).join(' '), /Root travels about \d+ cm/);
});

test('BVH: the hierarchy has every joint, and each frame has the right number of values', () => {
	const frames = Array.from({ length: 5 }, (_, i) => ({ t: i / 10, pose: i % 2 ? POSE_PRESETS.Walking : POSE_PRESETS.Standing, root: [i, 0, 0], conf: {} }));
	const bvh = toBVH(rest, upc, { fps: 10, frames });
	assert.equal((bvh.match(/^\s*(ROOT|JOINT) /gm) || []).length, 19);
	assert.match(bvh, /Frames: 5\nFrame Time: 0\.100000/);
	const rows = bvh.trim().split('\n').slice(-5);
	assert.ok(rows.every((r) => r.trim().split(' ').length === 6 + 18 * 3));
	const q = rotations(rest, upc, POSE_PRESETS.Waving);
	assert.ok(Object.values(q).every((v) => Math.abs(Math.hypot(...v) - 1) < 1e-3), 'unit quaternions');
});

test('a pose from one picture: every limb within a few centimetres, a body part not seen is listed', () => {
	for (const name of ['Hands on hips', 'Waving', 'Kneeling', 'Arms crossed', 'Crouching']) {
		const lm = landmarks(POSE_PRESETS[name]);
		const fit = poseFromLandmarks(rest, upc, { ...lm, width: 1000, height: 1000 });
		const e = err(fit.pose, POSE_PRESETS[name]);
		assert.ok(e < 6, `${name}: worst point ${e.toFixed(1)} cm off`);
		assert.deepEqual(fit.unseen, []);
	}
	const hidden = landmarks(POSE_PRESETS.Waving, { hide: [LM.kneeL, LM.ankleL, LM.toeL, LM.heelL] });
	assert.ok(poseFromLandmarks(rest, upc, { ...hidden, width: 1000, height: 1000 }).unseen.includes('shin.L'));
});
