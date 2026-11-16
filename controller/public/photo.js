// Photo intake for the body editor (stage 3 of the body-creator upgrade): turn one reference photo
// into inspectable EVIDENCE: 2D body landmarks, a silhouette mask, silhouette widths at body heights
// and, per body region, whether the photo actually shows it. Nothing here changes the mesh; fitting
// (stage 4) reads this evidence later. Detection runs in the browser with MediaPipe Pose Landmarker
// (Apache-2.0, vendored in public/vendor/mediapipe); the photo never leaves the phone.
// Pure functions below run in Node too (tests).

export const VIEW_OPTIONS = [
	['front', 'Front'], ['rear', 'Back'], ['left', 'Her left side'], ['right', 'Her right side'],
	['front_left', 'Front three-quarter (her left)'], ['front_right', 'Front three-quarter (her right)'],
	['rear_left', 'Back three-quarter (her left)'], ['rear_right', 'Back three-quarter (her right)']
];
export const POSE_OPTIONS = [['standing', 'Standing'], ['seated', 'Seated'], ['kneeling', 'Kneeling'], ['crouching', 'Crouching'], ['lying', 'Lying'], ['other', 'Other']];

// MediaPipe's 33 pose landmarks: the ones fitting uses.
export const LM = { nose: 0, lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28, lHeel: 29, rHeel: 30 };
export const SEEN = 0.5; // visibility at or above this counts as seen

/** Which way the camera looks decides what a photo can measure at all. */
const FRONTAL = new Set(['front', 'rear']), SIDE = new Set(['left', 'right']);

/**
 * Per body region: 'observed' (the photo measures it), 'weak' (partly shown or low-confidence landmarks)
 * or 'unknown' (hidden by the view, crop or occlusion). Widths need a frontal or three-quarter view;
 * depths (butt projection, belly, chest) need a side or three-quarter view.
 */
export function observability(landmarks, view, hidden = []) {
	const vis = (i) => (hidden.includes(i) ? 0 : landmarks?.[i]?.visibility ?? 0);
	const pair = (a, b) => Math.min(vis(a), vis(b));
	const seen = (v) => (v >= SEEN ? 'observed' : v >= 0.2 ? 'weak' : 'unknown');
	const widthView = FRONTAL.has(view) ? 1 : SIDE.has(view) ? 0 : 0.6; // three-quarter: partly
	const depthView = SIDE.has(view) ? 1 : FRONTAL.has(view) ? 0 : 0.6;
	const rearView = view === 'rear' || view.startsWith('rear_') || SIDE.has(view);
	const grade = (landmarkScore, viewScore) => (viewScore === 0 ? 'unknown' : viewScore < 1 && seen(landmarkScore) === 'observed' ? 'weak' : seen(landmarkScore));
	const shoulders = pair(LM.lShoulder, LM.rShoulder), hips = pair(LM.lHip, LM.rHip), knees = pair(LM.lKnee, LM.rKnee), ankles = pair(LM.lAnkle, LM.rAnkle);
	const one = (a, b) => Math.max(vis(a), vis(b)); // a side view shows one of each pair
	const s = SIDE.has(view);
	return {
		height: grade(Math.min(vis(LM.nose), s ? one(LM.lAnkle, LM.rAnkle) : ankles), 1),
		shoulderWidth: grade(shoulders, widthView),
		waistWidth: grade(Math.min(shoulders, hips), widthView),
		hipWidth: grade(hips, widthView),
		thighWidth: grade(Math.min(hips, knees), widthView),
		legLength: grade(s ? Math.min(one(LM.lHip, LM.rHip), one(LM.lAnkle, LM.rAnkle)) : Math.min(hips, ankles), 1),
		buttProjection: rearView ? grade(s ? one(LM.lHip, LM.rHip) : hips, depthView) : 'unknown',
		bellyDepth: !view.startsWith('rear') ? grade(s ? one(LM.lHip, LM.rHip) : hips, depthView) : 'unknown',
		chestDepth: !view.startsWith('rear') ? grade(s ? one(LM.lShoulder, LM.rShoulder) : shoulders, depthView) : 'unknown'
	};
}

/**
 * Silhouette widths (in pixels and as a fraction of the person's pixel height) at the heights of the
 * shoulders, waist (midway shoulders-hips), hips and mid-thigh, read from a binary mask.
 * mask: { width, height, data } with data[i] > 0.5 meaning "person". Landmarks are 0..1 image coords.
 */
export function silhouetteWidths(mask, landmarks) {
	const { width: W, height: H, data } = mask;
	const yOf = (a, b) => ((landmarks[a].y + landmarks[b].y) / 2) * H;
	const span = (y) => {
		const row = Math.max(0, Math.min(H - 1, Math.round(y)));
		let l = -1, r = -1;
		for (let x = 0; x < W; x++) if (data[row * W + x] > 0.5) { if (l < 0) l = x; r = x; }
		return l < 0 ? 0 : r - l + 1;
	};
	let top = H, bottom = -1;
	for (let i = 0; i < W * H; i++) if (data[i] > 0.5) { const y = Math.floor(i / W); if (y < top) top = y; if (y > bottom) bottom = y; }
	const personH = bottom >= top ? bottom - top + 1 : 0;
	const sh = yOf(LM.lShoulder, LM.rShoulder), hp = yOf(LM.lHip, LM.rHip), kn = yOf(LM.lKnee, LM.rKnee);
	const at = { shoulders: sh, waist: sh + (hp - sh) * 0.62, hips: hp + (kn - hp) * 0.12, thigh: hp + (kn - hp) * 0.45 };
	const px = Object.fromEntries(Object.entries(at).map(([k, y]) => [k, span(y)]));
	return { personHeightPx: personH, px, ofHeight: Object.fromEntries(Object.entries(px).map(([k, v]) => [k, personH ? +(v / personH).toFixed(4) : 0])) };
}

/** Shrink a float mask to a small 0/255 byte mask for saving (privacy: no photo pixels, just the outline). */
export function smallMask(mask, maxSide = 96) {
	const s = Math.min(1, maxSide / Math.max(mask.width, mask.height));
	const w = Math.max(1, Math.round(mask.width * s)), h = Math.max(1, Math.round(mask.height * s));
	const out = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = mask.data[Math.min(mask.height - 1, Math.floor(y / s)) * mask.width + Math.min(mask.width - 1, Math.floor(x / s))] > 0.5 ? 255 : 0;
	return { width: w, height: h, data: out };
}

/** The saved evidence record (format photo-evidence/1). No photo pixels: landmarks, outline and measurements only. */
export function buildEvidence({ landmarks, mask, view, pose, imageWidth, imageHeight, crop, hidden = [], edited = [] }) {
	const m = mask ? smallMask(mask) : null;
	return {
		format: 'photo-evidence/1', created: new Date().toISOString(), view, pose,
		image: { width: imageWidth, height: imageHeight, crop },
		landmarks: (landmarks || []).map((p, i) => ({ i, x: +p.x.toFixed(4), y: +p.y.toFixed(4), z: +(p.z || 0).toFixed(4), visibility: hidden.includes(i) ? 0 : +(p.visibility ?? 0).toFixed(3), edited: edited.includes(i) })),
		hidden, observability: observability(landmarks, view, hidden),
		widths: mask && landmarks?.length ? silhouetteWidths(mask, landmarks) : null,
		mask: m && { width: m.width, height: m.height, rle: rle(m.data) },
		detector: 'mediapipe pose_landmarker_lite (float16), tasks-vision 1.2.3'
	};
}
/** Run-length encoding of a 0/255 mask: [value, count, value, count...]. */
export function rle(data) {
	const out = []; let v = data[0], n = 0;
	for (const x of data) { if (x === v) n++; else { out.push(v, n); v = x; n = 1; } }
	if (data.length) out.push(v, n);
	return out;
}

let landmarker = null;
/** Load MediaPipe once (about 21 MB from the app's own folder, cached by the browser), then detect. */
export async function detect(image) {
	if (!landmarker) {
		const { FilesetResolver, PoseLandmarker } = await import('./vendor/mediapipe/vision_bundle.mjs');
		const fileset = await FilesetResolver.forVisionTasks(new URL('./vendor/mediapipe/wasm', import.meta.url).href);
		const opts = (delegate) => ({ baseOptions: { modelAssetPath: new URL('./vendor/mediapipe/pose_landmarker_lite.task', import.meta.url).href, delegate }, runningMode: 'IMAGE', numPoses: 1, outputSegmentationMasks: true });
		try { landmarker = await PoseLandmarker.createFromOptions(fileset, opts('GPU')); } catch { landmarker = await PoseLandmarker.createFromOptions(fileset, opts('CPU')); }
	}
	const r = landmarker.detect(image);
	const landmarks = r.landmarks?.[0] || null;
	let mask = null;
	if (r.segmentationMasks?.[0]) { const mk = r.segmentationMasks[0]; mask = { width: mk.width, height: mk.height, data: Float32Array.from(mk.getAsFloat32Array()) }; mk.close?.(); }
	return { landmarks, mask };
}
