// Reading a video on the phone: frames are sampled (10 per second by default, at most 15),
// shrunk, and given to MediaPipe Pose Landmarker Lite (Apache-2.0, vendored, about 6 MB, runs in
// the browser), which finds up to `people` bodies per frame: 33 points each, on the picture and
// in 3D. The video never leaves the phone; only these numbers are kept.
import { MAX_FPS, DEFAULT_FPS } from './motion.js';

let landmarker = null, landmarkerPeople = 0;
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
		const k = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
		const canvas = document.createElement('canvas');
		canvas.width = Math.round(video.videoWidth * k); canvas.height = Math.round(video.videoHeight * k);
		const g = canvas.getContext('2d', { willReadFrequently: true });
		const lm = await getLandmarker(people);
		const total = Math.max(1, Math.floor(duration * fps));
		const frames = [];
		for (let i = 0; i < total; i++) {
			if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
			const t = i / fps;
			video.currentTime = Math.min(t, duration - 0.001);
			await once(video, 'seeked');
			g.drawImage(video, 0, 0, canvas.width, canvas.height);
			const r = lm.detectForVideo(canvas, Math.round(t * 1000) + 1);
			const poses = (r.landmarks || []).map((image, n) => ({
				image: image.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility ?? 1 })),
				world: (r.worldLandmarks?.[n] || image).map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 1 }))
			}));
			frames.push({ t, poses });
			onProgress?.(i + 1, total, poses.length);
		}
		return { frames, width: video.videoWidth, height: video.videoHeight, duration, fps };
	} finally {
		URL.revokeObjectURL(url);
		video.removeAttribute('src'); video.load();
	}
}
