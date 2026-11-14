// The body editor's depth map, made on the server: the same mannequin code as the editor
// (public/body.js: shape, poses, smoothing, framing and depth range), drawn with a small
// software renderer instead of WebGL, so the app can be driven entirely through its API.
// Output matches the editor's snapshot(w, h, angle, 'depth'): near = white, far and background
// = black. A plain grey shaded preview is made too.
import { readFile } from 'node:fs/promises';
import { deflateSync, crc32 } from 'node:zlib';

const body = await import('../public/body.js');
const FOV_DEGREES = 22; // as the editor's camera

let ready = null;
const load = () => (ready ||= body.loadHuman(undefined, (url) => readFile(url)));

/** Grey 8-bit PNG from a w x h byte array. */
export function pngGray(pixels, w, h) {
	const chunk = (type, data) => {
		const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
	const raw = Buffer.alloc((w + 1) * h);
	for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; pixels.copy ? pixels.copy(raw, y * (w + 1) + 1, y * w, (y + 1) * w) : raw.set(pixels.subarray(y * w, (y + 1) * w), y * (w + 1) + 1); }
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A small UV sphere, for the eyeballs (the mesh has open eye sockets, as in the editor). */
function sphere(cx, cy, cz, r, rings = 8, segs = 12) {
	const pts = [], tris = [];
	for (let i = 0; i <= rings; i++) for (let j = 0; j <= segs; j++) {
		const th = (i / rings) * Math.PI, ph = (j / segs) * Math.PI * 2;
		pts.push(cx + r * Math.sin(th) * Math.cos(ph), cy + r * Math.cos(th), cz + r * Math.sin(th) * Math.sin(ph));
	}
	for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
		const a = i * (segs + 1) + j, b = a + segs + 1;
		tris.push(a, b, a + 1, b, b + 1, a + 1);
	}
	return { pts, tris };
}

/**
 * Render the body for `values` (the editor's slider values) turned `angleDeg` degrees
 * (0 front, 90 side, 180 back) at width x height. Returns { depth, preview } PNG buffers.
 */
export async function renderBody(values, { angleDeg = 0, width = 1024, height = 1536 } = {}) {
	const mesh = await load();
	const v = body.migrate({ version: 2, ...values });
	const base = body.shapeBody(v);
	const fine = body.subdivide(base);
	const normals = body.subdivide(body.baseNormals(base));
	const skin = mesh.eyes[0][0];
	let H = 0, reach = 0;
	for (let i = 0; i < skin; i++) { H = Math.max(H, base[i * 3 + 1]); reach = Math.max(reach, Math.hypot(base[i * 3], base[i * 3 + 2])); }
	// Everything to draw: the smooth surface plus two eyeballs.
	const positions = Array.from(fine);
	const norms = Array.from(normals);
	const tris = Array.from(mesh.subdiv.index);
	for (const [start, count] of mesh.eyes) {
		let x = 0, y = 0, z = 0;
		for (let i = start; i < start + count; i++) { x += base[i * 3]; y += base[i * 3 + 1]; z += base[i * 3 + 2]; }
		const s = sphere(x / count, y / count, z / count, H * 0.0068);
		const off = positions.length / 3;
		positions.push(...s.pts);
		for (let k = 0; k < s.pts.length; k += 3) { const n = [s.pts[k] - x / count, s.pts[k + 1] - y / count, s.pts[k + 2] - z / count]; const l = Math.hypot(...n) || 1; norms.push(n[0] / l, n[1] / l, n[2] / l); }
		tris.push(...s.tris.map((t) => t + off));
	}
	// Camera exactly as the editor frames it.
	const angle = (angleDeg * Math.PI) / 180;
	const aspect = width / height;
	const t = Math.tan((FOV_DEGREES * Math.PI) / 360);
	const distance = Math.max((H / 0.88 / 2) / t, (reach / 0.92) / (t * aspect)) + 20;
	const cam = [0, H * 0.5, distance];
	const target = [0, H * 0.49, 0];
	const f = [target[0] - cam[0], target[1] - cam[1], target[2] - cam[2]];
	const fl = Math.hypot(...f); f[0] /= fl; f[1] /= fl; f[2] /= fl;
	const r = [-f[2], 0, f[0]]; const rl = Math.hypot(...r); r[0] /= rl; r[2] /= rl; // f x up(0,1,0)
	const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
	const [near, far] = body.depthRange(base, skin, angle, distance);
	// Project every vertex once.
	const n = positions.length / 3;
	const sx = new Float32Array(n), sy = new Float32Array(n), zv = new Float32Array(n), shade = new Float32Array(n), facing = new Float32Array(n);
	const cos = Math.cos(angle), sin = Math.sin(angle);
	const light = [-0.45, 0.6, 0.66];
	for (let i = 0; i < n; i++) {
		const x0 = positions[i * 3], y0 = positions[i * 3 + 1], z0 = positions[i * 3 + 2];
		const x = x0 * cos + z0 * sin, z = -x0 * sin + z0 * cos; // the editor turns the figure about its vertical axis
		const d = [x - cam[0], y0 - cam[1], z - cam[2]];
		const xv = d[0] * r[0] + d[1] * r[1] + d[2] * r[2];
		const yv = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
		const zz = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
		zv[i] = zz;
		sx[i] = ((xv / (zz * t * aspect)) * 0.5 + 0.5) * width;
		sy[i] = (1 - ((yv / (zz * t)) * 0.5 + 0.5)) * height;
		let nx = norms[i * 3] * cos + norms[i * 3 + 2] * sin, ny = norms[i * 3 + 1], nz = -norms[i * 3] * sin + norms[i * 3 + 2] * cos;
		const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
		// Towards the camera or away from it (for skipping the far side of the body).
		facing[i] = -(nx * d[0] + ny * d[1] + nz * d[2]);
		shade[i] = 0.3 + 0.7 * Math.max(0, nx * light[0] + ny * light[1] + nz * light[2]);
	}
	// Z-buffered triangles; depth interpolated perspective-correctly (through 1/z).
	const zbuf = new Float32Array(width * height).fill(Infinity);
	const depth = Buffer.alloc(width * height, 0);
	const preview = Buffer.alloc(width * height, 255);
	for (let k = 0; k < tris.length; k += 3) {
		const a = tris[k], b = tris[k + 1], c = tris[k + 2];
		if (zv[a] <= 1 || zv[b] <= 1 || zv[c] <= 1) continue;
		if (facing[a] < 0 && facing[b] < 0 && facing[c] < 0) continue; // the far side of the body: hidden anyway
		const x0 = sx[a], y0 = sy[a], x1 = sx[b], y1 = sy[b], x2 = sx[c], y2 = sy[c];
		const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
		if (Math.abs(area) < 1e-9) continue;
		const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)));
		const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)));
		const ia = 1 / zv[a], ib = 1 / zv[b], ic = 1 / zv[c];
		for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
			const qx = px + 0.5, qy = py + 0.5;
			const w0 = ((x1 - qx) * (y2 - qy) - (x2 - qx) * (y1 - qy)) / area;
			const w1 = ((x2 - qx) * (y0 - qy) - (x0 - qx) * (y2 - qy)) / area;
			const w2 = 1 - w0 - w1;
			if (w0 < 0 || w1 < 0 || w2 < 0) continue;
			const z = 1 / (w0 * ia + w1 * ib + w2 * ic);
			const o = py * width + px;
			if (z >= zbuf[o]) continue;
			zbuf[o] = z;
			const dv = Math.min(1, Math.max(0, (far - z) / (far - near)));
			depth[o] = Math.round((0.08 + 0.92 * dv) * 255);
			preview[o] = Math.round(255 * (w0 * shade[a] + w1 * shade[b] + w2 * shade[c]));
		}
	}
	return { depth: pngGray(depth, width, height), preview: pngGray(preview, width, height) };
}

/** Every draggable point of a posed body (centimetres; x her left, y up from the floor, z her front). */
export async function posePoints(values) {
	await load();
	const v = body.migrate({ version: 2, ...values, posing: true });
	return { values: v, points: body.createPoser(v).points(v.pose) };
}

/**
 * Pose a body so named points reach targets: goals { 'hand.L': [x, y, z], ... } in centimetres,
 * heights from the floor as the body stands before solving. Starts from the body's own pose, so
 * set a preset or rough angles first for big changes. Returns the body code (Pose mode on), where
 * every point ended up, and how far each goal was missed (cm).
 */
export async function solvePose(values, goals, { feetPlanted = true } = {}) {
	await load();
	const v = body.migrate({ version: 2, ...values, posing: true });
	const known = new Set(Object.keys(body.createPoser(v).rest.effectors));
	for (const k of Object.keys(goals)) if (!known.has(k)) throw new Error(`Unknown point "${k}". Points: ${[...known].join(', ')}.`);
	const P = body.createPoser(v);
	const floor = P.floor(v.pose);
	let pose = v.pose;
	// A few rounds, each starting from the last, so far targets are reached step by step.
	for (let i = 0; i < 4; i++) pose = P.solve(pose, goals, { feetPlanted, iterations: 30, floor, pins: P.pins(v.pose) });
	const points = P.points(pose, floor);
	const missed = Object.fromEntries(Object.entries(goals).map(([k, t]) => [k, Math.round(Math.hypot(points[k][0] - t[0], points[k][1] - t[1], points[k][2] - t[2]) * 10) / 10]));
	return { values: { ...v, pose }, points: P.points(pose), missed };
}
