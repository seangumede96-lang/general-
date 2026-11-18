// Reading a video on the phone: frames are sampled (10 per second by default, at most 15),
// shrunk, and given to MediaPipe Pose Landmarker Lite (Apache-2.0, vendored, about 6 MB, runs in
// the browser), which finds up to `people` bodies per frame: 33 points each, on the picture and
// in 3D. The video never leaves the phone; only these numbers are kept.
import { MAX_FPS, DEFAULT_FPS } from './motion.js';

let landmarker = null, landmarkerPeople = 0;
const singles = [];
/**
 * One more landmarker per person being followed, used on the close-up around that person. In
 * VIDEO mode it follows the person from frame to frame instead of searching the crop each time.
 */
async function getSingle(slot) {
	if (singles[slot]) return singles[slot];
	const { FilesetResolver, PoseLandmarker } = await import('./vendor/mediapipe/vision_bundle.mjs');
	const fileset = await FilesetResolver.forVisionTasks(new URL('./vendor/mediapipe/wasm', import.meta.url).href);
	const opts = (delegate) => ({ baseOptions: { modelAssetPath: new URL('./vendor/mediapipe/pose_landmarker_lite.task', import.meta.url).href, delegate }, runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4, minTrackingConfidence: 0.4 });
	try { singles[slot] = await PoseLandmarker.createFromOptions(fileset, opts('GPU')); } catch { singles[slot] = await PoseLandmarker.createFromOptions(fileset, opts('CPU')); }
	return singles[slot];
}

/**
 * Where to look for a person next (pixels): as tall as their whole body, but only as wide as their
 * own trunk and legs (arms reach into other people when they are close), plus a margin.
 */
const CORE = [0, 11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
function boxAround(image, W, H) {
	const all = image.filter((p) => (p.visibility ?? 1) > 0.3);
	const core = CORE.map((j) => image[j]).filter((p) => (p.visibility ?? 1) > 0.3);
	if (all.length < 6 || core.length < 4) return null;
	const ys = all.map((p) => p.y * H), xs = core.map((p) => p.x * W);
	const y0 = Math.min(...ys), y1 = Math.max(...ys), x0 = Math.min(...xs), x1 = Math.max(...xs);
	const h = (y1 - y0) * 1.25 + 20, w = Math.max(x1 - x0, h * 0.18) + h * 0.22;
	const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
	return { x: cx - w / 2, y: cy - h / 2, w, h, hip: hipCentre(image) };
}
const hipCentre = (image) => [(image[23].x + image[24].x) / 2, (image[23].y + image[24].y) / 2];
async function getLandmarker(people) {
	if (landmarker && landmarkerPeople === people) return landmarker;
	landmarker?.close?.();
	const { FilesetResolver, PoseLandmarker } = await import('./vendor/mediapipe/vision_bundle.mjs');
	const fileset = await FilesetResolver.forVisionTasks(new URL('./vendor/mediapipe/wasm', import.meta.url).href);
	const opts = (delegate) => ({
		baseOptions: { modelAssetPath: new URL('./vendor/mediapipe/pose_landmarker_lite.task', import.meta.url).href, delegate },
		runningMode: 'VIDEO', numPoses: people, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5
	});
	try { landmarker = await PoseLandmarker.createFromOptions(fileset, opts('GPU')); } catch { landmarker = await PoseLandmarker.createFromOptions(fileset, opts('CPU')); }
	landmarkerPeople = people;
	return landmarker;
}

/** A quick fingerprint of a video file (size, name, first and last 4 MB), so a clip is never analysed twice. */
export async function fingerprint(file) {
	const part = 4 * 1024 * 1024;
	const head = await file.slice(0, part).arrayBuffer();
	const tail = await file.slice(Math.max(0, file.size - part)).arrayBuffer();
	const meta = new TextEncoder().encode(`${file.size}|${file.name}|${file.lastModified}`);
	const all = new Uint8Array(meta.length + head.byteLength + tail.byteLength);
	all.set(meta); all.set(new Uint8Array(head), meta.length); all.set(new Uint8Array(tail), meta.length + head.byteLength);
	const hash = await crypto.subtle.digest('SHA-256', all);
	return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function once(el, ok, bad = 'error', ms = 15000) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => { done(); reject(new Error('timeout')); }, ms);
		const a = () => { done(); resolve(); }, b = () => { done(); reject(new Error(el.error?.message || 'error')); };
		const done = () => { clearTimeout(t); el.removeEventListener(ok, a); el.removeEventListener(bad, b); };
		el.addEventListener(ok, a); el.addEventListener(bad, b);
	});
}

/**
 * Find the people in every sampled frame. Returns { frames: [{ t, poses: [{ image, world }] }],
 * width, height, duration, fps }. onProgress(done, total) as frames are read; `signal` cancels.
 */
export async function extractFromVideo(file, { fps = DEFAULT_FPS, people = 2, maxSide = 640, onProgress, signal } = {}) {
	fps = Math.max(1, Math.min(MAX_FPS, fps));
	const video = document.createElement('video');
	video.muted = true; video.playsInline = true; video.preload = 'auto';
	const url = URL.createObjectURL(file);
	video.src = url;
	try {
		try { await once(video, 'loadeddata'); }
		catch { throw new Error("This phone can't open this video's format. MP4 (H.264) works everywhere; try exporting the clip as MP4."); }
		const duration = video.duration;
		if (!Number.isFinite(duration) || duration <= 0) throw new Error('This video has no length the phone can read.');
		const W = video.videoWidth, H = video.videoHeight;
		// The whole frame (shrunk) to find people; close-ups (from a sharper copy) to follow each one.
		const k = Math.min(1, maxSide / Math.max(W, H));
		const canvas = document.createElement('canvas');
		canvas.width = Math.round(W * k); canvas.height = Math.round(H * k);
		const g = canvas.getContext('2d', { willReadFrequently: true });
		const ks = Math.min(1, 1280 / Math.max(W, H));
		const sharp = document.createElement('canvas');
		sharp.width = Math.round(W * ks); sharp.height = Math.round(H * ks);
		const gs = sharp.getContext('2d');
		const crop = document.createElement('canvas');
		crop.width = crop.height = 384; // the strip is centred in a square, the rest left black
		const gc = crop.getContext('2d');
		const lm = await getLandmarker(people);
		const one = people > 1;
		// Each clip's timestamps start again at zero, so the per-person landmarkers start fresh too.
		while (singles.length) singles.pop()?.close?.();
		const total = Math.max(1, Math.floor(duration * fps));
		const frames = [];
		// People being followed: where to look next (a box in full-size pixels) and frames since last seen.
		let follow = [];
		const tidy = (r) => (r.landmarks || []).map((image, n) => ({
			image: image.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility ?? 1 })),
			world: (r.worldLandmarks?.[n] || image).map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 1 }))
		}));
		for (let i = 0; i < total; i++) {
			if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
			const t = i / fps;
			video.currentTime = Math.min(t, duration - 0.001);
			await once(video, 'seeked');
			const ms = Math.round(t * 1000) + 1;
			// The whole frame is searched for new people every frame until everyone is being followed,
			// then twice a second (a newcomer is picked up within half a second).
			const crowd = one && follow.length >= 2;
			const scan = !crowd || follow.length < people || i % Math.max(1, Math.round(fps / 2)) === 0;
			let whole = [];
			if (scan) { g.drawImage(video, 0, 0, canvas.width, canvas.height); whole = tidy(lm.detectForVideo(canvas, ms)); }
			let poses = whole;
			if (!crowd) {
				// One person (or none): the whole frame is enough. Keep a box on each, so close-ups can take
				// over as soon as a second person is in view.
				follow = whole.map((p, k) => { const box = boxAround(p.image, W, H); return box && { box, lost: 0, slot: k }; }).filter(Boolean);
			} else {
				// Each person already being followed: look again in a close-up around where they were.
				// MediaPipe is far more reliable with one person centred than with two close together.
				gs.drawImage(video, 0, 0, sharp.width, sharp.height);
				const found = [];
				for (const f of follow) {
					const b = f.box, side = Math.max(b.w, b.h), z = crop.width / side;
					const ox = (side - b.w) / 2, oy = (side - b.h) / 2; // where the strip sits in the square
					gc.fillStyle = '#000'; gc.fillRect(0, 0, crop.width, crop.height);
					gc.drawImage(sharp, b.x * ks, b.y * ks, b.w * ks, b.h * ks, ox * z, oy * z, b.w * z, b.h * z);
					const [p] = tidy((await getSingle(f.slot)).detectForVideo(crop, ms));
					if (!p) { f.lost++; continue; }
					// Back to whole-frame coordinates.
					for (const q of p.image) { q.x = (b.x - ox + q.x * side) / W; q.y = (b.y - oy + q.y * side) / H; }
					const c = hipCentre(p.image);
					// Not where this person was: the close-up caught someone else.
					if (Math.abs(c[0] - b.hip[0]) * W > b.w * 0.45 || Math.abs(c[1] - b.hip[1]) * H > b.h * 0.25) { f.lost++; continue; }
					// Two close-ups that found the same person: keep the first.
					if (found.some((o) => Math.hypot(o.c[0] - c[0], o.c[1] - c[1]) < 0.03)) { f.lost++; continue; }
					found.push({ p, c, f });
					f.lost = 0;
					f.box = boxAround(p.image, W, H) || f.box;
				}
				// Anyone in the whole frame not already followed is someone new.
				for (const p of whole) {
					if (found.length >= people) break;
					const c = hipCentre(p.image);
					if (follow.some((f) => { const b = f.box; return c[0] * W > b.x && c[0] * W < b.x + b.w && c[1] * H > b.y && c[1] * H < b.y + b.h; })) continue;
					const box = boxAround(p.image, W, H);
					if (!box) continue;
					// A free landmarker slot (one per person followed).
					const used = new Set(follow.map((x) => x.slot));
					let slot = 0; while (used.has(slot)) slot++;
					const f = { box, lost: 0, slot };
					follow.push(f);
					found.push({ p, c, f });
				}
				// Someone not seen for a second is no longer followed (the whole frame still finds them again).
				follow = follow.filter((f) => f.lost <= fps);
				poses = found.map((x) => x.p);
			}
			frames.push({ t, poses });
			onProgress?.(i + 1, total, poses.length);
		}
		return { frames, width: video.videoWidth, height: video.videoHeight, duration, fps };
	} finally {
		URL.revokeObjectURL(url);
		video.removeAttribute('src'); video.load();
	}
}

let still = null;
/**
 * The pose of the person in one picture (a File or Blob): MediaPipe's 33 points on the picture and
 * in 3D, or null if nobody is found. The picture never leaves the phone.
 */
export async function poseFromPicture(file, { maxSide = 1280 } = {}) {
	if (!still) {
		const { FilesetResolver, PoseLandmarker } = await import('./vendor/mediapipe/vision_bundle.mjs');
		const fileset = await FilesetResolver.forVisionTasks(new URL('./vendor/mediapipe/wasm', import.meta.url).href);
		const opts = (delegate) => ({ baseOptions: { modelAssetPath: new URL('./vendor/mediapipe/pose_landmarker_lite.task', import.meta.url).href, delegate }, runningMode: 'IMAGE', numPoses: 1, minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4 });
		try { still = await PoseLandmarker.createFromOptions(fileset, opts('GPU')); } catch { still = await PoseLandmarker.createFromOptions(fileset, opts('CPU')); }
	}
	let bmp;
	try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { bmp = await createImageBitmap(file); }
	const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
	const c = document.createElement('canvas');
	c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
	c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
	const r = still.detect(c);
	if (!r.landmarks?.[0]) return null;
	return {
		image: r.landmarks[0].map((p) => ({ x: p.x, y: p.y, visibility: p.visibility ?? 1 })),
		world: (r.worldLandmarks?.[0] || r.landmarks[0]).map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 1 })),
		width: bmp.width, height: bmp.height
	};
}
