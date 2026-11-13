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
	{ key: 'height', label: 'Height', min: 140, max: 205, step: 1, unit: 'cm', vertical: true },
	{ key: 'neckLength', label: 'Neck', min: -1.3, max: 1.3, step: 0.01, vertical: true },
	{ key: 'torsoLength', label: 'Torso', min: -1.3, max: 1.3, step: 0.01, vertical: true },
	{ key: 'legLength', label: 'Legs', min: -1.3, max: 1.3, step: 0.01, vertical: true },
	{ key: 'armLength', label: 'Arms', min: -1.3, max: 1.3, step: 0.01, vertical: true },
	{ key: 'weight', label: 'Weight', min: -1, max: 1, step: 0.01 },
	{ key: 'muscle', label: 'Muscle', min: -1, max: 1, step: 0.01 },
	{ key: 'headSize', label: 'Head size', min: -1, max: 1, step: 0.01 },
	{ key: 'neckWidth', label: 'Neck width', min: -1.2, max: 1.2, step: 0.01 },
	{ key: 'shoulders', label: 'Shoulders', min: -1.2, max: 1.2, step: 0.01 },
	{ key: 'chest', label: 'Chest', min: -1.2, max: 1.2, step: 0.01 },
	{ key: 'bust', label: 'Bust', min: -1, max: 1.5, step: 0.01 },
	{ key: 'waist', label: 'Waist', min: -1.2, max: 1.3, step: 0.01 },
	{ key: 'hips', label: 'Hips', min: -1.2, max: 1.5, step: 0.01 },
	{ key: 'glutes', label: 'Glutes', min: -1, max: 1.5, step: 0.01 },
	{ key: 'belly', label: 'Belly', min: -1, max: 1, step: 0.01 },
	{ key: 'thighs', label: 'Thighs', min: -1.2, max: 1.5, step: 0.01 },
	{ key: 'thighGap', label: 'Thigh gap', min: -1, max: 1.3, step: 0.01 },
	{ key: 'bowLegs', label: 'Bow legs', min: -1.3, max: 1.5, step: 0.01 },
	{ key: 'calves', label: 'Calves', min: -1.2, max: 1.3, step: 0.01 },
	{ key: 'arms', label: 'Arm thickness', min: -1.2, max: 1.4, step: 0.01 }
];

/** Which morph targets each slider drives, and how strongly. */
const DRIVES = {
	neckLength: [['neck-height', 1]],
	torsoLength: [['napetowaist-dist', 1], ['waisttohip-dist', 0.5]],
	legLength: [['upperleg-height', 1], ['lowerleg-height', 1]],
	armLength: [['upperarm-length', 1], ['lowerarm-length', 1]],
	headSize: [['head-height', 1], ['head-width', 1]],
	neckWidth: [['neck-circ', 1]],
	shoulders: [['shoulder-dist', 1]],
	chest: [['frontchest-dist', 1], ['bust-circ', 0.6], ['torso-depth', 0.4]],
	bust: [['cup', 1]],
	waist: [['waist-circ', 1]],
	hips: [['hips-circ', 1], ['hip-depth', 0.4]],
	glutes: [['glutes', 1]],
	belly: [['belly', 1]],
	thighs: [['thigh-circ', 1]],
	thighGap: [['thigh-gap', 1]],
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

/** Whole-body presets on top of a base. */
export const PRESETS = {
	female: {
		Slim: { weight: -0.6, waist: -0.4, hips: -0.3, thighs: -0.4, bust: -0.4, glutes: -0.4 },
		Athletic: { muscle: 0.6, weight: -0.2, shoulders: 0.3, waist: -0.2, thighs: 0.2, glutes: 0.3 },
		Hourglass: { waist: -0.8, hips: 0.8, bust: 0.9, glutes: 0.8, thighs: 0.4 },
		Pear: { shoulders: -0.3, bust: -0.3, waist: -0.2, hips: 1, glutes: 1, thighs: 0.9 },
		Curvy: { weight: 0.45, hips: 1, bust: 1.2, glutes: 1.1, thighs: 0.8, waist: 0.1 }
	},
	male: {
		Slim: { weight: -0.6, muscle: -0.3, shoulders: -0.3, chest: -0.3 },
		Athletic: { muscle: 0.6, weight: -0.2, shoulders: 0.4, chest: 0.3, waist: -0.3 },
		Muscular: { muscle: 1, weight: 0.2, shoulders: 0.8, chest: 0.7, arms: 0.8, thighs: 0.6, neckWidth: 0.8 },
		Stocky: { weight: 0.7, muscle: 0.3, waist: 0.6, belly: 0.4, legLength: -0.5 },
		Tall: { height: 192, legLength: 0.4, torsoLength: 0.2 }
	}
};

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
	add(g, 1);
	two(`${g}-weight`, v.weight || 0);
	two(`${g}-muscle`, v.muscle || 0);
	for (const [key, drives] of Object.entries(DRIVES)) for (const [name, k] of drives) two(name, (v[key] || 0) * k);
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
	const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
	renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
	container.append(renderer.domElement);
	const scene = new THREE.Scene();
	scene.background = new THREE.Color('#f2f2f2');
	scene.add(new THREE.HemisphereLight('#ffffff', '#7d7d7d', 1.5));
	const key = new THREE.DirectionalLight('#ffffff', 1.7);
	key.position.set(90, 170, 150);
	scene.add(key);
	const rim = new THREE.DirectionalLight('#ffffff', 0.6);
	rim.position.set(-130, 90, -110);
	scene.add(rim);
	// A matte, light-wood mannequin finish.
	const material = new THREE.MeshStandardMaterial({ color: '#d8c3a5', roughness: 0.82, metalness: 0 });
	const group = new THREE.Group();
	scene.add(group);
	const camera = new THREE.PerspectiveCamera(22, 1, 1, 5000);
	let yaw = 0;
	let height = 170;
	let geometry = null;
	const eyes = [];
	let ready = null;
	let current = null;

	function frame(cam, aspect) {
		const fill = 0.86;
		const distance = (height / fill / 2) / Math.tan((cam.fov * Math.PI) / 360) + 20;
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
		geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(d.count * 3), 3));
		geometry.setIndex(new THREE.BufferAttribute(d.index, 1));
		geometry.setDrawRange(0, d.index.length);
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
		shapeBody(values, pos.array);
		pos.needsUpdate = true;
		geometry.computeVertexNormals();
		geometry.computeBoundingBox();
		geometry.computeBoundingSphere();
		height = values.height || 170;
		const r = height * 0.0068;
		meshData.eyes.forEach((e, i) => {
			eyes[i].position.copy(eyeCentre(pos.array, e));
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
				const [near, far] = depthRange(geometry.attributes.position.array, meshData.eyes[0][0], angle, cam.position.z);
				scene.overrideMaterial = depthMaterial(near, far);
			}
			renderer.render(scene, cam);
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
