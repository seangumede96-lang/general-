// Stage 5: hip, butt and thigh shape library. 15 procedural targets made from the existing mesh
// (no outside data): each displacement is built from MakeHuman's own buttock, hip and thigh
// regions, then Laplacian-smoothed 25 times so it fades out with no edges. Peak 3 cm at 1.0
// (shelf 3.5 cm, fold 1.5 cm). Written by the owner's phone session and checked there on
// grey mannequin sheets and an extreme stress test (all targets at 1.5 on a thick body).
//
//   node tools/hipglute-lib.mjs          (after tools/build-human.py)
//
// Appends the targets (and their "-down" mirrors) to public/vendor/makehuman/human.bin and
// human.json. Running it again replaces them: it cuts the file back to where they start.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dir = new URL('../public/vendor/makehuman/', import.meta.url);
const layout = JSON.parse(await readFile(new URL('human.json', dir), 'utf8'));
let bin = await readFile(new URL('human.bin', dir));
if (layout.libraryStart) {
	bin = bin.subarray(0, layout.libraryStart);
	layout.morphs = layout.morphs.filter((m) => !m.library);
	delete layout.libraryStart;
	await writeFile(new URL('human.json', dir), JSON.stringify(layout));
	await writeFile(new URL('human.bin', dir), bin);
}
const body = await import('../public/body.js');
const d = await body.loadHuman(undefined, (u) => readFile(u));

// ---- the owner's phone session's generator (tools/hipglute-lib.mjs), unchanged in substance ----
const n = d.count, P = Float32Array.from(d.base);
const addM = (name, k) => { const m = d.morphs[name]; for (let i = 0; i < m.idx.length; i++) for (let c = 0; c < 3; c++) P[m.idx[i] * 3 + c] += m.off[i * 3 + c] * k; };
addM('female', 1);
const mag = (name) => { const a = new Float32Array(n); const m = d.morphs[name]; let mx = 0; for (let i = 0; i < m.idx.length; i++) { const v = Math.hypot(m.off[i * 3], m.off[i * 3 + 1], m.off[i * 3 + 2]); a[m.idx[i]] = v; mx = Math.max(mx, v); } return a.map((x) => x / mx); };
const G0 = mag('glutes-up'), Hm = mag('hips-circ-up'), Th = mag('thigh-circ-up');
const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const G = G0.map((g) => ss(0.03, 0.4, g));
const N = new Float32Array(n * 3); const I = d.index;
for (let t = 0; t < I.length; t += 3) { const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3; const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]; const x = u[1] * v[2] - u[2] * v[1], y = u[2] * v[0] - u[0] * v[2], z = u[0] * v[1] - u[1] * v[0]; for (const k of [a, b, c]) { N[k] += x; N[k + 1] += y; N[k + 2] += z; } }
for (let i = 0; i < n; i++) { const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1; N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l; }
const mk = (name) => { const [s, c] = d.markers[name]; const o = [0, 0, 0]; for (let i = s; i < s + c; i++) for (let k = 0; k < 3; k++) o[k] += P[i * 3 + k] / c; return o; };
const HL = mk('upperleg01.L'), hipY = HL[1];
const bump = (c, w, x) => Math.exp(-(((x - c) / w) ** 2));
let gy0 = 1e9, gy1 = -1e9, gx1 = 0;
for (let i = 0; i < n; i++) if (G[i] > 0.5) { gy0 = Math.min(gy0, P[i * 3 + 1]); gy1 = Math.max(gy1, P[i * 3 + 1]); gx1 = Math.max(gx1, Math.abs(P[i * 3])); }
const A = 0.3;
const morphs = {};
const PEAK = { 'glute-shelf-up': 0.35, 'glute-fold-up': 0.15, 'pelvic-tilt-up': null, 'glutes-L-up': null, 'glutes-R-up': null };
const nb = Array.from({ length: n }, () => new Set());
for (let t = 0; t < I.length; t += 3) for (let k = 0; k < 3; k++) { const a = I[t + k], b = I[t + (k + 1) % 3]; nb[a].add(b); nb[b].add(a); }
const NB = nb.map((x) => [...x]);
function smoothField(F, iters) { let a = F, b = new Float32Array(F.length); for (let it = 0; it < iters; it++) { for (let i = 0; i < n; i++) { const L = NB[i]; if (!L.length) { b.set(a.subarray(i * 3, i * 3 + 3), i * 3); continue; } let x = 0, y = 0, z = 0; for (const j of L) { x += a[j * 3]; y += a[j * 3 + 1]; z += a[j * 3 + 2]; } b[i * 3] = 0.5 * a[i * 3] + 0.5 * x / L.length; b[i * 3 + 1] = 0.5 * a[i * 3 + 1] + 0.5 * y / L.length; b[i * 3 + 2] = 0.5 * a[i * 3 + 2] + 0.5 * z / L.length; } [a, b] = [b, a]; } return a; }
const SMOOTH = { 'glutes-L-up': 0, 'glutes-R-up': 0, 'pelvic-tilt-up': 4 };
function make(name, fn) {
	const F = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) { const r = fn(i, P[i * 3], P[i * 3 + 1], P[i * 3 + 2], N[i * 3], N[i * 3 + 1], N[i * 3 + 2]); if (r) { F[i * 3] = r[0]; F[i * 3 + 1] = r[1]; F[i * 3 + 2] = r[2]; } }
	const S = smoothField(F, name in SMOOTH ? SMOOTH[name] : 25);
	const idx = [], off = [];
	for (let i = 0; i < n; i++) { const r = [S[i * 3], S[i * 3 + 1], S[i * 3 + 2]]; if (Math.hypot(...r) < 2e-4) continue; idx.push(i); off.push(...r); }
	let mx = 0; for (let k = 0; k < off.length; k += 3) mx = Math.max(mx, Math.hypot(off[k], off[k + 1], off[k + 2]));
	const peak = name in PEAK ? PEAK[name] : A; const f = peak && mx ? peak / mx : 1;
	morphs[name] = { idx, off: off.map((x) => x * f) };
}
const back = (z, nz) => ss(0.0, 0.55, -nz);
const gy = (y) => (y - gy0) / (gy1 - gy0), gx = (x) => Math.abs(x) / gx1, side = (x) => (x > 0 ? 1 : -1);
make('glute-upper-up', (i, x, y, z, nx, ny, nz) => { const w = G[i] * ss(0.45, 0.85, gy(y)) * back(z, nz); return w && [nx * A * w, 0.15 * A * w, nz * A * w]; });
make('glute-lower-up', (i, x, y, z, nx, ny, nz) => { const w = G[i] * (1 - ss(0.15, 0.6, gy(y))) * back(z, nz); return w && [nx * A * w, -0.3 * A * w, nz * A * w]; });
make('glute-shelf-up', (i, x, y, z, nx, ny, nz) => { const g = gy(y); const w = G[i] * ss(0.3, 0.68, g) * (1 - ss(0.82, 1.0, g)) * back(z, nz); return w && [nx * A * w, (0.2 + 0.5 * Math.max(0, ny)) * A * w, nz * A * w]; });
make('glute-inner-up', (i, x, y, z, nx, ny, nz) => { const w = G[i] * (1 - gx(x)) ** 2 * back(z, nz); return w && [nx * A * w, 0, nz * A * w]; });
make('glute-outer-up', (i, x, y, z, nx, ny, nz) => { const w = G[i] * gx(x) ** 2; return w && [side(x) * 0.8 * A * w, 0, -0.5 * A * w]; });
make('glute-thigh-blend-up', (i, x, y, z, nx, ny, nz) => { const w = Math.max(G[i], Th[i]) * bump(gy0 + 0.02, 0.35, y) * back(z, nz); return w && [0, -0.2 * A * w, -0.8 * A * w]; });
make('glute-fold-up', (i, x, y, z, nx, ny, nz) => { const w = Math.max(G[i], Th[i] * 0.6) * bump(gy0 + 0.12, 0.12, y) * back(z, nz) * (1 - gx(x) * 0.5); return w && [0, 0.1 * A * w, 0.6 * A * w]; });
for (const [suf, s] of [['L', 1], ['R', -1]]) { const m = d.morphs['glutes-up']; const map = new Map(); for (let i = 0; i < m.idx.length; i++) map.set(m.idx[i], [m.off[i * 3], m.off[i * 3 + 1], m.off[i * 3 + 2]]); make(`glutes-${suf}-up`, (i, x) => (x * s > 0 && map.has(i) ? map.get(i) : null)); }
make('iliac-width-up', (i, x, y, z, nx, ny, nz) => { const w = Hm[i] * bump(hipY + 0.9, 0.45, y) * Math.max(0, nx * side(x)); return w && [side(x) * 0.8 * A * w, 0, 0]; });
make('pelvic-tilt-up', (i, x, y, z) => { const w = Math.max(G[i], Hm[i]) * bump(hipY + 0.3, 1.1, y); if (!w) return null; const a = (8 * Math.PI / 180) * w; const dy = y - hipY, dz = z - HL[2]; return [0, dy * Math.cos(a) - dz * Math.sin(a) - dy, dy * Math.sin(a) + dz * Math.cos(a) - dz].map((v, k) => (k === 2 ? -v : v)); });
make('thigh-upper-up', (i, x, y, z, nx, ny, nz) => { const w = Th[i] * bump(hipY - 0.9, 0.7, y); return w && [nx * A * w, ny * A * w * 0.3, nz * A * w]; });
make('thigh-outer-up', (i, x, y, z, nx, ny, nz) => { const w = Th[i] * bump(hipY - 0.8, 0.85, y) * ss(0.0, 0.9, nx * side(x)); return w && [nx * A * w, 0, nz * A * w * 0.5]; });
make('thigh-inner-up', (i, x, y, z, nx, ny, nz) => { const w = Th[i] * bump(hipY - 1.1, 0.8, y) * ss(0.2, 0.8, -nx * side(x)); return w && [nx * 0.7 * A * w, 0, nz * 0.7 * A * w]; });
make('hamstring-up', (i, x, y, z, nx, ny, nz) => { const w = Th[i] * bump(hipY - 1.8, 0.9, y) * ss(0.2, 0.8, -nz); return w && [0, 0, -0.8 * A * w]; });
// ---- end of the generator ----

// Sliders go both ways: the "-down" target is the same field reversed (not for the one-sided
// left/right glute targets, which are driven by one slider's sign).
for (const name of Object.keys(morphs)) if (!/^glutes-[LR]-up$/.test(name)) morphs[name.replace(/-up$/, '-down')] = { idx: morphs[name].idx, off: morphs[name].off.map((x) => -x) };

const parts = [bin];
let size = bin.length;
const pad = () => { const k = (4 - (size % 4)) % 4; if (k) { parts.push(Buffer.alloc(k)); size += k; } };
pad();
layout.libraryStart = size;
const Index = layout.indexType === 'uint32' ? Uint32Array : Uint16Array;
for (const [name, m] of Object.entries(morphs)) {
	pad();
	const entry = { name, count: m.idx.length, indices: size, library: true };
	const ib = Buffer.from(new Index(m.idx).buffer); parts.push(ib); size += ib.length;
	pad();
	entry.offsets = size;
	const ob = Buffer.from(new Float32Array(m.off).buffer); parts.push(ob); size += ob.length;
	layout.morphs.push(entry);
}
await writeFile(new URL('human.bin', dir), Buffer.concat(parts));
await writeFile(new URL('human.json', dir), JSON.stringify(layout));
console.log(`${Object.keys(morphs).length} library targets, ${(size / 1e6).toFixed(2)} MB total`, Object.fromEntries(Object.entries(morphs).filter(([k]) => k.endsWith('-up')).map(([k, m]) => [k, m.idx.length])));
void fileURLToPath;
