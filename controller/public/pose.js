// Pose mode for the body editor: the mannequin as a jointed puppet. 19 body parts (hips, waist,
// chest, neck, head, and per side collarbone, upper arm, forearm, hand, thigh, shin, foot) turn
// about their joints within human limits. A pose is plain numbers in degrees, so it can be set
// exactly (by the sliders, a saved body code, or remotely through the server's API), and dragging
// a hand, elbow, foot, knee, head, chest or the hips moves the rest of the body to follow, the way
// a puppet does: the near joints give first, the torso only when a limb runs out of reach, and
// planted feet stay where they are.
//
// Directions are the figure's own: L is her left (+x in the model), up is +y, her front is +z.
// Pure maths, no WebGL, so the server can pose the body too (src/body-depth.js).

const D = Math.PI / 180;

/** Where planted feet are for a pose, to hold them there through a whole drag. */
export function footPins(rest, pose, unitsPerCm = 0.1) {
	const f = rigFrames(rest, pose, unitsPerCm);
	return Object.fromEntries(['foot.L', 'toe.L', 'foot.R', 'toe.R'].map((e) => [e, effectorAt(rest, f, e)]));
}

// ---------- 3x3 rotations (row-major arrays) ----------

const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function mul(a, b) {
	const o = new Array(9);
	for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
	return o;
}
const ap = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
const rx = (deg) => { const c = Math.cos(deg * D), s = Math.sin(deg * D); return [1, 0, 0, 0, c, -s, 0, s, c]; };
const ry = (deg) => { const c = Math.cos(deg * D), s = Math.sin(deg * D); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
const rz = (deg) => { const c = Math.cos(deg * D), s = Math.sin(deg * D); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
/** The smallest rotation turning direction u onto direction v. */
function fromTo(u, v) {
	const nu = Math.hypot(...u) || 1, nv = Math.hypot(...v) || 1;
	const a = u.map((x) => x / nu), b = v.map((x) => x / nv);
	const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	let k = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
	const s = Math.hypot(...k);
	if (s < 1e-9) return c > 0 ? I3 : rz(180);
	k = k.map((x) => x / s);
	const t = 1 - c, [x, y, z] = k;
	return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}

// ---------- what can be posed ----------

const SPINE = (bend, lean, turn) => [
	['bend', ...bend, 'forward + / back −'],
	['lean', ...lean, 'towards her left + / right −'],
	['turn', ...turn, 'turns to her left + / right −']
];
/** Body parts and their axes: [key, min, max, meaning] in degrees. Sided parts come as .L and .R. */
const SPEC = {
	hips: { label: 'Hips (whole body)', axes: [...SPINE([-100, 120], [-40, 40], [-180, 180]), ['x', -100, 100, 'shift cm, her left +'], ['y', -150, 50, 'shift cm (the body is set back on the floor)'], ['z', -100, 100, 'shift cm, forward +']] },
	waist: { label: 'Waist', axes: SPINE([-30, 55], [-30, 30], [-40, 40]) },
	chest: { label: 'Chest', axes: SPINE([-30, 45], [-25, 25], [-40, 40]) },
	neck: { label: 'Neck', axes: SPINE([-40, 50], [-30, 30], [-50, 50]) },
	head: { label: 'Head', axes: SPINE([-40, 40], [-30, 30], [-45, 45]) },
	clavicle: { label: 'Shoulder', axes: [['shrug', -10, 35, 'up + / down −'], ['forward', -20, 25, 'forward + / back −']] },
	upperArm: { label: 'Upper arm', axes: [['lift', 0, 180, 'from hanging (0) through level (90) to overhead (180)'], ['toward', -70, 150, 'out to the side 0, forward 90, across her body >90, behind her −'], ['twist', -90, 90, 'turns the elbow out/back + / in −']] },
	forearm: { label: 'Elbow', axes: [['bend', 0, 150, 'straight 0, right angle 90'], ['twist', -80, 80, 'turns the palm out + / in −']] },
	hand: { label: 'Wrist', axes: [['bend', -70, 80, 'fingers forward + / back − (arm hanging)'], ['side', -30, 40, 'fingers out + / in −']] },
	thigh: { label: 'Hip joint (thigh)', axes: [['forward', -30, 130, 'leg forward + / back −'], ['out', -25, 80, 'leg out to the side + / across −'], ['twist', -45, 45, 'toes out + / in −']] },
	shin: { label: 'Knee', axes: [['bend', 0, 155, 'straight 0, right angle 90']] },
	foot: { label: 'Ankle', axes: [['point', -30, 60, 'toes down + / up −'], ['roll', -25, 25, 'outer edge up + / down −']] }
};
const SIDED = ['clavicle', 'upperArm', 'forearm', 'hand', 'thigh', 'shin', 'foot'];
const typeOf = (name) => name.split('.')[0];

/** Every posable part in order, with its axes: [{ key, label, side, axes: [{ key, min, max, meaning }] }]. */
export const POSE_PARTS = [];
for (const type of ['hips', 'waist', 'chest', 'neck', 'head']) POSE_PARTS.push({ key: type, label: SPEC[type].label, side: null, axes: SPEC[type].axes.map(([key, min, max, meaning]) => ({ key, min, max, meaning })) });
for (const side of ['L', 'R']) for (const type of SIDED) POSE_PARTS.push({ key: `${type}.${side}`, label: `${SPEC[type].label} (her ${side === 'L' ? 'left' : 'right'})`, side, axes: SPEC[type].axes.map(([key, min, max, meaning]) => ({ key, min, max, meaning })) });
const PART_INDEX = Object.fromEntries(POSE_PARTS.map((p) => [p.key, p]));

/** Standing straight: arms hanging a little out from the sides, feet nearly together. */
export const DEFAULT_POSE = { 'upperArm.L': { lift: 9 }, 'upperArm.R': { lift: 9 }, 'thigh.L': { out: 2 }, 'thigh.R': { out: 2 }, 'forearm.L': { bend: 6 }, 'forearm.R': { bend: 6 } };

/** Only known parts and axes, numbers clamped to their limits, zeros left out. */
export function cleanPose(pose) {
	const out = {};
	if (!pose || typeof pose !== 'object') return structuredClone(DEFAULT_POSE);
	for (const [name, axes] of Object.entries(pose)) {
		const spec = PART_INDEX[name];
		if (!spec || !axes || typeof axes !== 'object') continue;
		for (const a of spec.axes) {
			const x = Number(axes[a.key]);
			if (!Number.isFinite(x) || Math.abs(x) < 1e-4) continue;
			(out[name] ||= {})[a.key] = Math.round(Math.min(a.max, Math.max(a.min, x)) * 100) / 100;
		}
	}
	return out;
}

/** Her left and right swapped (for "mirror"): side parts trade places, leans and turns flip. */
export function mirrorPose(pose) {
	const out = {};
	for (const [name, axes] of Object.entries(pose || {})) {
		const [type, side] = name.split('.');
		const other = side ? `${type}.${side === 'L' ? 'R' : 'L'}` : name;
		out[other] = { ...axes };
		if (!side) for (const k of ['lean', 'turn', 'x']) if (out[other][k]) out[other][k] = -out[other][k];
	}
	return cleanPose(out);
}

/** Ready-made poses to start from. Values are degrees on the axes above. */
const both = (type, axes) => ({ [`${type}.L`]: { ...axes }, [`${type}.R`]: { ...axes } });
export const POSE_PRESETS = {
	Standing: DEFAULT_POSE,
	Relaxed: { hips: { lean: -3 }, chest: { lean: 3 }, head: { lean: -4, turn: 6 }, 'thigh.L': { forward: 8, out: 4, twist: 8 }, 'shin.L': { bend: 14 }, 'foot.L': { point: 6 }, 'thigh.R': { out: 3 }, 'upperArm.L': { lift: 11, toward: 10 }, 'upperArm.R': { lift: 8 }, ...both('forearm', { bend: 14 }) },
	'Hands on hips': { ...both('upperArm', { lift: 50, toward: -34, twist: -39 }), ...both('forearm', { bend: 80 }), ...both('clavicle', { shrug: -8, forward: 12 }), chest: { bend: 6 }, waist: { bend: -6 }, ...both('thigh', { out: 6 }) },
	'Arms crossed': { ...both('upperArm', { lift: 16, toward: 12, twist: -45 }), 'forearm.L': { bend: 95 }, 'forearm.R': { bend: 106 }, ...both('clavicle', { shrug: -8, forward: 22 }), ...both('thigh', { out: 3 }) },
	'Arms up': { ...both('upperArm', { lift: 168, toward: 15 }), ...both('forearm', { bend: 10 }), ...both('thigh', { out: 2 }) },
	'Arms out': { ...both('upperArm', { lift: 88 }), ...both('forearm', { bend: 4 }), ...both('thigh', { out: 2 }) },
	Waving: { 'upperArm.L': { lift: 9 }, 'forearm.L': { bend: 8 }, 'upperArm.R': { lift: 96, toward: 49, twist: 12 }, 'forearm.R': { bend: 76 }, chest: { bend: -6, lean: -3 }, waist: { lean: -4 }, head: { lean: 4, turn: -6 }, ...both('thigh', { out: 2 }) },
	Walking: { 'thigh.L': { forward: 22 }, 'shin.L': { bend: 8 }, 'foot.L': { point: -8 }, 'thigh.R': { forward: -14 }, 'shin.R': { bend: 22 }, 'foot.R': { point: 18 }, 'upperArm.L': { lift: 18, toward: -80 }, 'forearm.L': { bend: 12 }, 'upperArm.R': { lift: 20, toward: 85 }, 'forearm.R': { bend: 25 }, chest: { turn: 5 } },
	Running: { hips: { bend: 10 }, 'thigh.L': { forward: 65 }, 'shin.L': { bend: 85 }, 'foot.L': { point: 10 }, 'thigh.R': { forward: -20 }, 'shin.R': { bend: 40 }, 'foot.R': { point: 30 }, 'upperArm.L': { lift: 40, toward: -85 }, 'forearm.L': { bend: 85 }, 'upperArm.R': { lift: 50, toward: 85 }, 'forearm.R': { bend: 90 }, chest: { turn: 8 } },
	'Sitting (chair)': { ...both('thigh', { forward: 88, out: 6 }), ...both('shin', { bend: 88 }), ...both('upperArm', { lift: 22, toward: 80 }), ...both('forearm', { bend: 55 }), waist: { bend: 4 } },
	Kneeling: { ...both('thigh', { out: 4 }), ...both('shin', { bend: 92 }), ...both('foot', { point: 55 }), ...both('upperArm', { lift: 10 }), ...both('forearm', { bend: 10 }) },
	Crouching: { hips: { bend: 25 }, waist: { bend: 15 }, ...both('thigh', { forward: 100, out: 14 }), ...both('shin', { bend: 125 }), ...both('foot', { point: -20 }), ...both('upperArm', { lift: 35, toward: 75 }), ...both('forearm', { bend: 30 }), head: { bend: -20 } },
	'Lying on back': { hips: { bend: -90 }, ...both('upperArm', { lift: 20 }), ...both('forearm', { bend: 10 }), ...both('thigh', { out: 5 }), ...both('foot', { point: 30 }) }
};
for (const [k, p] of Object.entries(POSE_PRESETS)) POSE_PRESETS[k] = cleanPose(p);

// ---------- the rig on a shaped body ----------

/** The joint each part turns about, as a marker name (side added). */
const PIVOT = { waist: 'spine04', chest: 'spine02', neck: 'neck01', head: 'head', clavicle: 'clavicle', upperArm: 'upperarm01', forearm: 'lowerarm01', hand: 'wrist', thigh: 'upperleg01', shin: 'lowerleg01', foot: 'foot' };
/**
 * Limbs are straightened at zero (arm and leg hanging straight down, elbow and knee straight);
 * the hand follows its forearm. Other parts keep the modelled shape at zero.
 */
const STRAIGHT = { upperArm: 'lowerarm01', forearm: 'wrist', thigh: 'lowerleg01', shin: 'foot' };

function markerAt(d, p, name) {
	const [start, count] = d.markers[name];
	let x = 0, y = 0, z = 0;
	for (let i = start; i < start + count; i++) { x += p[i * 3]; y += p[i * 3 + 1]; z += p[i * 3 + 2]; }
	return [x / count, y / count, z / count];
}
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/** Things that can be dragged: the part that carries each and where it is on the unposed body. */
function effectorPoints(d, p) {
	const m = (n) => markerAt(d, p, n);
	const e = {
		hips: ['hips', mid(m('upperleg01.L'), m('upperleg01.R'))],
		chest: ['chest', mid(m('spine02'), m('neck01'))],
		head: ['head', mid(m('head'), m('head.top'))]
	};
	for (const s of ['L', 'R']) Object.assign(e, {
		[`hand.${s}`]: [`hand.${s}`, mid(m(`wrist.${s}`), m(`hand.${s}`))],
		[`elbow.${s}`]: [`upperArm.${s}`, m(`lowerarm01.${s}`)],
		[`foot.${s}`]: [`shin.${s}`, m(`foot.${s}`)],
		[`toe.${s}`]: [`foot.${s}`, m(`toe.${s}`)],
		[`knee.${s}`]: [`thigh.${s}`, m(`lowerleg01.${s}`)],
		[`fingertip.${s}`]: [`hand.${s}`, m(`fingertip.${s}`)],
		[`shoulder.${s}`]: [`clavicle.${s}`, m(`upperarm01.${s}`)]
	});
	return e;
}
/** The handles shown in Pose mode, in the order they are picked when two overlap. */
export const HANDLES = ['hand.L', 'hand.R', 'foot.L', 'foot.R', 'head', 'elbow.L', 'elbow.R', 'knee.L', 'knee.R', 'chest', 'hips'];

/** The rig measured on an unposed, shaped body p (model units). */
export function rigRest(d, p) {
	const names = d.rig.parts;
	const piv = names.map((name) => {
		if (name === 'hips') return mid(markerAt(d, p, 'upperleg01.L'), markerAt(d, p, 'upperleg01.R'));
		const [type, side] = name.split('.');
		return markerAt(d, p, side ? `${PIVOT[type]}.${side}` : PIVOT[type]);
	});
	const C = names.map((name, i) => {
		const [type, side] = name.split('.');
		const straight = type === 'hand' ? 'forearm' : type;
		if (!STRAIGHT[straight]) return I3;
		const from = straight === type ? piv[i] : piv[names.indexOf(`forearm.${side}`)];
		const end = markerAt(d, p, `${STRAIGHT[straight]}.${side}`);
		return fromTo([end[0] - from[0], end[1] - from[1], end[2] - from[2]], [0, -1, 0]);
	});
	return { names, parents: d.rig.parents, piv, C, effectors: effectorPoints(d, p) };
}

function local(name, a = {}) {
	const [type, side] = name.split('.');
	const o = side === 'R' ? -1 : 1; // her left is +x
	const v = (k) => a[k] || 0;
	switch (type) {
		case 'hips': case 'waist': case 'chest': case 'neck': case 'head': return mul(ry(v('turn')), mul(rz(-v('lean')), rx(v('bend'))));
		case 'clavicle': return mul(rz(o * v('shrug')), ry(-o * v('forward')));
		case 'upperArm': { const phi = -o * v('toward'); return mul(ry(phi), mul(rz(o * v('lift')), mul(ry(-phi), ry(o * v('twist'))))); }
		case 'forearm': return mul(rx(-v('bend')), ry(o * v('twist')));
		case 'hand': return mul(rx(-v('bend')), rz(o * v('side')));
		case 'thigh': return mul(rx(-v('forward')), mul(rz(o * v('out')), ry(o * v('twist'))));
		case 'shin': return rx(v('bend'));
		case 'foot': return mul(rx(v('point')), rz(o * v('roll')));
	}
	return I3;
}

/** Where every part is for a pose: posed pivot pp and rotation Q (rest → posed) per part. */
export function rigFrames(rest, pose, unitsPerCm = 0.1) {
	const n = rest.names.length, G = new Array(n), Q = new Array(n), pp = new Array(n);
	for (let i = 0; i < n; i++) {
		const name = rest.names[i], par = rest.parents[i];
		const L = local(name, pose?.[name]);
		G[i] = par < 0 ? L : mul(G[par], L);
		Q[i] = mul(G[i], rest.C[i]);
		if (par < 0) {
			const h = pose?.hips || {};
			pp[i] = [rest.piv[i][0] + (h.x || 0) * unitsPerCm, rest.piv[i][1] + (h.y || 0) * unitsPerCm, rest.piv[i][2] + (h.z || 0) * unitsPerCm];
		} else {
			const r = rest.piv[i], q = rest.piv[par];
			const off = ap(Q[par], r[0] - q[0], r[1] - q[1], r[2] - q[2]);
			pp[i] = [pp[par][0] + off[0], pp[par][1] + off[1], pp[par][2] + off[2]];
		}
	}
	return { pp, Q };
}

function placed(rest, f, i, x) {
	const q = rest.piv[i], o = ap(f.Q[i], x[0] - q[0], x[1] - q[1], x[2] - q[2]);
	return [f.pp[i][0] + o[0], f.pp[i][1] + o[1], f.pp[i][2] + o[2]];
}

/** Where a draggable point is for frames f (model units). */
export function effectorAt(rest, f, name) {
	const [part, at] = rest.effectors[name];
	return placed(rest, f, rest.names.indexOf(part), at);
}

/** Pose every vertex of p (unposed, model units) in place: blended by the rig's weights. */
export function skinRig(d, p, rest, f) {
	const { joints, w } = d.rig;
	const n = d.count;
	for (let v = 0; v < n; v++) {
		const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
		let ox = 0, oy = 0, oz = 0;
		for (let k = 0; k < 4; k++) {
			const wt = w[v * 4 + k];
			if (!wt) continue;
			const j = joints[v * 4 + k], q = rest.piv[j], Q = f.Q[j];
			const dx = x - q[0], dy = y - q[1], dz = z - q[2];
			ox += wt * (f.pp[j][0] + Q[0] * dx + Q[1] * dy + Q[2] * dz);
			oy += wt * (f.pp[j][1] + Q[3] * dx + Q[4] * dy + Q[5] * dz);
			oz += wt * (f.pp[j][2] + Q[6] * dx + Q[7] * dy + Q[8] * dz);
		}
		p[v * 3] = ox; p[v * 3 + 1] = oy; p[v * 3 + 2] = oz;
	}
}

// ---------- following a drag ----------

/**
 * Which joints give when a point is dragged, and how stiff each is (higher gives later): the
 * near joints move first; the torso joins in only when the limb runs out of reach.
 */
function chainFor(effector) {
	const [kind, s] = effector.split('.');
	const spine = (k) => [[`chest`, 'bend', 3 * k], ['chest', 'lean', 3 * k], ['chest', 'turn', 3 * k], ['waist', 'bend', 4 * k], ['waist', 'lean', 4 * k], ['waist', 'turn', 4 * k]];
	switch (kind) {
		case 'hand': return [[`upperArm.${s}`, 'lift', 0.2], [`upperArm.${s}`, 'toward', 0.2], [`upperArm.${s}`, 'twist', 1.5], [`forearm.${s}`, 'bend', 0.2], [`clavicle.${s}`, 'shrug', 1.5], [`clavicle.${s}`, 'forward', 1.5], ...spine(1)];
		case 'elbow': return [[`upperArm.${s}`, 'lift', 0.2], [`upperArm.${s}`, 'toward', 0.2], [`clavicle.${s}`, 'shrug', 1.5], [`clavicle.${s}`, 'forward', 1.5], ...spine(2)];
		case 'foot': return [[`thigh.${s}`, 'forward', 0.2], [`thigh.${s}`, 'out', 0.3], [`thigh.${s}`, 'twist', 1.5], [`shin.${s}`, 'bend', 0.2], ['hips', 'lean', 6]];
		case 'knee': return [[`thigh.${s}`, 'forward', 0.2], [`thigh.${s}`, 'out', 0.3], [`thigh.${s}`, 'twist', 1.5]];
		case 'head': return [['head', 'bend', 0.4], ['head', 'lean', 0.4], ['head', 'turn', 0.6], ['neck', 'bend', 0.4], ['neck', 'lean', 0.4], ['neck', 'turn', 0.6], ...spine(1)];
		case 'chest': return [['chest', 'bend', 0.5], ['chest', 'lean', 0.5], ['chest', 'turn', 0.8], ['waist', 'bend', 0.5], ['waist', 'lean', 0.5], ['waist', 'turn', 0.8], ['hips', 'bend', 2], ['hips', 'lean', 2]];
		case 'hips': return [['hips', 'x', 0.02], ['hips', 'y', 0.02], ['hips', 'z', 0.02], ['hips', 'bend', 2], ['hips', 'lean', 2], ['hips', 'turn', 3]];
	}
	return [];
}
const LEG = (s) => [[`thigh.${s}`, 'forward', 0.3], [`thigh.${s}`, 'out', 0.3], [`thigh.${s}`, 'twist', 1], [`shin.${s}`, 'bend', 0.3], [`foot.${s}`, 'point', 0.3], [`foot.${s}`, 'roll', 0.5]];

function solveLinear(A, b) {
	const n = b.length, M = A.map((row, i) => [...row, b[i]]);
	for (let c = 0; c < n; c++) {
		let best = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[best][c])) best = r;
		[M[c], M[best]] = [M[best], M[c]];
		const piv = M[c][c];
		if (Math.abs(piv) < 1e-12) continue;
		for (let r = 0; r < n; r++) if (r !== c) { const k = M[r][c] / piv; if (k) for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; }
	}
	return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

/**
 * Move dragged points towards targets by turning joints within their limits (damped least squares).
 * goals: [{ effector, target: [x, y, z] in model units, weight }]. With feet planted, a foot that
 * is not being dragged keeps its place and its angle on the floor while the hips or torso move.
 * pinTargets (optional) holds where planted feet should stay ({ 'foot.L': [x, y, z], ... }); by
 * default where they are in `pose`. anchor (optional) is the pose the joints' stiffness pulls back
 * towards; by default `pose`. Returns a new, clean pose.
 */
export function solveRig(rest, pose, goals, { feetPlanted = true, iterations = 12, unitsPerCm = 0.1, extra = [], pinTargets = null, anchor = null } = {}) {
	const start = cleanPose(pose);
	// Stiffness pulls towards the pose the drag began from, so the torso does not creep a little every frame.
	const home = anchor ? cleanPose(anchor) : start;
	const dofs = [];
	const seen = new Set();
	const add = ([part, axis, cost]) => { const k = `${part}/${axis}`; if (seen.has(k)) return; seen.add(k); const spec = PART_INDEX[part].axes.find((a) => a.key === axis); dofs.push({ part, axis, cost, min: spec.min, max: spec.max, step: 0.5 }); };
	for (const g of goals) for (const c of chainFor(g.effector)) add(c);
	for (const c of extra) add(c);
	const dragged = new Set(goals.map((g) => g.effector.split('.')[1] && ['foot', 'knee', 'toe'].includes(g.effector.split('.')[0]) ? g.effector.split('.')[1] : null));
	// Only turning or moving the hips carries the feet along, so only then do planted feet need holding.
	const movesRoot = dofs.some((x) => x.part === 'hips');
	const pins = [];
	if (feetPlanted && movesRoot) {
		const f0 = rigFrames(rest, start, unitsPerCm);
		for (const s of ['L', 'R']) {
			if (dragged.has(s)) continue;
			for (const e of [`foot.${s}`, `toe.${s}`]) pins.push({ effector: e, target: pinTargets?.[e] || effectorAt(rest, f0, e), weight: 3 });
			for (const c of LEG(s)) add(c);
		}
	}
	const all = [...goals.map((g) => ({ weight: 1, ...g })), ...pins];
	const get = (p, x) => p[x.part]?.[x.axis] || 0;
	const set = (p, x, val) => { (p[x.part] ||= {})[x.axis] = Math.min(x.max, Math.max(x.min, val)); };
	const residual = (p) => {
		const f = rigFrames(rest, p, unitsPerCm);
		const r = [];
		for (const g of all) { const at = effectorAt(rest, f, g.effector); for (let k = 0; k < 3; k++) r.push((at[k] - g.target[k]) * g.weight); }
		for (const x of dofs) r.push(Math.sqrt(x.cost) * 0.012 * (get(p, x) - get(home, x)));
		return r;
	};
	let cur = structuredClone(start);
	for (let it = 0; it < iterations; it++) {
		const r0 = residual(cur);
		const J = dofs.map((x) => {
			const p = structuredClone(cur);
			const h = get(cur, x) + x.step > x.max ? -x.step : x.step;
			set(p, x, get(cur, x) + h);
			const r1 = residual(p);
			return r1.map((v, i) => (v - r0[i]) / h);
		});
		const n = dofs.length;
		const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => { let s = 0; for (let k = 0; k < r0.length; k++) s += J[i][k] * J[j][k]; return s + (i === j ? 1e-4 : 0); }));
		const b = Array.from({ length: n }, (_, i) => { let s = 0; for (let k = 0; k < r0.length; k++) s -= J[i][k] * r0[k]; return s; });
		const step = solveLinear(A, b);
		// Cap one step so a far target is followed smoothly rather than in a jump.
		const big = Math.max(...step.map(Math.abs));
		const scale = big > 25 ? 25 / big : 1;
		// Halve the step until it helps (joint limits can make a full step overshoot).
		const e0 = r0.reduce((s, v) => s + v * v, 0);
		let next = null, e1 = e0;
		for (let t = scale; t > scale / 20; t /= 2) {
			const trial = structuredClone(cur);
			dofs.forEach((x, i) => set(trial, x, get(cur, x) + step[i] * t));
			const e = residual(trial).reduce((s, v) => s + v * v, 0);
			if (e < e0) { next = trial; e1 = e; break; }
		}
		if (!next) break;
		cur = next;
		if (e0 - e1 < 1e-9) break;
	}
	return cleanPose(cur);
}
