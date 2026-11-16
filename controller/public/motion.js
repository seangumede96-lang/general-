// Motion: the shared animation format and the maths that fills it from a video, all in plain
// JavaScript so it runs on the phone (browser) and in tests (Node) alike.
//
//   video frames -> MediaPipe Pose Landmarker (33 points per person, motion-video.js)
//     -> people kept apart from frame to frame (track IDs)
//     -> gaps filled, jitter smoothed, uncertain points marked
//     -> retargeted onto the body figure's skeleton (pose.js: 19 parts, human joint limits)
//     -> root motion (across the floor, and kept on the floor by the feet)
//     -> motion/1 JSON: the same format the language translator will write later
//     -> BVH (and FBX through Blender) for other programs
//
// The format keeps joint angles in the body figure's own terms (pose.js parts and axes, degrees),
// so a motion fits any body shape made in the editor, plus local joint rotations (quaternions)
// on the canonical skeleton below, so other tools need nothing from this app.

import { rigFrames, effectorAt, solveRig, cleanPose, DEFAULT_POSE } from './pose.js';

export const FORMAT = 'motion/1';
export const SKELETON_ID = 'assistant-human/1';
export const DEFAULT_FPS = 10;
export const MAX_FPS = 15;
/** A point counts as seen at or above this MediaPipe visibility. */
export const SEEN = 0.5;
/** Gaps up to this many seconds are filled by interpolation; longer ones stay "not seen". */
export const MAX_GAP_S = 1;

/**
 * The canonical skeleton: the body figure's 19 parts, with names other programs use.
 * `mixamo` names let Blender and most game tools retarget to Mixamo-style rigs.
 */
export const SKELETON = {
	id: SKELETON_ID,
	joints: [
		['hips', null, 'Hips'], ['waist', 'hips', 'Spine'], ['chest', 'waist', 'Spine2'], ['neck', 'chest', 'Neck'], ['head', 'neck', 'Head'],
		...['L', 'R'].flatMap((s) => {
			const side = s === 'L' ? 'Left' : 'Right';
			return [[`clavicle.${s}`, 'chest', `${side}Shoulder`], [`upperArm.${s}`, `clavicle.${s}`, `${side}Arm`], [`forearm.${s}`, `upperArm.${s}`, `${side}ForeArm`], [`hand.${s}`, `forearm.${s}`, `${side}Hand`],
				[`thigh.${s}`, 'hips', `${side}UpLeg`], [`shin.${s}`, `thigh.${s}`, `${side}Leg`], [`foot.${s}`, `shin.${s}`, `${side}Foot`]];
		})
	].map(([name, parent, mixamo]) => ({ name, parent, mixamo: `mixamorig:${mixamo}` }))
};

// ---------- MediaPipe's 33 points ----------

export const LM = { nose: 0, earL: 7, earR: 8, shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16, hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankleL: 27, ankleR: 28, heelL: 29, heelR: 30, toeL: 31, toeR: 32 };

/**
 * MediaPipe's world points (metres, origin between the hips, x to the image's right, y down,
 * z away from the camera) in the figure's axes (+x her left, +y up, +z her front, for someone
 * facing the camera). MediaPipe names points by the person's own left and right, so they match.
 */
export const toModel = (p) => [p.x, -p.y, -p.z];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const D = 180 / Math.PI;

// ---------- 1. keeping people apart ----------

/**
 * Give each detected person a track ID, frame to frame, by where their hips are on screen and
 * how big they are. frames: [{ t, poses: [{ image: [{x,y,visibility}...33], world: [...33] }] }].
 * Returns tracks: [{ id, frames: [{ t, image, world } | null per input frame] }], longest first,
 * keeping only people seen in at least `minShare` of the frames.
 */
export function trackPeople(frames, { minShare = 0.3, maxJump = 0.25 } = {}) {
	const tracks = [];
	const centre = (img) => { const a = img[LM.hipL], b = img[LM.hipR]; return [(a.x + b.x) / 2, (a.y + b.y) / 2]; };
	const size = (img) => Math.hypot((img[LM.shoulderL].x + img[LM.shoulderR].x - img[LM.hipL].x - img[LM.hipR].x) / 2, (img[LM.shoulderL].y + img[LM.shoulderR].y - img[LM.hipL].y - img[LM.hipR].y) / 2);
	frames.forEach((fr, i) => {
		const free = new Set(fr.poses.map((_, k) => k));
		// Match the closest pairs first, so two people passing each other keep their own IDs.
		const pairs = [];
		for (const tr of tracks) {
			if (!tr.last || i - tr.lastIndex > 15) continue;
			fr.poses.forEach((p, k) => {
				const c = centre(p.image), d = Math.hypot(c[0] - tr.last.c[0], c[1] - tr.last.c[1]);
				const s = Math.abs(size(p.image) - tr.last.s) / Math.max(tr.last.s, 1e-3);
				pairs.push({ tr, k, cost: d + 0.1 * s });
			});
		}
		pairs.sort((a, b) => a.cost - b.cost);
		const used = new Set();
		for (const { tr, k, cost } of pairs) {
			if (used.has(tr) || !free.has(k) || cost > maxJump * (1 + (i - tr.lastIndex - 1) * 0.3)) continue;
			used.add(tr); free.delete(k);
			put(tr, i, fr, fr.poses[k]);
		}
		for (const k of free) { const tr = { id: tracks.length + 1, frames: new Array(frames.length).fill(null) }; tracks.push(tr); put(tr, i, fr, fr.poses[k]); }
	});
	function put(tr, i, fr, p) { tr.frames[i] = { t: fr.t, image: p.image, world: p.world }; tr.last = { c: centre(p.image), s: size(p.image) }; tr.lastIndex = i; }
	const n = frames.length;
	return tracks.map(({ id, frames: f }) => ({ id, frames: f, seen: f.filter(Boolean).length }))
		.filter((t) => t.seen >= Math.max(3, minShare * n))
		.sort((a, b) => b.seen - a.seen)
		.map((t, i) => ({ id: i + 1, frames: t.frames, seen: t.seen }));
}

// ---------- 2. filling gaps and smoothing ----------

/**
 * One person's points over time, cleaned: each point is filled across short gaps (up to
 * MAX_GAP_S) by straight-line interpolation, then smoothed without lag (a small Gaussian,
 * fine because the whole clip is known). Points not seen for longer stay null, so nothing is
 * made up for them. Returns [{ t, world: [[x,y,z]|null x33] (figure axes, metres),
 * vis: [0..1 x33], image: [[x,y]|null x33] }].
 */
export function cleanTrack(track, { fps = DEFAULT_FPS, sigma = 1 } = {}) {
	const n = track.frames.length, maxGap = Math.round(MAX_GAP_S * fps);
	const out = track.frames.map((f, i) => ({ t: f?.t ?? i / fps, world: new Array(33).fill(null), vis: new Array(33).fill(0), image: new Array(33).fill(null) }));
	for (let j = 0; j < 33; j++) {
		const seen = track.frames.map((f) => (f && (f.world[j].visibility ?? f.image[j].visibility ?? 1) >= SEEN ? f : null));
		const w = seen.map((f) => (f ? toModel(f.world[j]) : null));
		const im = seen.map((f) => (f ? [f.image[j].x, f.image[j].y] : null));
		const v = track.frames.map((f) => (f ? f.world[j].visibility ?? f.image[j].visibility ?? 1 : 0));
		// Fill short gaps.
		let last = -1;
		for (let i = 0; i < n; i++) {
			if (!w[i]) continue;
			if (last >= 0 && i - last > 1 && i - last - 1 <= maxGap) {
				for (let k = last + 1; k < i; k++) {
					const a = (k - last) / (i - last);
					w[k] = w[last].map((x, c) => x + (w[i][c] - x) * a);
					im[k] = im[last].map((x, c) => x + (im[i][c] - x) * a);
					v[k] = Math.min(v[last], v[i]) * 0.8; // filled in: a little less sure
				}
			}
			last = i;
		}
		// Smooth runs of known values.
		const r = Math.ceil(sigma * 2);
		const kern = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-((k - r) ** 2) / (2 * sigma * sigma)));
		for (let i = 0; i < n; i++) {
			if (!w[i]) continue;
			const acc = [0, 0, 0], acc2 = [0, 0];
			let tot = 0;
			for (let k = -r; k <= r; k++) {
				const q = w[i + k];
				if (!q) continue;
				const g = kern[k + r];
				acc[0] += q[0] * g; acc[1] += q[1] * g; acc[2] += q[2] * g;
				acc2[0] += im[i + k][0] * g; acc2[1] += im[i + k][1] * g;
				tot += g;
			}
			out[i].world[j] = acc.map((x) => x / tot);
			out[i].image[j] = acc2.map((x) => x / tot);
			out[i].vis[j] = v[i];
		}
	}
	return out;
}

// ---------- 3. onto the figure's skeleton ----------

/** Which MediaPipe points each body part depends on: its confidence is the least sure of them. */
const PART_POINTS = {
	hips: ['hipL', 'hipR'], waist: ['hipL', 'hipR', 'shoulderL', 'shoulderR'], chest: ['shoulderL', 'shoulderR'], neck: ['shoulderL', 'shoulderR', 'nose'], head: ['nose', 'earL', 'earR'],
	...Object.fromEntries(['L', 'R'].flatMap((s) => [
		[`clavicle.${s}`, [`shoulder${s}`]], [`upperArm.${s}`, [`shoulder${s}`, `elbow${s}`]], [`forearm.${s}`, [`elbow${s}`, `wrist${s}`]], [`hand.${s}`, [`wrist${s}`]],
		[`thigh.${s}`, [`hip${s}`, `knee${s}`]], [`shin.${s}`, [`knee${s}`, `ankle${s}`]], [`foot.${s}`, [`ankle${s}`, `toe${s}`]]
	]))
};

/** Turn = about up, lean = sideways, bend = forward: the hips' local rotation Ry(turn)·Rz(−lean)·Rx(bend). */
function hipsAngles(right, up) {
	// Columns of the pelvis frame in the figure's axes: x = her left, y = up, z = her front.
	const x = unit(right), z = unit(cross(x, up)), y = cross(z, x);
	// R = [x y z] as columns; read R10, R00, R20, R11, R12 (row, column).
	const R = (r, c) => [x, y, z][c][r];
	const b = Math.asin(Math.max(-1, Math.min(1, R(1, 0))));
	return { turn: Math.atan2(-R(2, 0), R(0, 0)) * D, lean: -b * D, bend: Math.atan2(-R(1, 2), R(1, 1)) * D };
}

/**
 * Retarget one cleaned person onto the figure's skeleton: `rest` and `upc` (units per cm) from
 * createPoser(body). Limb and torso directions come from the video; lengths are the figure's own,
 * so the motion fits whatever body it is played on. Joint limits apply (pose.js), and a part whose
 * points were not seen keeps its last angles and gets a low confidence instead of a guess.
 * Returns { frames: [{ t, pose, conf: { part: 0..1 } }] }.
 */
export function retarget(rest, upc, clean, opts = {}) {
	const step = createRetargeter(rest, upc, opts);
	return { frames: clean.map(step) };
}

/** The same, a little at a time, so a phone's screen stays responsive: onProgress(done, total). */
export async function retargetAsync(rest, upc, clean, { onProgress, chunk = 5, ...opts } = {}) {
	const step = createRetargeter(rest, upc, opts);
	const frames = [];
	for (let i = 0; i < clean.length; i++) {
		frames.push(step(clean[i]));
		if (i % chunk === chunk - 1) { onProgress?.(i + 1, clean.length); await new Promise((r) => setTimeout(r, 0)); }
	}
	onProgress?.(clean.length, clean.length);
	return { frames };
}

/** One frame at a time: returns step(cleanFrame) -> { t, pose, conf }, remembering the last frame. */
export function createRetargeter(rest, upc, { iterations = 10, width = null, height = null } = {}) {
	// MediaPipe's on-screen points are more precise than its 3D ones, whose depth is a guess. With
	// the picture's size known, each point is projected back through a phone camera's usual lens
	// (focal length 1.2 x the long side, as for root motion): its place on screen gives up/down and
	// across, its 3D depth (relative to the hips) only the distance from the camera.
	let hybrid = null;
	const at = (f, name) => (hybrid?.[LM[name]]) || f.world[LM[name]];
	const focal = width && height ? 1.2 * Math.max(width, height) : 0;
	const makeHybrid = (f) => {
		hybrid = null;
		if (!focal) return;
		const im = f.image, w = f.world, need = [LM.hipL, LM.hipR, LM.shoulderL, LM.shoulderR];
		if (!need.every((j) => im[j] && w[j])) return;
		// Pixels, from the centre of the picture, y up.
		const P = (j) => [(im[j][0] - 0.5) * width, (0.5 - im[j][1]) * height];
		const mid2 = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
		const s2 = mid2(P(LM.shoulderL), P(LM.shoulderR)), h2 = mid2(P(LM.hipL), P(LM.hipR));
		const torsoPx = Math.hypot(s2[0] - h2[0], s2[1] - h2[1]);
		const t3 = sub(mid(w[LM.shoulderL], w[LM.shoulderR]), mid(w[LM.hipL], w[LM.hipR]));
		const inPlane = Math.hypot(t3[0], t3[1]);
		if (torsoPx < 1 || inPlane < 0.3 * len(t3)) return;
		const Z0 = focal * inPlane / torsoPx; // metres from the camera to the hips
		const back = (px, depth) => [px[0] * depth / focal, px[1] * depth / focal];
		const hip = back(h2, Z0);
		hybrid = w.map((p, j) => {
			if (!p || !im[j]) return null;
			const d = Z0 - p[2]; // the figure's +z points at the camera
			const q = back(P(j), d);
			return [q[0] - hip[0], q[1] - hip[1], p[2]];
		});
	};
	const ok = (f, ...names) => names.every((nm) => f.world[LM[nm]] && f.vis[LM[nm]] >= SEEN * 0.8);
	const conf = (f, part) => Math.min(...PART_POINTS[part].map((nm) => (f.world[LM[nm]] ? f.vis[LM[nm]] : 0)));
	// The figure's own lengths (model units), measured once on its rest skeleton.
	const r0 = rigFrames(rest, DEFAULT_POSE, upc);
	const E = (name) => effectorAt(rest, r0, name);
	const idx = (name) => rest.names.indexOf(name);
	const L = {
		torso: len(sub(mid(E('shoulder.L'), E('shoulder.R')), r0.pp[idx('hips')])),
		chest: len(sub(E('chest'), r0.pp[idx('hips')])),
		shoulders: len(sub(E('shoulder.L'), E('shoulder.R'))) / 2,
		head: len(sub(E('head'), mid(E('shoulder.L'), E('shoulder.R')))),
		upper: len(sub(E('elbow.L'), E('shoulder.L'))), fore: len(sub(E('hand.L'), E('elbow.L'))),
		thigh: len(sub(E('knee.L'), r0.pp[idx('thigh.L')])), shin: len(sub(E('foot.L'), E('knee.L'))), foot: len(sub(E('toe.L'), E('foot.L')))
	};
	let prev = cleanPose(DEFAULT_POSE);
	return (f) => {
		makeHybrid(f);
		let pose = structuredClone(prev);
		const c = Object.fromEntries(Object.keys(PART_POINTS).map((p) => [p, Math.round(conf(f, p) * 100) / 100]));
		if (ok(f, 'hipL', 'hipR', 'shoulderL', 'shoulderR')) {
			// The whole body's direction: which way it faces and leans from the hips and shoulders.
			const hm = mid(at(f, 'hipL'), at(f, 'hipR')), sm = mid(at(f, 'shoulderL'), at(f, 'shoulderR'));
			const h = hipsAngles(sub(at(f, 'hipL'), at(f, 'hipR')), sub(sm, hm));
			// Forward and back: a bend is shared between the hips and the spine, the way people bend.
			// With the torso pitched tt and the thighs pitched tl (both from the video, after facing
			// forward), the hips take (tt - tl) / 2: standing 0, bending over half, lying down all.
			const unturn = (v) => { const a = -h.turn / D, c = Math.cos(a), si = Math.sin(a); return [c * v[0] + si * v[2], v[1], -si * v[0] + c * v[2]]; };
			const u = unturn(sub(sm, hm));
			const tt = Math.atan2(u[2], u[1]) * D;
			const legs = ['L', 'R'].filter((s) => ok(f, `hip${s}`, `knee${s}`)).map((s) => { const d = unturn(sub(at(f, `knee${s}`), at(f, `hip${s}`))); return Math.atan2(d[2], -d[1]) * D; });
			const tl = legs.length ? legs.reduce((a, b) => a + b, 0) / legs.length : 0;
			pose.hips = { ...pose.hips, turn: h.turn, lean: h.lean * 0.5, bend: (tt - tl) / 2 };
			pose = cleanPose(pose);
			// Then the torso, neck and head bend to put shoulders, chest and head where the video has them.
			const f0 = rigFrames(rest, pose, upc);
			const H = f0.pp[idx('hips')];
			const up = unit(sub(sm, hm)), across = unit(sub(at(f, 'shoulderL'), at(f, 'shoulderR')));
			const shoulderMid = add(H, scale(up, L.torso));
			const goals = [
				{ effector: 'chest', target: add(H, scale(up, L.chest)) },
				{ effector: 'shoulder.L', target: add(shoulderMid, scale(across, L.shoulders)), weight: 0.7 },
				{ effector: 'shoulder.R', target: add(shoulderMid, scale(across, -L.shoulders)), weight: 0.7 }
			];
			if (ok(f, 'nose') && f.world[LM.earL] && f.world[LM.earR]) {
				const headDir = unit(sub(mid(at(f, 'earL'), at(f, 'earR')), sm));
				goals.push({ effector: 'head', target: add(shoulderMid, scale(headDir, L.head)), weight: 0.6 });
			}
			// The joints' stiffness pulls towards this frame's hips and the last frame's spine.
			pose = solveRig(rest, pose, goals, { feetPlanted: false, iterations, unitsPerCm: upc, anchor: { ...prev, hips: pose.hips } });
		}
		// Arms and legs: each segment's direction from the video, at the figure's own lengths.
		const f1 = rigFrames(rest, pose, upc);
		const limbGoals = [];
		for (const s of ['L', 'R']) {
			if (ok(f, `shoulder${s}`, `elbow${s}`)) {
				const sh = effectorAt(rest, f1, `shoulder.${s}`);
				const el = add(sh, scale(unit(sub(at(f, `elbow${s}`), at(f, `shoulder${s}`))), L.upper));
				limbGoals.push({ effector: `elbow.${s}`, target: el, weight: c[`upperArm.${s}`] });
				if (ok(f, `wrist${s}`)) limbGoals.push({ effector: `hand.${s}`, target: add(el, scale(unit(sub(at(f, `wrist${s}`), at(f, `elbow${s}`))), L.fore)), weight: c[`forearm.${s}`] });
			}
			if (ok(f, `hip${s}`, `knee${s}`)) {
				const hp = f1.pp[idx(`thigh.${s}`)];
				const kn = add(hp, scale(unit(sub(at(f, `knee${s}`), at(f, `hip${s}`))), L.thigh));
				limbGoals.push({ effector: `knee.${s}`, target: kn, weight: c[`thigh.${s}`] });
				if (ok(f, `ankle${s}`)) {
					const an = add(kn, scale(unit(sub(at(f, `ankle${s}`), at(f, `knee${s}`))), L.shin));
					limbGoals.push({ effector: `foot.${s}`, target: an, weight: c[`shin.${s}`] });
					if (ok(f, `toe${s}`)) limbGoals.push({ effector: `toe.${s}`, target: add(an, scale(unit(sub(at(f, `toe${s}`), at(f, `ankle${s}`))), L.foot)), weight: c[`foot.${s}`] * 0.7 });
				}
			}
		}
		if (limbGoals.length) pose = solveRig(rest, pose, limbGoals, { feetPlanted: false, iterations, unitsPerCm: upc, anchor: pose });
		prev = pose;
		return { t: Math.round(f.t * 1000) / 1000, pose, conf: c };
	};
}

// ---------- 4. root motion ----------

/**
 * Where the body goes: across the floor from the hips' place on screen (metres per pixel from
 * the person's own torso length), towards or away from the camera from how big they look, and
 * up and down from the feet (the lowest seen foot rests on the floor, so the body neither floats
 * nor sinks). Assumes the camera does not move. Adds root: [x, y, z] in cm to each frame and
 * hips.y (height change) to its pose. `floorOf(pose)` gives the lowest foot point, in cm above
 * the rest floor, for a pose (from the body).
 */
export function addRootMotion(motion, clean, { width = 1, height = 1, footHeight, sceneDepth = null } = {}) {
	// Torso length in pixels and in metres, per frame where it is seen.
	const px = [], m = [];
	clean.forEach((f, i) => {
		const w = f.world, im = f.image;
		if (![LM.hipL, LM.hipR, LM.shoulderL, LM.shoulderR].every((j) => w[j] && im[j])) return;
		const a = mid(im[LM.hipL], im[LM.hipR]), b = mid(im[LM.shoulderL], im[LM.shoulderR]);
		px[i] = Math.hypot((a[0] - b[0]) * width, (a[1] - b[1]) * height);
		m[i] = len(sub(mid(w[LM.hipL], w[LM.hipR]), mid(w[LM.shoulderL], w[LM.shoulderR])));
	});
	const known = px.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
	if (!known.length) { motion.frames.forEach((fr) => { fr.root = [0, 0, 0]; }); return motion; }
	const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
	const torsoM = median(known.map((i) => m[i]));
	const focal = 1.2 * Math.max(width, height); // a phone camera's usual field of view
	const first = known[0];
	const depth = (i) => focal * torsoM / px[i]; // metres from the camera
	const hipPx = (i) => { const im = clean[i].image; const c = mid(im[LM.hipL], im[LM.hipR]); return [c[0] * width, c[1] * height]; };
	// With sceneDepth (metres), everyone in the clip shares one origin: the point that far in front of
	// the camera, straight ahead. So people who interact keep their places relative to each other.
	// Without it, a person's motion starts at their own first position.
	const z0 = sceneDepth ?? depth(first), c0 = sceneDepth ? [width / 2, 0] : hipPx(first);
	// Frames before the person is first seen take their first known place (not the origin).
	let last = null;
	motion.frames.forEach((fr, i) => {
		if (px[i]) {
			const z = depth(i), c = hipPx(i);
			// Across: pixels to metres at this depth. Towards the camera is the figure's +z when it faces the camera.
			last = [(c[0] - c0[0]) * z / focal * 100, 0, (z0 - z) * 100];
		}
		fr.root = last ? last.map((x) => Math.round(x * 10) / 10) : null;
		fr.rootEstimated = true;
	});
	const firstRoot = motion.frames.find((fr) => fr.root)?.root || [0, 0, 0];
	for (const fr of motion.frames) { if (!fr.root) fr.root = [...firstRoot]; else break; }
	// Keep the feet on the floor where they are seen: lift or lower the hips by what it takes.
	if (footHeight) {
		const legsSeen = (i) => ['ankleL', 'ankleR'].some((n) => clean[i].world[LM[n]] && clean[i].vis[LM[n]] >= SEEN);
		let y = 0;
		motion.frames.forEach((fr, i) => {
			if (legsSeen(i)) y = -footHeight(fr.pose);
			fr.pose = cleanPose({ ...fr.pose, hips: { ...fr.pose.hips, y: Math.round(y * 10) / 10 } });
		});
	}
	// Short jitter in the estimate is smoothed out (root motion is the least certain number here).
	smoothRoot(motion.frames);
	return motion;
}
function smoothRoot(frames, r = 2) {
	const src = frames.map((f) => f.root);
	frames.forEach((f, i) => {
		const acc = [0, 0, 0]; let n = 0;
		for (let k = Math.max(0, i - r); k <= Math.min(frames.length - 1, i + r); k++) { acc[0] += src[k][0]; acc[1] += src[k][1]; acc[2] += src[k][2]; n++; }
		f.root = acc.map((x) => Math.round((x / n) * 10) / 10);
	});
}

// ---------- 5. the motion file ----------

/** One person's motion as a motion/1 record. */
export function buildMotion({ name, source, fps, track, motion, quality }) {
	const frames = motion.frames;
	return {
		format: FORMAT, skeleton: SKELETON_ID, name, created: new Date().toISOString(),
		fps, frameCount: frames.length, duration: frames.length ? Math.round((frames.at(-1).t - frames[0].t + 1 / fps) * 100) / 100 : 0,
		source, person: track.id,
		// Angles per frame in the figure's terms; root in cm (estimated from a single camera).
		frames: frames.map((f) => ({ t: f.t, root: f.root || [0, 0, 0], pose: f.pose, conf: f.conf })),
		quality: quality || summarise(frames),
		interpolation: 'linear',
		description: describe({ fps, frames })
	};
}

/** How sure the motion is, per body area, plus which areas were mostly not seen. */
export function summarise(frames) {
	const areas = { torso: ['hips', 'waist', 'chest'], head: ['head'], arms: ['upperArm.L', 'forearm.L', 'upperArm.R', 'forearm.R'], legs: ['thigh.L', 'shin.L', 'thigh.R', 'shin.R'], feet: ['foot.L', 'foot.R'] };
	const out = {};
	for (const [area, parts] of Object.entries(areas)) {
		const vals = frames.flatMap((f) => parts.map((p) => f.conf?.[p] ?? 0));
		const seen = vals.filter((v) => v >= SEEN).length / Math.max(1, vals.length);
		out[area] = { seen: Math.round(seen * 100) / 100, average: Math.round((vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length)) * 100) / 100 };
	}
	out.uncertain = Object.entries(out).filter(([, v]) => v.seen < 0.6).map(([k]) => k);
	return out;
}

/**
 * A technical description worked out from the numbers (no images are looked at): torso lean,
 * turning, knee and elbow bending, arm raises, travel, and when things change.
 */
export function describe({ fps, frames }) {
	if (!frames.length) return [];
	const get = (f, part, axis) => f.pose?.[part]?.[axis] || 0;
	const seen = (f, part) => (f.conf?.[part] ?? 1) >= SEEN;
	const series = (part, axis, fn = (x) => x) => frames.filter((f) => seen(f, part)).map((f) => fn(get(f, part, axis)));
	const range = (a) => (a.length ? [Math.min(...a), Math.max(...a)] : null);
	const at = (i) => `${(frames[i].t).toFixed(1)} s`;
	const out = [];
	const dur = frames.length / fps;
	out.push(`${dur.toFixed(1)} s at ${fps} frames per second, ${frames.length} frames.`);
	const bend = range(series('hips', 'bend').map((x, i) => x + get(frames[i], 'waist', 'bend') + get(frames[i], 'chest', 'bend')));
	if (bend) out.push(`Torso inclination ${Math.round(bend[0])}° to ${Math.round(bend[1])}° (forward +).`);
	const turn = range(series('hips', 'turn'));
	if (turn) out.push(`Body orientation ${Math.round(turn[0])}° to ${Math.round(turn[1])}° (towards her left +)${turn[1] - turn[0] > 60 ? ': turns during the clip' : ''}.`);
	for (const s of ['L', 'R']) {
		const side = s === 'L' ? 'left' : 'right';
		const k = range(series(`shin.${s}`, 'bend'));
		if (k) out.push(`${side[0].toUpperCase()}${side.slice(1)} knee flexion ${Math.round(k[0])}°–${Math.round(k[1])}°.`);
		const e = range(series(`forearm.${s}`, 'bend'));
		if (e) out.push(`${side[0].toUpperCase()}${side.slice(1)} elbow ${Math.round(e[0])}°–${Math.round(e[1])}°.`);
		const lift = series(`upperArm.${s}`, 'lift');
		const raised = frames.findIndex((f) => seen(f, `upperArm.${s}`) && get(f, `upperArm.${s}`, 'lift') > 120);
		if (raised >= 0) out.push(`${side[0].toUpperCase()}${side.slice(1)} arm raised overhead from ${at(raised)} (peak ${Math.round(Math.max(...lift))}°).`);
	}
	const low = frames.findIndex((f) => get(f, 'hips', 'y') < -25);
	if (low >= 0) out.push(`Body lowers by ${Math.round(-Math.min(...frames.map((f) => get(f, 'hips', 'y'))))} cm (crouch, kneel or sit) from ${at(low)}.`);
	const a = frames[0].root || [0, 0, 0], b = frames.at(-1).root || [0, 0, 0];
	const travel = Math.hypot(b[0] - a[0], b[2] - a[2]);
	if (travel > 30) out.push(`Root travels about ${Math.round(travel)} cm (${Math.abs(b[0] - a[0]) > Math.abs(b[2] - a[2]) ? (b[0] > a[0] ? "to the camera's right" : "to the camera's left") : (b[2] > a[2] ? 'towards the camera' : 'away from the camera')}), about ${Math.round(travel / dur)} cm/s; estimated from one camera.`);
	else out.push('Stays in place (root moves less than 30 cm).');
	return out;
}

// ---------- 6. BVH ----------

/** Rotation matrix (row-major 3x3) to BVH's Z, X, Y Euler angles in degrees: R = Rz·Rx·Ry. */
function eulerZXY(R) {
	const x = Math.asin(Math.max(-1, Math.min(1, R[7])));
	if (Math.abs(R[7]) < 0.99999) return [Math.atan2(-R[1], R[4]) * D, x * D, Math.atan2(-R[6], R[8]) * D];
	return [Math.atan2(R[3], R[0]) * D, x * D, 0];
}
const T = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
function mul(a, b) {
	const o = new Array(9);
	for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
	return o;
}

/**
 * The motion as a BVH file on the figure's skeleton (centimetres, Y up, the figure facing +Z).
 * The rest pose is the figure as modelled; every frame's rotations are relative to it, so the
 * skinned body in other programs moves exactly as it does in the app.
 */
export function toBVH(rest, upc, motion) {
	const names = rest.names, parents = rest.parents;
	const cm = (a) => a.map((x) => (x / upc).toFixed(3)).join(' ');
	const kids = names.map((_, i) => parents.map((p, j) => (p === i ? j : -1)).filter((j) => j >= 0));
	const tip = { head: 'head', 'hand.L': 'fingertip.L', 'hand.R': 'fingertip.R', 'foot.L': 'toe.L', 'foot.R': 'toe.R' };
	const lines = ['HIERARCHY'];
	const order = [];
	const bone = (i, depth) => {
		const pad = '\t'.repeat(depth);
		const name = names[i].replace('.', '_');
		const off = parents[i] < 0 ? rest.piv[i] : sub(rest.piv[i], rest.piv[parents[i]]);
		lines.push(`${pad}${parents[i] < 0 ? 'ROOT' : 'JOINT'} ${name}`, `${pad}{`, `${pad}\tOFFSET ${cm(off)}`,
			`${pad}\tCHANNELS ${parents[i] < 0 ? '6 Xposition Yposition Zposition' : '3'} Zrotation Xrotation Yrotation`);
		order.push(i);
		if (kids[i].length) for (const k of kids[i]) bone(k, depth + 1);
		else {
			// End sites: to the fingertip, toe or top of the head, measured on the rest body.
			// The head's effector is halfway to the top of the head, so the end is twice as far.
			const e = rest.effectors[tip[names[i]]]?.[1];
			const end = !e ? add(rest.piv[i], [0, -1, 0]) : names[i] === 'head' ? add(rest.piv[i], scale(sub(e, rest.piv[i]), 2)) : e;
			lines.push(`${pad}\tEnd Site`, `${pad}\t{`, `${pad}\t\tOFFSET ${cm(sub(end, rest.piv[i]))}`, `${pad}\t}`);
		}
		lines.push(`${pad}}`);
	};
	bone(parents.indexOf(-1), 0);
	lines.push('MOTION', `Frames: ${motion.frames.length}`, `Frame Time: ${(1 / motion.fps).toFixed(6)}`);
	for (const fr of motion.frames) {
		const f = rigFrames(rest, fr.pose, upc);
		const vals = [];
		for (const i of order) {
			const p = parents[i];
			const R = p < 0 ? f.Q[i] : mul(T(f.Q[p]), f.Q[i]);
			if (p < 0) {
				const root = fr.root || [0, 0, 0];
				vals.push(...f.pp[i].map((x, k) => (x / upc + root[k]).toFixed(3)));
			}
			vals.push(...eulerZXY(R).map((x) => x.toFixed(3)));
		}
		lines.push(vals.join(' '));
	}
	return lines.join('\n') + '\n';
}

/** Local joint rotations per frame as quaternions [w, x, y, z] (relative to the parent, rest-relative). */
export function rotations(rest, upc, pose) {
	const f = rigFrames(rest, pose, upc);
	return Object.fromEntries(rest.names.map((name, i) => {
		const p = rest.parents[i];
		const R = p < 0 ? f.Q[i] : mul(T(f.Q[p]), f.Q[i]);
		const tr = R[0] + R[4] + R[8];
		let q;
		if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [s / 4, (R[7] - R[5]) / s, (R[2] - R[6]) / s, (R[3] - R[1]) / s]; }
		else if (R[0] > R[4] && R[0] > R[8]) { const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2; q = [(R[7] - R[5]) / s, s / 4, (R[1] + R[3]) / s, (R[2] + R[6]) / s]; }
		else if (R[4] > R[8]) { const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2; q = [(R[2] - R[6]) / s, (R[1] + R[3]) / s, s / 4, (R[5] + R[7]) / s]; }
		else { const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2; q = [(R[3] - R[1]) / s, (R[2] + R[6]) / s, (R[5] + R[7]) / s, s / 4]; }
		return [name, q.map((x) => Math.round(x * 1e5) / 1e5)];
	}));
}

/** The distance from the camera (metres) shared by everyone in a clip: the nearest person's start. */
export function sceneDepthOf(cleans, { width, height }) {
	const focal = 1.2 * Math.max(width, height);
	const depths = [];
	for (const clean of cleans) {
		const f = clean.find((x) => [LM.hipL, LM.hipR, LM.shoulderL, LM.shoulderR].every((j) => x.world[j] && x.image[j]));
		if (!f) continue;
		const a = mid(f.image[LM.hipL], f.image[LM.hipR]), b = mid(f.image[LM.shoulderL], f.image[LM.shoulderR]);
		const px = Math.hypot((a[0] - b[0]) * width, (a[1] - b[1]) * height);
		const m = len(sub(mid(f.world[LM.hipL], f.world[LM.hipR]), mid(f.world[LM.shoulderL], f.world[LM.shoulderR])));
		if (px > 0) depths.push(focal * m / px);
	}
	return depths.length ? Math.min(...depths) : null;
}
