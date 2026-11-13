// The body editor's 3D mannequin: the MakeHuman base body (CC0, see vendor/makehuman/LICENSE)
// with its morph targets. Sliders blend the targets on the phone, so every change is instant.
// The finished figure is in centimetres, +Y up, facing +Z, soles on y = 0.
import * as THREE from './vendor/three/three.module.js';

/** Layout version of saved values; older saves (from the first, drawn mannequin) are converted. */
const VERSION = 2;

/**
 * The sliders. Most run from -1 (the target's "less" end) through 0 (average) to +1 ("more"),
 * a little past either end for exaggerated figures. Vertical ones are lengths.
 */
export const SLIDERS = [
	{ key: 'height', label: 'Height', group: 'lengths', min: 140, max: 205, step: 1, unit: 'cm', vertical: true },
	{ key: 'neckLength', label: 'Neck', group: 'lengths', min: -1.3, max: 1.3, step: 0.01, vertical: true },
	{ key: 'torsoLength', label: 'Torso', group: 'lengths', min: -1.3, max: 1.3, step: 0.01, vertical: true },
	{ key: 'legLength', label: 'Legs', group: 'lengths', min: -1.3, max: 1.3, step: 0.01, vertical: true },
	{ key: 'armLength', label: 'Arms', group: 'lengths', min: -1.3, max: 1.3, step: 0.01, vertical: true },
	{ key: 'armPose', label: 'Arms out', group: 'shape', min: 0, max: 1, step: 0.01 },
	{ key: 'weight', label: 'Weight', group: 'shape', min: -1, max: 1, step: 0.01 },
	{ key: 'muscle', label: 'Muscle', group: 'shape', min: -1, max: 1, step: 0.01 },
	{ key: 'shoulders', label: 'Shoulders', group: 'torso', min: -1.2, max: 1.2, step: 0.01 },
	{ key: 'chest', label: 'Ribcage', group: 'torso', min: -1.2, max: 1.2, step: 0.01 },
	{ key: 'pecs', label: 'Pectorals', group: 'torso', min: -1, max: 1.3, step: 0.01 },
	{ key: 'lats', label: 'Back (lats)', group: 'torso', min: -1, max: 1.3, step: 0.01 },
	{ key: 'vshape', label: 'V-shape', group: 'torso', min: -1, max: 1.3, step: 0.01 },
	{ key: 'waist', label: 'Waist', group: 'torso', min: -1.2, max: 1.3, step: 0.01 },
	{ key: 'belly', label: 'Belly', group: 'torso', min: -1, max: 1, step: 0.01 },
	{ key: 'fupa', label: 'Lower belly (FUPA)', group: 'torso', min: -1, max: 1.5, step: 0.01 },
	{ key: 'abs', label: 'Abs tone', group: 'torso', min: -1, max: 1.3, step: 0.01 },
	{ key: 'arms', label: 'Arm thickness', group: 'torso', min: -1.2, max: 1.4, step: 0.01 },
	{ key: 'bust', label: 'Breast size', group: 'chest', min: -1, max: 1.6, step: 0.01 },
	{ key: 'breastFirm', label: 'Firmness (lift)', group: 'chest', min: -1, max: 1, step: 0.01 },
	{ key: 'breastHeight', label: 'Height on chest', group: 'chest', min: -1, max: 1, step: 0.01 },
	{ key: 'breastSpacing', label: 'Spacing', group: 'chest', min: -1, max: 1.2, step: 0.01 },
	{ key: 'breastFullness', label: 'Fullness: bottom ↔ top', group: 'chest', min: -1, max: 1, step: 0.01 },
	{ key: 'breastPoint', label: 'Projection', group: 'chest', min: -1, max: 1, step: 0.01 },
	{ key: 'hips', label: 'Hips', group: 'butt', min: -1.2, max: 1.5, step: 0.01 },
	{ key: 'glutes', label: 'Butt size', group: 'butt', min: -1, max: 1.5, step: 0.01 },
	{ key: 'buttLift', label: 'Butt height (lower ↔ lift)', group: 'butt', min: -1, max: 1, step: 0.01 },
	{ key: 'buttOut', label: 'Sticks out', group: 'butt', min: -1, max: 1.3, step: 0.01 },
	{ key: 'buttSplit', label: 'Cheek separation', group: 'butt', min: -1, max: 1.5, step: 0.01 },
	{ key: 'hipDips', label: 'Hip dips', group: 'butt', min: -1, max: 1.5, step: 0.01 },
	{ key: 'buttWidth', label: 'Butt width', group: 'butt', min: -1, max: 1.2, step: 0.01 },
	{ key: 'buttFullness', label: 'Fullness: bottom ↔ top', group: 'butt', min: -1, max: 1, step: 0.01 },
	{ key: 'stance', label: 'Feet apart', group: 'legs', min: 0, max: 1, step: 0.01 },
	{ key: 'thighs', label: 'Thighs', group: 'legs', min: -1.2, max: 1.5, step: 0.01 },
	{ key: 'thighGap', label: 'Thigh gap', group: 'legs', min: -1, max: 1.3, step: 0.01 },
	{ key: 'bowLegs', label: 'Bow legs', group: 'legs', min: -1.3, max: 1.5, step: 0.01 },
	{ key: 'calves', label: 'Calves', group: 'legs', min: -1.2, max: 1.3, step: 0.01 },
	{ key: 'headSize', label: 'Head size', group: 'head', min: -1, max: 1, step: 0.01 },
	{ key: 'neckWidth', label: 'Neck width', group: 'head', min: -1.2, max: 1.2, step: 0.01 }
];

/** The tabs the sliders are grouped under, in order. */
export const GROUPS = [['shape', 'Body'], ['lengths', 'Lengths'], ['torso', 'Torso'], ['chest', 'Chest'], ['butt', 'Butt'], ['legs', 'Legs'], ['head', 'Head']];

/**
 * The look of the starting figures, added under the sliders (so 0 still means "as the base"):
 * a toned, fit build like the clay figures of character creators, rather than MakeHuman's
 * plain average body.
 */
const BASE_TUNE = {
	female: { muscle: 0.45, weight: -0.15, bust: 0.35, waist: -0.25, hips: 0.2, glutes: 0.25, legLength: 0.2, thighGap: 0.15, buttSplit: 1 },
	male: { muscle: 0.75, weight: -0.25, shoulders: 0.35, chest: 0.3, waist: -0.2, legLength: 0.15, neckWidth: 0.2, buttSplit: 0.4 }
};

/** Which morph targets each slider drives, and how strongly. */
const DRIVES = {
	neckLength: [['neck-height', 1]],
	torsoLength: [['napetowaist-dist', 1], ['waisttohip-dist', 0.5]],
	legLength: [['upperleg-height', 1], ['lowerleg-height', 1]],
	armLength: [['upperarm-length', 1], ['lowerarm-length', 1]],
	headSize: [['head-height', 1], ['head-width', 1]],
	neckWidth: [['neck-circ', 1]],
	shoulders: [['shoulder-dist', 1]],
	chest: [['frontchest-dist', 1], ['torso-depth', 0.5]],
	bust: [['cup', 1]],
	waist: [['waist-circ', 1]],
	hips: [['hips-circ', 1], ['hip-depth', 0.4]],
	glutes: [['glutes', 1]],
	belly: [['belly', 1]],
	thighs: [['thigh-circ', 1]],
	thighGap: [['thigh-gap', 1]],
	pecs: [['pecs', 1]],
	lats: [['lats', 1]],
	vshape: [['vshape', 1]],
	abs: [['abs', 1]],
	breastFirm: [['firmness', 1]],
	breastHeight: [['breast', 1]],
	breastSpacing: [['breast-dist', 1]],
	breastFullness: [['breast-fullness', 1]],
	breastPoint: [['breast-point', 1]],
	buttLift: [['glute-lift', 1], ['hip-height', 0.35]],
	buttOut: [['glute-out', 1]],
	buttWidth: [['glute-width', 1]],
	buttSplit: [['glute-split', 1]],
	hipDips: [['hip-dips', 1]],
	fupa: [['fupa', 1]],
	buttFullness: [['glute-top', 1]],
	bowLegs: [['bowlegs', 1]],
	calves: [['calf-circ', 1]],
	arms: [['upperarm-circ', 1], ['wrist-circ', 0.4]]
};

/** Head shapes, each a MakeHuman head target. */
export const HEAD_SHAPES = { oval: 'head-oval', round: 'head-round', long: 'head-rectangular', heart: 'head-invertedtriangular', square: 'head-square', diamond: 'head-diamond' };
const HEAD_AMOUNT = 0.7;

const BASE_HEIGHT = { female: 168, male: 178 };

/** Default values for a base body (0 means "average"). */
export function defaults(base = 'female') {
	const v = { version: VERSION, base: base === 'male' ? 'male' : 'female', headShape: 'oval' };
	for (const s of SLIDERS) v[s.key] = s.key === 'height' ? BASE_HEIGHT[v.base] : 0;
	return v;
}

/**
 * Bring saved values up to date. The first mannequin stored ratios around 1 (bust and glutes
 * around their base amount); those become the nearest positions on the new sliders.
 */
export function migrate(values) {
	if (!values || typeof values !== 'object') return defaults();
	const out = defaults(values.base);
	if (values.version === VERSION) {
		for (const s of SLIDERS) if (Number.isFinite(values[s.key])) out[s.key] = clamp(values[s.key], s.min, s.max);
	} else {
		for (const s of SLIDERS) {
			const old = values[s.key];
			if (!Number.isFinite(old)) continue;
			out[s.key] = s.key === 'height' ? old : s.key === 'bust' || s.key === 'glutes' ? (old - (out.base === 'male' ? 0.5 : 1)) * 0.8 : (old - 1) * 3;
			out[s.key] = clamp(out[s.key], s.min, s.max);
		}
	}
	if (values.headShape in HEAD_SHAPES) out.headShape = values.headShape;
	if (values.name) out.name = values.name;
	return out;
}

function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

/**
 * Whole-body templates on top of a base. Names and ideas follow the full-body dials of Daz's
 * Genesis 9 Body Shapes (Emaciated, Thin, Lithe, Fitness, Muscular, Heavy, Pear, Voluptuous,
 * Portly, Stocky), rebuilt from this body's own sliders.
 */
export const PRESETS = {
	female: {
		Emaciated: { weight: -1, muscle: -0.6, bust: -0.6, glutes: -0.7, hips: -0.5, thighs: -0.8, calves: -0.6, arms: -0.8, thighGap: 0.8, breastFirm: -0.3 },
		Thin: { weight: -0.65, muscle: -0.2, bust: -0.3, glutes: -0.4, hips: -0.3, thighs: -0.5, arms: -0.4, thighGap: 0.5 },
		Lithe: { weight: -0.4, muscle: 0.2, waist: -0.3, legLength: 0.3, bust: -0.2, thighs: -0.2, thighGap: 0.4, abs: 0.4 },
		Fitness: { muscle: 0.7, weight: -0.35, abs: 0.9, shoulders: 0.25, glutes: 0.4, buttLift: 0.5, thighs: 0.25, calves: 0.3, breastFirm: 0.5 },
		Athletic: { muscle: 0.6, weight: -0.2, shoulders: 0.3, waist: -0.2, thighs: 0.2, glutes: 0.3, buttLift: 0.3, abs: 0.5 },
		Muscular: { muscle: 1, weight: 0.1, shoulders: 0.6, lats: 0.7, pecs: 0.4, arms: 0.7, thighs: 0.7, calves: 0.6, glutes: 0.5, abs: 1, neckWidth: 0.4 },
		Hourglass: { waist: -0.8, hips: 0.8, bust: 0.9, glutes: 0.8, thighs: 0.4, breastFirm: 0.3 },
		Pear: { shoulders: -0.3, bust: -0.3, waist: -0.2, hips: 1, glutes: 1, thighs: 0.9, buttFullness: -0.4 },
		Voluptuous: { weight: 0.3, bust: 1.3, waist: -0.5, hips: 1.1, glutes: 1.2, thighs: 0.8, buttOut: 0.5, breastFullness: 0.3 },
		Curvy: { weight: 0.45, hips: 1, bust: 1.2, glutes: 1.1, thighs: 0.8, waist: 0.1 },
		Heavy: { weight: 1, muscle: -0.2, belly: 0.6, bust: 0.9, hips: 0.9, glutes: 0.8, thighs: 1, arms: 0.9, calves: 0.6, thighGap: -0.8, breastFirm: -0.4 }
	},
	male: {
		Emaciated: { weight: -1, muscle: -0.6, shoulders: -0.4, arms: -0.8, thighs: -0.8, calves: -0.6, pecs: -0.6 },
		Thin: { weight: -0.65, muscle: -0.3, shoulders: -0.3, chest: -0.3, arms: -0.4 },
		Lithe: { weight: -0.4, muscle: 0.3, waist: -0.3, legLength: 0.3, abs: 0.6, vshape: 0.3 },
		Fitness: { muscle: 0.8, weight: -0.35, abs: 1, pecs: 0.6, vshape: 0.6, shoulders: 0.35, arms: 0.4 },
		Athletic: { muscle: 0.6, weight: -0.2, shoulders: 0.4, chest: 0.3, waist: -0.3, pecs: 0.4, abs: 0.6 },
		Muscular: { muscle: 1, weight: 0.2, shoulders: 0.8, chest: 0.7, pecs: 1, lats: 1, vshape: 0.8, arms: 0.8, thighs: 0.6, neckWidth: 0.8, abs: 1 },
		Stocky: { weight: 0.7, muscle: 0.3, waist: 0.6, belly: 0.4, legLength: -0.5, neckWidth: 0.5 },
		Portly: { weight: 0.9, muscle: -0.3, belly: 1, waist: 0.9, pecs: -0.3, abs: -1, chest: 0.3 },
		Heavy: { weight: 1, muscle: -0.1, belly: 0.7, waist: 0.8, arms: 0.8, thighs: 0.9, neckWidth: 0.6 },
		Tall: { height: 192, legLength: 0.4, torsoLength: 0.2 }
	}
};

/**
 * Breast types, after the shapes commonly used to describe breasts (round, teardrop, bell,
 * east-west, side-set, close-set, slender, athletic, relaxed). Each sets the chest sliders
 * other than size.
 */
export const BREAST_TYPES = {
	Round: { breastFirm: 0.6, breastFullness: 0.5, breastPoint: 0.2 },
	Teardrop: { breastFirm: 0.2, breastFullness: -0.6, breastPoint: 0.1 },
	Bell: { breastFirm: -0.3, breastFullness: -0.9, breastHeight: -0.3 },
	'East-west': { breastSpacing: 0.8, breastPoint: -0.3, breastFirm: 0.1 },
	'Side-set': { breastSpacing: 1, breastFullness: -0.2 },
	'Close-set': { breastSpacing: -0.8, breastFirm: 0.3 },
	Slender: { breastHeight: -0.5, breastFirm: -0.4, breastPoint: 0.4, breastFullness: -0.4 },
	Athletic: { breastSpacing: 0.5, breastFirm: 0.6, breastPoint: -0.3, breastHeight: 0.2 },
	Relaxed: { breastFirm: -0.9, breastHeight: -0.6, breastFullness: -0.5 }
};
const BREAST_KEYS = ['breastFirm', 'breastHeight', 'breastSpacing', 'breastFullness', 'breastPoint'];

/**
 * Butt types, after the four shapes used by plastic surgeons and fitness guides (round "O",
 * heart "A", square "H", inverted "V"), plus the high, projecting "bubble" shape.
 */
export const BUTT_TYPES = {
	Round: { glutes: 0.6, buttOut: 0.4, buttFullness: 0, buttWidth: 0.1, buttLift: 0.2 },
	Heart: { glutes: 0.5, buttFullness: -0.8, buttWidth: 0.35, hips: 0.4, buttOut: 0.2 },
	Square: { glutes: 0.1, buttWidth: 0.5, buttFullness: 0.1, buttOut: -0.2, buttLift: -0.2 },
	'Inverted V': { glutes: 0.2, buttFullness: 0.8, buttWidth: -0.3, buttLift: 0.1, buttOut: -0.1 },
	Bubble: { glutes: 0.8, buttOut: 1, buttLift: 0.7, buttFullness: 0.3 },
	Flat: { glutes: -0.7, buttOut: -0.8, buttLift: -0.3 }
};
const BUTT_KEYS = ['glutes', 'buttOut', 'buttFullness', 'buttWidth', 'buttLift', 'hips'];

/** Apply a breast or butt type: its sliders take the type's values, the others in that set reset. */
export function applyType(values, kind, name) {
	const [types, keys] = kind === 'breast' ? [BREAST_TYPES, BREAST_KEYS] : [BUTT_TYPES, BUTT_KEYS];
	const out = { ...values };
	for (const k of keys) out[k] = 0;
	Object.assign(out, types[name] || {});
	return out;
}

// ---------- the mesh ----------

let meshData = null;

/** Load the converted MakeHuman body once: base positions, triangles and sparse morph targets. */
export async function loadHuman(url = new URL('./vendor/makehuman/', import.meta.url)) {
	if (meshData) return meshData;
	const [layout, bin] = await Promise.all([
		fetch(new URL('human.json', url)).then((r) => { if (!r.ok) throw new Error(`body model: HTTP ${r.status}`); return r.json(); }),
		fetch(new URL('human.bin', url)).then((r) => { if (!r.ok) throw new Error(`body model: HTTP ${r.status}`); return r.arrayBuffer(); })
	]);
	const Index = layout.indexType === 'uint32' ? Uint32Array : Uint16Array;
	const morphs = {};
	for (const m of layout.morphs) morphs[m.name] = { idx: new Index(bin, m.indices, m.count), off: new Float32Array(bin, m.offsets, m.count * 3) };
	meshData = {
		count: layout.vertices,
		base: new Float32Array(bin, layout.positions, layout.vertices * 3),
		index: new Index(bin, layout.indices, layout.triangles * 3),
		eyes: layout.eyes,
		markers: layout.markers || {},
		subdiv: layout.subdiv && {
			count: layout.subdiv.vertices,
			starts: new Uint32Array(bin, layout.subdiv.starts, layout.subdiv.vertices + 1),
			cols: new Index(bin, layout.subdiv.cols, layout.subdiv.nnz),
			weights: new Float32Array(bin, layout.subdiv.weights, layout.subdiv.nnz),
			index: new (layout.subdiv.indexType === 'uint32' ? Uint32Array : Uint16Array)(bin, layout.subdiv.indices, layout.subdiv.triangles * 3)
		},
		skin: Object.fromEntries(Object.entries(layout.skin || {}).map(([k, e]) => [k, { idx: new Index(bin, e.indices, e.count), w: new Float32Array(bin, e.weights, e.count) }])),
		morphs
	};
	return meshData;
}

/** The weight of every morph target for a set of slider values. */
export function weights(v) {
	const w = {};
	const add = (name, x) => { if (x) w[name] = (w[name] || 0) + x; };
	const two = (name, x) => { if (x > 0) add(`${name}-up`, x); else if (x < 0) add(`${name}-down`, -x); };
	const g = v.base === 'male' ? 'male' : 'female';
	const tune = BASE_TUNE[g];
	const at = (key) => (v[key] || 0) + (tune[key] || 0);
	add(g, 1);
	two(`${g}-weight`, at('weight'));
	two(`${g}-muscle`, at('muscle'));
	for (const [key, drives] of Object.entries(DRIVES)) for (const [name, k] of drives) two(name, at(key) * k);
	if (HEAD_SHAPES[v.headShape]) add(HEAD_SHAPES[v.headShape], HEAD_AMOUNT);
	return w;
}

/** Positions (centimetres, standing on y = 0, exactly v.height tall) for the given values. */
export function shapeBody(v, out) {
	const d = meshData;
	const p = out || new Float32Array(d.count * 3);
	p.set(d.base);
	for (const [name, k] of Object.entries(weights(v))) {
		const m = d.morphs[name];
		if (!m) continue;
		for (let i = 0; i < m.idx.length; i++) {
			const j = m.idx[i] * 3;
			p[j] += m.off[i * 3] * k;
			p[j + 1] += m.off[i * 3 + 1] * k;
			p[j + 2] += m.off[i * 3 + 2] * k;
		}
	}
	poseArms(p, v.armPose || 0);
	poseLegs(p, v.stance || 0);
	// Measure the drawn skin only (the eye markers sit inside the head), then scale to the height.
	const skin = d.eyes[0][0];
	let minY = Infinity, maxY = -Infinity, cx = 0, cz = 0;
	for (let i = 0; i < skin; i++) {
		const y = p[i * 3 + 1];
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
		cx += p[i * 3]; cz += p[i * 3 + 2];
	}
	cx /= skin; cz /= skin;
	const k = (v.height || BASE_HEIGHT[v.base] || 170) / (maxY - minY);
	for (let i = 0; i < d.count; i++) {
		p[i * 3] = (p[i * 3] - cx) * k;
		p[i * 3 + 1] = (p[i * 3 + 1] - minY) * k;
		p[i * 3 + 2] = (p[i * 3 + 2] - cz) * k;
	}
	return p;
}

/**
 * Camera distances to the front of the torso and to behind the body's middle. The front is taken
 * from the trunk only (hands and fingers reach forward in this pose and have many vertices).
 */
function depthRange(p, skin, angle, cameraZ) {
	const sin = Math.sin(angle), cos = Math.cos(angle);
	let top = 0;
	for (let i = 0; i < skin; i++) top = Math.max(top, p[i * 3 + 1]);
	let front = -Infinity, back = Infinity, sum = 0;
	for (let i = 0; i < skin; i++) {
		const x = p[i * 3], y = p[i * 3 + 1];
		const z = -x * sin + p[i * 3 + 2] * cos;
		sum += z;
		if (z < back) back = z;
		if (Math.abs(x) < top * 0.12 && y > top * 0.45 && y < top * 0.8 && z > front) front = z;
	}
	// Only the front half shows from the camera, so the range ends a little behind the body's
	// middle plane: limbs stay mid-grey and the torso's curves get most of the contrast.
	const middle = sum / skin;
	return [cameraZ - front - 1, cameraZ - middle + (middle - back) * 0.7];
}

function depthMaterial(near, far) {
	return new THREE.ShaderMaterial({
		uniforms: { near: { value: near }, far: { value: far } },
		vertexShader: 'varying float vDist; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = -mv.z; gl_Position = projectionMatrix * mv; }',
		fragmentShader: 'uniform float near; uniform float far; varying float vDist; void main() { float d = clamp((far - vDist) / (far - near), 0.0, 1.0); gl_FragColor = vec4(vec3(0.08 + 0.92 * d), 1.0); }'
	});
}

/** Arms hang this many degrees out from straight down when "Arms out" is 0. */
const ARMS_DOWN_DEGREES = 9;

function marker(p, [start, count]) {
	let x = 0, y = 0, z = 0;
	for (let i = start; i < start + count; i++) { x += p[i * 3]; y += p[i * 3 + 1]; z += p[i * 3 + 2]; }
	return [x / count, y / count, z / count];
}

/**
 * Pose the arms in the body's front plane. MakeHuman's mesh is modelled with the arms raised
 * about 45 degrees; amount 0 lowers them to the sides like a standing figure, 1 leaves them as
 * modelled. Linear blend skinning with MakeHuman's own weights: the shoulder bone turns a
 * fifth of the way, the whole arm below it the rest, each about its own joint.
 */
function poseArms(p, amount) {
	const d = meshData;
	if (amount >= 1 || !d.skin['arm.L'] || !d.markers['upperarm01.L']) return;
	for (const side of ['L', 'R']) {
		const shoulder = marker(p, d.markers[`shoulder01.${side}`]);
		const upper = marker(p, d.markers[`upperarm01.${side}`]);
		const wrist = marker(p, d.markers[`wrist.${side}`]);
		const out = Math.sign(wrist[0] - upper[0]) || 1;
		const now = Math.atan2(Math.abs(wrist[0] - upper[0]), upper[1] - wrist[1]);
		const down = (ARMS_DOWN_DEGREES * Math.PI) / 180;
		const turn = (now - (down + amount * (now - down))) * out; // lower the arm towards the body
		if (Math.abs(turn) < 1e-4) continue;
		const rot = (angle, [px, py]) => { const c = Math.cos(angle), s = Math.sin(angle); return (x, y) => [px + (x - px) * c + (y - py) * s, py - (x - px) * s + (y - py) * c]; };
		const rs = rot(turn * 0.2, shoulder);
		const ru = rot(turn * 0.8, upper);
		const sw = new Map();
		const sk = d.skin[`shoulder.${side}`];
		for (let i = 0; i < sk.idx.length; i++) sw.set(sk.idx[i], sk.w[i]);
		const arm = d.skin[`arm.${side}`];
		const armW = new Map();
		for (let i = 0; i < arm.idx.length; i++) armW.set(arm.idx[i], arm.w[i]);
		const moved = new Set([...sw.keys(), ...armW.keys()]);
		for (const i of moved) {
			const x = p[i * 3], y = p[i * 3 + 1];
			const ws = sw.get(i) || 0, wa = armW.get(i) || 0;
			const [sx, sy] = rs(x, y);
			const [ux, uy] = ru(x, y);
			const [ax, ay] = rs(ux, uy);
			const keep = Math.max(0, 1 - ws - wa);
			p[i * 3] = keep * x + ws * sx + wa * ax;
			p[i * 3 + 1] = keep * y + ws * sy + wa * ay;
		}
		// Move the joint markers too, so they stay where the posed arm is.
		const move = ([start, count], f) => { for (let i = start; i < start + count; i++) { const [x, y] = f(p[i * 3], p[i * 3 + 1]); p[i * 3] = x; p[i * 3 + 1] = y; } };
		move(d.markers[`upperarm01.${side}`], rs);
		move(d.markers[`wrist.${side}`], (x, y) => rs(...ru(x, y)));
	}
}

/** The smooth (subdivided) surface for shaped base positions `p`, written into `out`. */
export function subdivide(p, out) {
	const s = meshData.subdiv;
	const o = out || new Float32Array(s.count * 3);
	for (let r = 0; r < s.count; r++) {
		let x = 0, y = 0, z = 0;
		for (let k = s.starts[r]; k < s.starts[r + 1]; k++) {
			const c = s.cols[k] * 3, w = s.weights[k];
			x += p[c] * w; y += p[c + 1] * w; z += p[c + 2] * w;
		}
		o[r * 3] = x; o[r * 3 + 1] = y; o[r * 3 + 2] = z;
	}
	return o;
}

/**
 * Vertex normals of the base mesh (area-weighted), for smoothing with subdivide(): about ten
 * times cheaper than computing them on the fine mesh, so dragging a slider stays fluid.
 */
export function baseNormals(p, out) {
	const idx = meshData.index;
	const n = out || new Float32Array(p.length);
	n.fill(0);
	for (let t = 0; t < idx.length; t += 3) {
		const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
		const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
		const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		for (const k of [a, b, c]) { n[k] += nx; n[k + 1] += ny; n[k + 2] += nz; }
	}
	return n;
}

function normalize(n) {
	for (let i = 0; i < n.length; i += 3) {
		const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
		n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
	}
}

/**
 * Bring the feet together, as character creators stand their figures: MakeHuman's mesh stands
 * with the feet wide apart. Each leg turns in at the hip; the foot turns back the same amount
 * about the ankle so the soles stay flat. "Feet apart" 1 keeps the modelled stance.
 */
const FEET_TOGETHER = 0.6; // ankles end at this fraction of the hip joints' spread

function poseLegs(p, amount) {
	const d = meshData;
	if (amount >= 1 || !d.skin['leg.L'] || !d.markers['upperleg01.L']) return;
	for (const side of ['L', 'R']) {
		const hip = marker(p, d.markers[`upperleg01.${side}`]);
		const ankle = marker(p, d.markers[`foot.${side}`]);
		const drop = hip[1] - ankle[1];
		const now = Math.atan2(ankle[0] - hip[0], drop);
		const targetX = hip[0] * FEET_TOGETHER + amount * (ankle[0] - hip[0] * FEET_TOGETHER);
		const turn = now - Math.atan2(targetX - hip[0], drop);
		if (Math.abs(turn) < 1e-4) continue;
		const rot = (angle, [px, py]) => { const c = Math.cos(angle), s = Math.sin(angle); return (x, y) => [px + (x - px) * c + (y - py) * s, py - (x - px) * s + (y - py) * c]; };
		const rh = rot(turn, hip);
		const ra = rot(-turn, ankle);
		const weightsOf = (name) => { const m = new Map(), e = d.skin[name]; for (let i = 0; i < e.idx.length; i++) m.set(e.idx[i], e.w[i]); return m; };
		const wl = weightsOf(`leg.${side}`), wf = weightsOf(`foot.${side}`);
		for (const i of new Set([...wl.keys(), ...wf.keys()])) {
			const x = p[i * 3], y = p[i * 3 + 1];
			const l = wl.get(i) || 0, f = wf.get(i) || 0;
			const [lx, ly] = rh(x, y);
			const [fx, fy] = rh(...ra(x, y));
			const keep = Math.max(0, 1 - l - f);
			p[i * 3] = keep * x + l * lx + f * fx;
			p[i * 3 + 1] = keep * y + l * ly + f * fy;
		}
		const move = ([start, count], fn) => { for (let i = start; i < start + count; i++) { const [x, y] = fn(p[i * 3], p[i * 3 + 1]); p[i * 3] = x; p[i * 3 + 1] = y; } };
		move(d.markers[`foot.${side}`], rh);
	}
}

function eyeCentre(p, [start, count]) {
	const c = new THREE.Vector3();
	for (let i = start; i < start + count; i++) c.add(new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]));
	return c.divideScalar(count);
}

// ---------- the viewer ----------

/**
 * A live 3D view inside `container`. Drag sideways to turn the figure. `update(values)` reshapes
 * it; `snapshot(w, h, angle, mode)` renders a plain picture of it for the image engine.
 */
export function createViewer(container) {
	// Transparent, so the studio backdrop behind it (in CSS) shows through.
	const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.05;
	renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
	container.append(renderer.domElement);
	const scene = new THREE.Scene();
	scene.background = null;
	// Studio lighting for a clay figure: soft sky fill, a key light from the upper left, a fill
	// from the right and a rim from behind, so muscle and curves read clearly.
	scene.add(new THREE.HemisphereLight('#ffffff', '#5c6068', 1.25));
	const key = new THREE.DirectionalLight('#ffffff', 2.4);
	key.position.set(-120, 220, 160);
	scene.add(key);
	const fill = new THREE.DirectionalLight('#eef2ff', 0.7);
	fill.position.set(150, 80, 120);
	scene.add(fill);
	const rim = new THREE.DirectionalLight('#ffffff', 1.1);
	rim.position.set(60, 160, -180);
	scene.add(rim);
	// A smooth, light-grey clay finish.
	const material = new THREE.MeshStandardMaterial({ color: '#e4e2df', roughness: 0.58, metalness: 0 });
	const group = new THREE.Group();
	scene.add(group);
	const camera = new THREE.PerspectiveCamera(22, 1, 1, 5000);
	let yaw = 0;
	let height = 170;
	let reach = 40;
	let geometry = null;
	let basePos = null;
	let baseNrm = null;
	const eyes = [];
	let ready = null;
	let current = null;

	function frame(cam, aspect) {
		// Fit the figure's height and its widest reach (whichever turn it is at), so it fills
		// a narrow column as well as a wide one.
		const t = Math.tan((cam.fov * Math.PI) / 360);
		const distance = Math.max((height / 0.88 / 2) / t, (reach / 0.92) / (t * aspect)) + 20;
		cam.aspect = aspect;
		cam.position.set(0, height * 0.5, distance);
		cam.lookAt(0, height * 0.49, 0);
		cam.updateProjectionMatrix();
	}

	function resize() {
		const w = container.clientWidth || 300;
		const h = container.clientHeight || 400;
		renderer.setSize(w, h, false);
		frame(camera, w / h);
		draw();
	}

	function draw() {
		group.rotation.y = yaw;
		renderer.render(scene, camera);
	}

	function loaded(d) {
		// Shapes and poses work on the base mesh; what is drawn is its smoothed version.
		basePos = new Float32Array(d.count * 3);
		const smooth = Boolean(d.subdiv);
		geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((smooth ? d.subdiv.count : d.count) * 3), 3));
		geometry.setIndex(new THREE.BufferAttribute(smooth ? d.subdiv.index : d.index, 1));
		if (smooth) { geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(d.subdiv.count * 3), 3)); baseNrm = new Float32Array(d.count * 3); }
		group.add(new THREE.Mesh(geometry, material));
		// The base mesh has open eye sockets; plain eyeballs close them, as on a shop mannequin.
		for (let i = 0; i < 2; i++) {
			const eye = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), material);
			eyes.push(eye);
			group.add(eye);
		}
	}

	ready = loadHuman().then(loaded).catch((err) => {
		container.textContent = `The body model could not load: ${err.message}`;
		throw err;
	});

	// While a slider is dragged it can fire many times per frame; reshape once per frame at most.
	let pending = null;
	function update(values) {
		const first = pending === null;
		pending = values;
		if (first) ready.then(() => requestAnimationFrame(() => { if (pending) { const v = pending; pending = null; reshape(v); } }), () => {});
	}

	function reshape(values) {
		current = values;
		const pos = geometry.attributes.position;
		shapeBody(values, basePos);
		if (meshData.subdiv) {
			subdivide(basePos, pos.array);
			const nrm = geometry.attributes.normal;
			subdivide(baseNormals(basePos, baseNrm), nrm.array);
			normalize(nrm.array);
			nrm.needsUpdate = true;
		} else {
			pos.array.set(basePos.subarray(0, pos.array.length));
			geometry.computeVertexNormals();
		}
		pos.needsUpdate = true;
		geometry.computeBoundingBox();
		geometry.computeBoundingSphere();
		height = values.height || 170;
		reach = 0;
		const arr = basePos;
		for (let i = 0; i < meshData.eyes[0][0]; i++) reach = Math.max(reach, Math.hypot(arr[i * 3], arr[i * 3 + 2]));
		const r = height * 0.0068;
		meshData.eyes.forEach((e, i) => {
			eyes[i].position.copy(eyeCentre(basePos, e));
			eyes[i].scale.setScalar(r);
		});
		resize();
	}

	// Turn by dragging; tap the view buttons to snap.
	let dragging = null;
	renderer.domElement.addEventListener('pointerdown', (e) => { dragging = e.clientX; renderer.domElement.setPointerCapture(e.pointerId); });
	renderer.domElement.addEventListener('pointermove', (e) => { if (dragging === null) return; yaw += (e.clientX - dragging) * 0.012; dragging = e.clientX; draw(); });
	renderer.domElement.addEventListener('pointerup', () => { dragging = null; });
	renderer.domElement.addEventListener('pointercancel', () => { dragging = null; });
	renderer.domElement.style.touchAction = 'pan-y';
	new ResizeObserver(resize).observe(container);

	return {
		update,
		ready: () => ready,
		setView(angle) { yaw = angle; draw(); },
		/**
		 * A front (or chosen) view at exactly w by h pixels as a PNG blob. 'shape' is the shaded
		 * figure on white; 'depth' is a depth map (near = white, far and background = black), the
		 * kind of picture the Krea 2 depth add-on follows.
		 */
		async snapshot(w, h, angle = 0, mode = 'shape') {
			await ready;
			if (pending) { const v = pending; pending = null; reshape(v); }
			if (!current) throw new Error('the body is still loading');
			const cam = camera.clone();
			const prevBg = scene.background;
			const prevYaw = yaw;
			scene.background = new THREE.Color(mode === 'depth' ? '#000000' : '#ffffff');
			yaw = angle;
			group.rotation.y = yaw;
			group.updateMatrixWorld(true);
			renderer.setPixelRatio(1);
			renderer.setSize(w, h, false);
			frame(cam, w / h);
			if (mode === 'depth') {
				// Linear depth over the body's own front-to-back range: the front of the torso is
				// white and the back is dark. The hands reach a little forward in this pose; they
				// are simply clamped to white so they do not squash the body's range into grey.
				const [near, far] = depthRange(geometry.attributes.position.array, geometry.attributes.position.count, angle, cam.position.z);
				scene.overrideMaterial = depthMaterial(near, far);
			}
			const tone = renderer.toneMapping;
			if (mode === 'depth') renderer.toneMapping = THREE.NoToneMapping;
			renderer.render(scene, cam);
			renderer.toneMapping = tone;
			const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
			scene.overrideMaterial = null;
			scene.background = prevBg;
			yaw = prevYaw;
			renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
			resize();
			return blob;
		}
	};
}
