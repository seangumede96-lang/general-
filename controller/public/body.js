// A parametric 3D mannequin for the body editor. Every part is generated from numbers, so
// any slider change rebuilds the figure instantly. Units are centimetres; +Y is up, +Z faces
// the viewer, the soles stand on y = 0.
import * as THREE from './vendor/three/three.module.js';

/** Starting proportions for each base body. Widths are full widths, depths front-to-back. */
const BASES = {
	female: {
		height: 168, head: { w: 14.5, h: 21.5, d: 18.5 }, neck: { len: 8, r: 5 },
		shoulders: 37, chest: { w: 29, d: 21 }, bust: 1, waist: { w: 25, d: 18.5 }, hips: { w: 36, d: 23 }, glutes: 1,
		thigh: 8.6, knee: 5, calf: 5.8, ankle: 3.3, upperArm: 4.2, forearm: 3.5, wrist: 2.5,
		torsoLen: 0.31, legLen: 0.48, armLen: 0.40
	},
	male: {
		height: 178, head: { w: 15.5, h: 23, d: 20 }, neck: { len: 8.5, r: 6.3 },
		shoulders: 44, chest: { w: 34, d: 24 }, bust: 0, waist: { w: 30, d: 21.5 }, hips: { w: 34, d: 22 }, glutes: 0.7,
		thigh: 9.2, knee: 5.6, calf: 6.4, ankle: 3.8, upperArm: 5, forearm: 4.1, wrist: 3,
		torsoLen: 0.315, legLen: 0.475, armLen: 0.41
	}
};

/** The sliders: key, label, range, step, and whether it is a length (shown vertically). */
export const SLIDERS = [
	{ key: 'height', label: 'Height', min: 140, max: 205, step: 1, unit: 'cm', vertical: true },
	{ key: 'neckLength', label: 'Neck', min: 0.6, max: 1.7, step: 0.01, vertical: true },
	{ key: 'torsoLength', label: 'Torso', min: 0.85, max: 1.18, step: 0.01, vertical: true },
	{ key: 'legLength', label: 'Legs', min: 0.85, max: 1.2, step: 0.01, vertical: true },
	{ key: 'armLength', label: 'Arms', min: 0.88, max: 1.15, step: 0.01, vertical: true },
	{ key: 'headSize', label: 'Head size', min: 0.8, max: 1.25, step: 0.01 },
	{ key: 'neckWidth', label: 'Neck width', min: 0.7, max: 1.45, step: 0.01 },
	{ key: 'shoulders', label: 'Shoulders', min: 0.8, max: 1.3, step: 0.01 },
	{ key: 'chest', label: 'Chest', min: 0.75, max: 1.4, step: 0.01 },
	{ key: 'bust', label: 'Bust', min: 0, max: 2.6, step: 0.01 },
	{ key: 'waist', label: 'Waist', min: 0.6, max: 1.5, step: 0.01 },
	{ key: 'hips', label: 'Hips', min: 0.75, max: 1.6, step: 0.01 },
	{ key: 'glutes', label: 'Glutes', min: 0, max: 2.4, step: 0.01 },
	{ key: 'thighs', label: 'Thighs', min: 0.7, max: 1.7, step: 0.01 },
	{ key: 'calves', label: 'Calves', min: 0.75, max: 1.5, step: 0.01 },
	{ key: 'arms', label: 'Arm thickness', min: 0.7, max: 1.6, step: 0.01 }
];

/** Head shapes: width, height and depth ratios applied on top of head size. */
export const HEAD_SHAPES = { oval: [1, 1, 1], round: [1.08, 0.94, 1.03], long: [0.93, 1.1, 0.98], heart: [1.05, 1.02, 0.97], square: [1.07, 0.97, 1.02] };

/** Default slider values for a base body (1 means "as the base"). */
export function defaults(base = 'female') {
	const b = BASES[base];
	const v = { base, headShape: 'oval' };
	for (const s of SLIDERS) v[s.key] = s.key === 'height' ? b.height : s.key === 'bust' ? b.bust : s.key === 'glutes' ? b.glutes : 1;
	return v;
}

/** Whole-body presets on top of a base. */
export const PRESETS = {
	female: {
		Slim: { waist: 0.88, hips: 0.92, thighs: 0.88, bust: 0.7, glutes: 0.7, arms: 0.88 },
		Athletic: { shoulders: 1.06, waist: 0.95, thighs: 1.05, calves: 1.08, arms: 1.1, bust: 0.9 },
		Hourglass: { waist: 0.8, hips: 1.18, bust: 1.6, glutes: 1.4, thighs: 1.12 },
		Pear: { shoulders: 0.94, bust: 0.7, waist: 0.9, hips: 1.25, glutes: 1.5, thighs: 1.3 },
		Curvy: { waist: 1.05, hips: 1.25, bust: 1.9, glutes: 1.7, thighs: 1.35, arms: 1.15, calves: 1.15 }
	},
	male: {
		Slim: { shoulders: 0.94, chest: 0.9, waist: 0.9, arms: 0.88, thighs: 0.9 },
		Athletic: { shoulders: 1.08, chest: 1.08, waist: 0.92, arms: 1.15, thighs: 1.08, calves: 1.08 },
		Muscular: { shoulders: 1.18, chest: 1.22, waist: 0.98, arms: 1.4, thighs: 1.25, calves: 1.2, neckWidth: 1.25 },
		Stocky: { shoulders: 1.08, chest: 1.15, waist: 1.25, hips: 1.1, thighs: 1.2, arms: 1.2, legLength: 0.93 },
		Tall: { height: 192, legLength: 1.06, torsoLength: 1.02 }
	}
};

// ---------- geometry helpers ----------

/** Catmull-Rom through keys [[t, value], ...] sorted by t. */
function curve(keys, t) {
	if (t <= keys[0][0]) return keys[0][1];
	if (t >= keys.at(-1)[0]) return keys.at(-1)[1];
	let i = 0;
	while (keys[i + 1][0] < t) i++;
	const [t1, p1] = keys[i];
	const [t2, p2] = keys[i + 1];
	const p0 = (keys[i - 1] || keys[i])[1];
	const p3 = (keys[i + 2] || keys[i + 1])[1];
	const u = (t - t1) / (t2 - t1);
	const u2 = u * u;
	const u3 = u2 * u;
	return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

/** A tube from `from` to `to` whose cross-section at fraction t is an ellipse rx(t) by rz(t). */
function tube(from, to, rx, rz = rx, rings = 18, seg = 22) {
	const dir = new THREE.Vector3().subVectors(to, from);
	const len = dir.length();
	const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
	const pos = [];
	const idx = [];
	for (let i = 0; i <= rings; i++) {
		const t = i / rings;
		const a = rx(t);
		const b = rz(t);
		for (let j = 0; j <= seg; j++) {
			const th = (j / seg) * Math.PI * 2;
			const p = new THREE.Vector3(Math.cos(th) * a, t * len, Math.sin(th) * b).applyQuaternion(q).add(from);
			pos.push(p.x, p.y, p.z);
		}
	}
	for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
		const a = i * (seg + 1) + j;
		const b = a + seg + 1;
		idx.push(a, b, a + 1, b, b + 1, a + 1);
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	g.setIndex(idx);
	g.computeVertexNormals();
	return g;
}

function blob(center, rx, ry, rz) {
	const g = new THREE.SphereGeometry(1, 28, 20);
	g.scale(rx, ry, rz);
	g.translate(center.x, center.y, center.z);
	return g;
}

/**
 * The torso as one surface: rings from the crotch to the base of the neck, each a rounded
 * rectangle-ish ellipse with separate front and back depths (for chest and glutes).
 */
function torso(y0, y1, keysW, keysFront, keysBack, rings = 40, seg = 40) {
	const pos = [];
	const idx = [];
	const n = 2.4; // superellipse: slightly squarer than an ellipse, like a real torso
	for (let i = 0; i <= rings; i++) {
		const t = i / rings;
		const y = y0 + (y1 - y0) * t;
		const w = curve(keysW, t) / 2;
		const df = curve(keysFront, t);
		const db = curve(keysBack, t);
		for (let j = 0; j <= seg; j++) {
			const th = (j / seg) * Math.PI * 2;
			const c = Math.cos(th);
			const s = Math.sin(th);
			const x = w * Math.sign(c) * Math.abs(c) ** (2 / n);
			const z = (s >= 0 ? df : db) * Math.sign(s) * Math.abs(s) ** (2 / n);
			pos.push(x, y, z);
		}
	}
	for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
		const a = i * (seg + 1) + j;
		const b = a + seg + 1;
		idx.push(a, b, a + 1, b, b + 1, a + 1);
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	g.setIndex(idx);
	g.computeVertexNormals();
	return g;
}

/** Build every part of the body for the given slider values; returns geometries and the total height. */
export function buildBody(v) {
	const b = BASES[v.base] || BASES.female;
	const female = v.base !== 'male';
	const hs = HEAD_SHAPES[v.headShape] || HEAD_SHAPES.oval;
	const H = v.height;
	// Lengths in proportion to height, then adjusted by the length sliders; the whole figure is
	// rescaled at the end so it is exactly the chosen height.
	const head = { w: b.head.w * v.headSize * hs[0], h: b.head.h * v.headSize * hs[1], d: b.head.d * v.headSize * hs[2] };
	const neckLen = b.neck.len * v.neckLength;
	const torsoLen = b.torsoLen * b.height * v.torsoLength;
	const legLen = b.legLen * b.height * v.legLength;
	const footH = 0.04 * b.height;
	const raw = footH + legLen + torsoLen + neckLen + head.h * 0.92;
	const k = H / raw;

	const parts = [];
	const add = (g) => { g.scale(k, k, k); parts.push(g); };
	const V = (x, y, z) => new THREE.Vector3(x, y, z);

	const crotchY = footH + legLen;
	const neckBaseY = crotchY + torsoLen;
	const hipW = b.hips.w * v.hips;
	const waistW = b.waist.w * v.waist;
	const chestW = b.chest.w * v.chest;
	const shoulderW = b.shoulders * v.shoulders;
	const neckR = b.neck.r * v.neckWidth;
	const glute = v.glutes;

	// Torso: crotch, widest hip, lower hip, waist, under-chest, chest, armpit, shoulder line, neck base.
	const keysW = [[0, hipW * 0.6], [0.06, hipW * 0.9], [0.13, hipW], [0.3, hipW * 0.93 + waistW * 0.07], [0.47, waistW], [0.62, (waistW + chestW) / 2], [0.74, chestW], [0.86, chestW * 0.98], [0.93, shoulderW * 0.82], [1, neckR * 2.4]];
	const hipD = b.hips.d * v.hips;
	const keysFront = [[0, hipD * 0.3], [0.13, hipD * 0.47], [0.47, b.waist.d * v.waist * 0.5], [0.74, b.chest.d * v.chest * 0.52], [0.9, b.chest.d * v.chest * 0.42], [1, neckR * 1.1]];
	const keysBack = [[0, hipD * 0.32 * (0.85 + glute * 0.18)], [0.13, hipD * 0.5 * (0.8 + glute * 0.25)], [0.3, hipD * 0.45], [0.47, b.waist.d * v.waist * 0.48], [0.74, b.chest.d * v.chest * 0.47], [1, neckR * 1.15]];
	add(torso(crotchY - 2, neckBaseY, keysW, keysFront, keysBack));
	add(blob(V(0, crotchY - 1.5, 0), hipW * 0.3, 3.5, hipD * 0.3)); // closes the bottom of the torso

	// Glutes and bust as rounded volumes on the torso surface.
	if (glute > 0.05) for (const s of [-1, 1]) add(blob(V(s * hipW * 0.2, crotchY + torsoLen * 0.1, -hipD * 0.3), hipW * 0.21 * (0.7 + glute * 0.25), torsoLen * 0.1 * (0.8 + glute * 0.2), hipD * 0.22 * (0.6 + glute * 0.35)));
	const bust = v.bust;
	if (bust > 0.05) for (const s of [-1, 1]) {
		const r = 5.2 * (0.5 + bust * 0.42);
		add(blob(V(s * chestW * 0.22, crotchY + torsoLen * 0.71, b.chest.d * v.chest * 0.38), r, r * 0.92, r * 0.85));
	}

	// Neck and head.
	add(tube(V(0, neckBaseY - 2, 0), V(0, neckBaseY + neckLen + 2, -0.5), (t) => neckR * (1.1 - t * 0.12), (t) => neckR * (1.05 - t * 0.1)));
	const headCenter = V(0, neckBaseY + neckLen + head.h * 0.42, 0.4);
	add(blob(headCenter, head.w / 2, head.h / 2, head.d / 2));
	add(blob(V(0, headCenter.y - head.h * 0.2, head.d * 0.06), head.w * 0.38, head.h * 0.24, head.d * 0.38)); // jaw, mostly inside the head

	// Legs: hip joint, knee, ankle, with a thigh, knee and calf profile.
	const thighR = b.thigh * v.thighs;
	const calfR = b.calf * v.calves;
	const kneeR = b.knee * (0.75 + v.thighs * 0.25);
	const ankleR = b.ankle * (0.85 + v.calves * 0.15);
	for (const s of [-1, 1]) {
		const hip = V(s * hipW * 0.24, crotchY + torsoLen * 0.13, 0);
		const ankle = V(s * hipW * 0.17, footH + 2, -1);
		const knee = hip.clone().lerp(ankle, 0.52);
		add(tube(hip, knee, (t) => curve([[0, Math.min(thighR * 1.15, hipW * 0.26)], [0.22, thighR * 1.05], [0.45, thighR], [1, kneeR]], t), (t) => curve([[0, thighR * 1.1], [0.4, thighR * 0.95], [1, kneeR * 1.05]], t)));
		add(tube(knee, ankle, (t) => curve([[0, kneeR], [0.28, calfR], [0.7, calfR * 0.7], [1, ankleR]], t), (t) => curve([[0, kneeR * 1.05], [0.3, calfR * 1.1], [1, ankleR]], t)));
		add(blob(knee, kneeR, kneeR * 1.1, kneeR));
		add(blob(V(ankle.x, footH * 0.55, 4.2), ankleR * 1.15, footH * 0.6, 12 * (b.height / 170)));
	}

	// Arms in a relaxed A-pose, about 16 degrees out from the body.
	const armLen = b.armLen * b.height * v.armLength;
	const upperR = b.upperArm * v.arms;
	const foreR = b.forearm * (0.8 + v.arms * 0.2);
	const wristR = b.wrist * (0.9 + v.arms * 0.1);
	const angle = (16 * Math.PI) / 180;
	for (const s of [-1, 1]) {
		const shoulder = V(s * shoulderW * 0.43, neckBaseY - 4, -0.5);
		const out = V(s * Math.sin(angle), -Math.cos(angle), 0);
		const elbow = shoulder.clone().addScaledVector(out, armLen * 0.46);
		const wrist = shoulder.clone().addScaledVector(out, armLen * 0.86);
		add(blob(shoulder, upperR * 1.25, upperR * 1.2, upperR * 1.15)); // shoulder cap
		add(tube(shoulder, elbow, (t) => curve([[0, upperR * 1.1], [0.4, upperR], [1, upperR * 0.75]], t)));
		add(tube(elbow, wrist, (t) => curve([[0, foreR * 0.9], [0.25, foreR], [1, wristR]], t), (t) => curve([[0, foreR * 0.85], [1, wristR * 0.75]], t)));
		add(blob(elbow, upperR * 0.78, upperR * 0.8, upperR * 0.78));
		add(blob(wrist.clone().addScaledVector(out, armLen * 0.07), wristR * 1.2, armLen * 0.08, wristR * 0.6)); // hand
	}
	return { parts, height: H };
}

// ---------- the viewer ----------

/**
 * A live 3D view inside `container`. Drag sideways to turn the figure. `update(values)` rebuilds
 * it; `snapshot(w, h, view)` renders a plain picture of it for the image engine.
 */
export function createViewer(container) {
	const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
	renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
	container.append(renderer.domElement);
	const scene = new THREE.Scene();
	scene.background = new THREE.Color('#f4f4f4');
	scene.add(new THREE.HemisphereLight('#ffffff', '#8a8a8a', 1.6));
	const key = new THREE.DirectionalLight('#ffffff', 1.6);
	key.position.set(80, 160, 140);
	scene.add(key);
	const rim = new THREE.DirectionalLight('#ffffff', 0.5);
	rim.position.set(-120, 80, -100);
	scene.add(rim);
	const material = new THREE.MeshStandardMaterial({ color: '#c9a48d', roughness: 0.75, metalness: 0 });
	const group = new THREE.Group();
	scene.add(group);
	const camera = new THREE.PerspectiveCamera(22, 1, 1, 5000);
	let yaw = 0;
	let height = 170;

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

	// While a slider is dragged it can fire many times per frame; rebuild once per frame at most.
	let pending = null;
	function update(values) {
		const first = pending === null;
		pending = values;
		if (first) requestAnimationFrame(() => { const v = pending; pending = null; rebuild(v); });
	}

	function rebuild(values) {
		for (const m of group.children) m.geometry.dispose();
		group.clear();
		const built = buildBody(values);
		height = built.height;
		for (const g of built.parts) group.add(new THREE.Mesh(g, material));
		resize();
	}

	// Turn by dragging; tap the view buttons to snap.
	let dragging = null;
	renderer.domElement.addEventListener('pointerdown', (e) => { dragging = e.clientX; renderer.domElement.setPointerCapture(e.pointerId); });
	renderer.domElement.addEventListener('pointermove', (e) => { if (dragging === null) return; yaw += (e.clientX - dragging) * 0.012; dragging = e.clientX; draw(); });
	renderer.domElement.addEventListener('pointerup', () => { dragging = null; });
	renderer.domElement.style.touchAction = 'pan-y';
	new ResizeObserver(resize).observe(container);

	return {
		update,
		setView(angle) { yaw = angle; draw(); },
		/**
		 * A front (or chosen) view at exactly w by h pixels as a PNG blob. 'shape' is the shaded
		 * figure on white; 'depth' is a depth map (near = white, far and background = black), the
		 * kind of picture the Krea 2 depth add-on follows.
		 */
		async snapshot(w, h, angle = 0, mode = 'shape') {
			if (pending) { const v = pending; pending = null; rebuild(v); }
			const cam = camera.clone();
			const prevBg = scene.background;
			const prevYaw = yaw;
			scene.background = new THREE.Color(mode === 'depth' ? '#000000' : '#ffffff');
			if (mode === 'depth') scene.overrideMaterial = new THREE.MeshDepthMaterial();
			yaw = angle;
			group.rotation.y = yaw;
			renderer.setPixelRatio(1);
			renderer.setSize(w, h, false);
			frame(cam, w / h);
			if (mode === 'depth') {
				// Clip exactly to the body's front-to-back extent, so its nearest point is white,
				// its farthest is near black, and the whole range shows the curves.
				const box = new THREE.Box3().setFromObject(group);
				const d = cam.position.z;
				cam.near = Math.max(1, d - box.max.z - 1);
				cam.far = d - box.min.z + 6;
				cam.updateProjectionMatrix();
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
