// Stage 4 of the body-creator upgrade: fit the body sliders to a reference photo's EVIDENCE
// (public/photo.js, photo-evidence/1), constrained and explainable.
//
// Compared: the body's silhouette PROFILE, i.e. for each of 48 rows between the top of the head and
// the feet, the width of the run of body pixels around the body's centre line (so arms held away
// from the body don't count). Both silhouettes are normalised to the person's own height, so the
// camera distance and the photo's scale don't matter (weak perspective). Only sliders that the photo's
// view can measure are moved (photo.js observability): widths from front/back views, depths
// (butt projection, belly, chest) from side views, both (weakly) from three-quarter views.
// Height in cm is never fitted: one photo can't tell absolute size.
//
// Search: bounded coordinate descent, global sliders first, then local ones, each in its own range,
// with a small penalty for moving away from the start (no extreme values unless the photo needs them).
import { renderBody, VIEWS } from './body-depth.js';

export const PROFILE_ROWS = 48;
const ROW_FROM = 0.1, ROW_TO = 0.78; // forehead to just below the knees: feet and hair are unreliable

/** Sliders the fitter may move, in order: global first, then local; with the measurement they need. */
/** Pose settings matched first so the outline compares like with like; never reported as body changes. */
export const POSE_PARAMS = [{ key: 'armPose', needs: 'any', lo: 0, hi: 1, step: 0.25, pose: true }, { key: 'stance', needs: 'any', lo: 0, hi: 1, step: 0.25, pose: true }];

export const FIT_PARAMS = [
	{ key: 'weight', needs: 'any', lo: -1, hi: 1, step: 0.25 },
	{ key: 'legLength', needs: 'legLength', lo: -1, hi: 1, step: 0.25 },
	{ key: 'waist', needs: 'waistWidth', lo: -1.2, hi: 1.3, step: 0.25 },
	{ key: 'hips', needs: 'hipWidth', lo: -1.2, hi: 1.5, step: 0.25 },
	{ key: 'thighs', needs: 'thighWidth', lo: -1.2, hi: 1.5, step: 0.25 },
	// shoulders after the lower body: the shoulder rows also carry the arms' roots, so they explain least
	{ key: 'shoulders', needs: 'shoulderWidth', lo: -1, hi: 1, step: 0.25 },
	{ key: 'chest', needs: 'shoulderWidth', lo: -1, hi: 1, step: 0.25 },
	{ key: 'glutes', needs: 'buttProjection', lo: -1, hi: 1.5, step: 0.25 },
	{ key: 'buttOut', needs: 'buttProjection', lo: -1, hi: 1.3, step: 0.25 },
	{ key: 'belly', needs: 'bellyDepth', lo: -1, hi: 1, step: 0.25 },
	{ key: 'bust', needs: 'chestDepth', lo: -1, hi: 1.6, step: 0.25 }
];

/** Decode the evidence's run-length mask into rows of 0/1. */
export function decodeMask(m) {
	const data = new Uint8Array(m.width * m.height); let o = 0;
	for (let k = 0; k < m.rle.length; k += 2) { data.fill(m.rle[k] ? 1 : 0, o, o + m.rle[k + 1]); o += m.rle[k + 1]; }
	return { width: m.width, height: m.height, data };
}

/** Width profile, as fractions of the person's height, from a 0/1 (or 0/255) mask. */
export function profile(mask) {
	const { width: W, height: H, data } = mask;
	let top = H, bottom = -1, sx = 0, n = 0;
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (data[y * W + x]) { if (y < top) top = y; if (y > bottom) bottom = y; sx += x; n++; }
	if (bottom < top) return null;
	const ph = bottom - top + 1, out = new Float64Array(PROFILE_ROWS);
	let cx = sx / n;
	for (let r = 0; r < PROFILE_ROWS; r++) {
		const y = Math.round(top + (ROW_FROM + ((ROW_TO - ROW_FROM) * r) / (PROFILE_ROWS - 1)) * ph);
		const row = (x) => x >= 0 && x < W && data[y * W + x];
		let c = Math.round(cx);
		if (!row(c)) { let best = -1; for (let d = 1; d < W; d++) { if (row(c - d)) { best = c - d; break; } if (row(c + d)) { best = c + d; break; } } if (best < 0) { out[r] = 0; continue; } c = best; }
		let l = c, rr = c;
		while (row(l - 1)) l--; while (row(rr + 1)) rr++;
		out[r] = (rr - l + 1) / ph;
		cx = 0.7 * cx + 0.3 * ((l + rr) / 2); // follow the body down (it may lean)
	}
	return out;
}

/** Crop a 0/255 mask to its body and box-shrink it to `rows` rows (same aspect), threshold 0.5. */
export function shrinkTo(mask, W, H, rows) {
	let x0 = W, x1 = -1, y0 = H, y1 = -1;
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
	if (y1 < y0) return { width: 1, height: 1, data: new Uint8Array(1) };
	const bh = y1 - y0 + 1, bw = x1 - x0 + 1, k = bh / rows, w = Math.max(1, Math.round(bw / k)) + 2;
	const out = new Uint8Array(w * rows);
	for (let r = 0; r < rows; r++) for (let c = 0; c < w; c++) {
		const ya = y0 + r * k, yb = ya + k, xa = x0 + (c - 1) * k, xb = xa + k;
		let on = 0, all = 0;
		for (let y = Math.floor(ya); y < Math.ceil(yb); y++) for (let x = Math.floor(xa); x < Math.ceil(xb); x++) { all++; if (x >= 0 && x < W && y >= 0 && y < H && mask[y * W + x]) on++; }
		out[r * w + c] = all && on / all >= 0.5 ? 1 : 0;
	}
	return { width: w, height: rows, data: out };
}

const err = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s / a.length); };

/** Which sliders this evidence lets the fitter move, and how much it trusts them (1 measured, 0.5 rough). */
export function fittable(obs) {
	const trust = { observed: 1, weak: 0.5, unknown: 0 };
	return FIT_PARAMS.map((p) => ({ ...p, trust: p.needs === 'any' ? Math.max(...Object.values(obs).map((v) => trust[v] || 0)) : trust[obs[p.needs]] || 0 })).filter((p) => p.trust > 0);
}

/**
 * Fit. evidence: photo-evidence/1 (must carry consent). start: the current body code.
 * Returns { values, fitted:[{key, from, to, trust}], untouched:[keys], error:{before, after}, renders }.
 */
export async function fitBody(evidence, start = {}, { width = 0, height = 0, steps = [0.5, 0.25, 0.25, 0.125] } = {}) {
	if (evidence?.format !== 'photo-evidence/1') throw new Error('Not a photo-evidence/1 record.');
	if (evidence.consent !== 'own-or-consenting-adult') throw new Error('This photo has no consent confirmation.');
	if (!evidence.mask?.rle) throw new Error('The evidence has no outline.');
	const tmask = decodeMask(evidence.mask);
	const target = profile(tmask);
	if (!target) throw new Error('The outline is empty.');
	// Both outlines must go through the same pixel rounding: draw the figure sharp (several times the
	// photo outline's size), crop it to the body, and shrink it to exactly the person's pixel height in
	// the photo outline before reading its profile. A 1-pixel scale difference otherwise moves the fit.
	let top = tmask.height, bottom = -1;
	for (let i = 0; i < tmask.data.length; i++) if (tmask.data[i]) { const y = Math.floor(i / tmask.width); if (y < top) top = y; if (y > bottom) bottom = y; }
	const personPx = bottom - top + 1;
	if (!width || !height) { height = Math.max(192, personPx * 4); width = Math.round((height * 2) / 3); }
	const angle = VIEWS[evidence.view] ?? 0;
	const params = fittable(evidence.observability || {});
	const search = [...POSE_PARAMS, ...params];
	let renders = 0;
	// rows: which profile rows count. UPPER = head to waist (weight shows there; hips and thighs don't).
	const UPPER = Math.round(PROFILE_ROWS * ((0.42 - ROW_FROM) / (ROW_TO - ROW_FROM)));
	const cost = async (v, rows = PROFILE_ROWS) => {
		renders++;
		const r = await renderBody({ ...v, posing: false }, { angleDeg: angle, width, height, raw: true });
		const prof = profile(shrinkTo(r.mask, r.width, r.height, personPx));
		if (!prof) return Infinity;
		// the residual plus a gentle pull back towards where the user started (keeps unneeded sliders put)
		let reg = 0; for (const p of params) reg += ((v[p.key] || 0) - (start[p.key] || 0)) ** 2;
		return err(prof.subarray(0, rows), target.subarray(0, rows)) + 0.002 * reg;
	};
	/** Coordinate descent over `list` at the given steps, scoring `rows` profile rows. */
	const descend = async (list, stepsList, rows = PROFILE_ROWS) => {
		let b = await cost(v, rows);
		for (const step of stepsList) for (const p of list) for (const dir of [1, -1]) {
			let moved = true;
			while (moved) {
				moved = false;
				const cur = v[p.key] || 0, next = Math.min(p.hi, Math.max(p.lo, +(cur + dir * step).toFixed(3)));
				if (next === cur || Math.abs(next - (start[p.key] || 0)) > 1.6) break;
				const c = await cost({ ...v, [p.key]: next }, rows);
				if (c < b - 1e-5) { b = c; v[p.key] = next; moved = true; }
			}
		}
		return b;
	};
	const v = { ...start };
	const before = await cost(v);
	let best = before;
	// Match the arm and leg spread first (arms held out widen the shoulder rows and fool the fit).
	for (const step of [0.25, 0.125]) for (const p of POSE_PARAMS) for (const dir of [1, -1]) {
		let moved = true;
		while (moved) { moved = false; const cur = v[p.key] || 0, next = Math.min(p.hi, Math.max(p.lo, +(cur + dir * step).toFixed(3))); if (next === cur) break; const c = await cost({ ...v, [p.key]: next }); if (c < best - 1e-5) { best = c; v[p.key] = next; moved = true; } }
	}
	// 1. Overall weight (and shoulders/chest) from the head-to-waist rows only: weight thickens arms,
	//    neck and torso, while hips and thighs don't show up there, so it can't soak up hip width.
	const upper = params.filter((p) => ['weight', 'shoulders', 'chest'].includes(p.key));
	if (upper.length) await descend(upper, [0.25, 0.125], UPPER);
	// 2. Everything else on the whole profile with weight held, local regions take what's left.
	await descend(search.filter((p) => !upper.includes(p)), steps);
	// 3. A final small-step pass over all of them together.
	best = await descend(search, [0.125]);
	const fitted = params.map((p) => ({ key: p.key, from: start[p.key] || 0, to: v[p.key] || 0, trust: p.trust === 1 ? 'measured' : 'rough' }));
	const untouched = FIT_PARAMS.filter((p) => !params.some((q) => q.key === p.key)).map((p) => p.key);
	const pose = Object.fromEntries(POSE_PARAMS.map((p) => [p.key, v[p.key] || 0]));
	// The body code keeps the user's own arm/leg spread; the matched pose is only reported.
	for (const p of POSE_PARAMS) { if (p.key in start) v[p.key] = start[p.key]; else delete v[p.key]; }
	return { values: v, pose, fitted, untouched, error: { before: +before.toFixed(4), after: +best.toFixed(4) }, renders, view: evidence.view };
}
