// The Animation page: From video (choose a clip; everything else is automatic) and Library.
//   choose video -> fingerprint (a clip already done is opened, never analysed again)
//   -> find people on the phone (MediaPipe Lite) -> keep them apart -> smooth -> fit to the figure
//   -> root motion -> save one motion per person -> play it on the figure, next to the clip
// Nothing leaves the phone except the motion numbers, which go to the app's own library.

const AREA_NAMES = { torso: 'Torso', head: 'Head', arms: 'Arms', legs: 'Legs', feet: 'Feet' };
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 31], [24, 26], [26, 28], [28, 32], [0, 11], [0, 12]];
const COLOURS = ['#8b7cf6', '#4fd1c5', '#f6ad55'];

export function createAnimationPage({ $, el, api, toast = (t) => alert(t) }) {
	const st = { tab: 'video', running: null, result: null, body: null, viewer: null, timer: 0, frame: 0, playing: false, videoUrl: null, landmarks: null, settingsOpen: false };

	// ---------- the figure ----------
	async function figure() {
		if (!st.body) st.body = (async () => {
			const body = await import('./body.js');
			await body.loadHuman();
			const values = { ...body.defaults('female'), posing: true };
			const poser = body.createPoser(values);
			const upc = poser.toUnits([1, 0, 0], 0)[0] - poser.toUnits([0, 0, 0], 0)[0];
			const floorCm = (pose) => (poser.floor(pose) - poser.floor({})) / upc;
			return { body, values, poser, upc, floorCm };
		})();
		return st.body;
	}

	// ---------- tabs ----------
	function setTab(tab) {
		st.tab = tab;
		for (const b of $('anim-tabs').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
		$('anim-video-pane').hidden = tab !== 'video';
		$('anim-library-pane').hidden = tab !== 'library';
		if (tab === 'library') renderLibrary();
	}
	$('anim-tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });

	// ---------- from video: fully automatic ----------
	$('anim-file').addEventListener('change', (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) run(f); });
	const fpsSel = $('anim-fps'), peopleSel = $('anim-people');

	function stage(steps, current, detail = '', fraction = 0) {
		$('anim-run').replaceChildren(el('div', { className: 'card anim-progress' },
			el('div', { className: 'anim-steps' }, ...steps.map((s, i) => el('div', { className: `anim-step${i < current ? ' done' : i === current ? ' now' : ''}` }, el('span', { className: 'anim-dot', textContent: i < current ? '✓' : String(i + 1) }), s))),
			el('div', { className: 'bar' }, el('div', { style: `width:${Math.round(fraction * 100)}%` })),
			el('div', { className: 'muted small', textContent: detail }),
			(() => { const b = el('button', { type: 'button', className: 'btn-ghost', textContent: 'Stop' }); b.addEventListener('click', () => st.running?.abort()); return b; })()));
	}
	const STEPS = ['Reading the video', 'Finding the people', 'Fitting the motion to the skeleton', 'Saving to your library'];

	async function run(file) {
		if (st.running) return;
		stop();
		const ctl = new AbortController();
		st.running = ctl;
		$('anim-result').replaceChildren();
		$('anim-pick').classList.add('busy');
		const t0 = performance.now();
		try {
			stage(STEPS, 0, file.name);
			const { fingerprint, extractFromVideo } = await import('./motion-video.js');
			const M = await import('./motion.js');
			const fps = Number(fpsSel.value) || M.DEFAULT_FPS, people = Number(peopleSel.value) || 2;
			const key = `${await fingerprint(file)}-${fps}`;
			// Done before? Open it instead of analysing again.
			const cached = (await api('GET', `/api/motions?source=${key}`)).motions;
			if (cached.length) {
				st.running = null;
				$('anim-run').replaceChildren(el('div', { className: 'card muted small', textContent: `This clip was analysed before (${cached.length} ${cached.length === 1 ? 'person' : 'people'}); opened from your library instead of analysing it again.` }));
				return open(cached.map((m) => m.id), { videoFile: file });
			}
			const fig = figure();
			const raw = await extractFromVideo(file, { fps, people, signal: ctl.signal, onProgress: (n, total, found) => stage(STEPS, 1, `Frame ${n} of ${total}${found ? ` · ${found} ${found === 1 ? 'person' : 'people'} in view` : ' · nobody in view'}`, n / total) });
			const tracks = M.trackPeople(raw.frames, { minShare: 0.25 });
			if (!tracks.length) throw new Error('No person was found in enough of the clip to follow. A clip where the whole body is clearly in view works best.');
			const { poser, upc, floorCm } = await fig;
			const ids = [], landmarks = {};
			const cleans = tracks.map((tr) => M.cleanTrack(tr, { fps }));
			// With more than one person, everyone shares one origin, so they keep their places relative to each other.
			const sceneDepth = tracks.length > 1 ? M.sceneDepthOf(cleans, raw) : null;
			for (const [n, tr] of tracks.entries()) {
				const clean = cleans[n];
				const motion = await M.retargetAsync(poser.rest, upc, clean, { width: raw.width, height: raw.height, onProgress: (d, total) => stage(STEPS, 2, `${tracks.length > 1 ? `Person ${n + 1} of ${tracks.length} · ` : ''}frame ${d} of ${total}`, (n + d / total) / tracks.length) });
				if (ctl.signal.aborted) throw new DOMException('Stopped', 'AbortError');
				M.addRootMotion(motion, clean, { width: raw.width, height: raw.height, footHeight: floorCm, sceneDepth });
				stage(STEPS, 3, `Person ${n + 1}`, 1);
				const name = `${file.name.replace(/\.[^.]+$/, '')}${tracks.length > 1 ? ` · person ${n + 1}` : ''}`;
				const record = M.buildMotion({ name, fps, track: tr, motion, source: { kind: 'video', file: file.name, key, people: tracks.length, width: raw.width, height: raw.height, duration: Math.round(raw.duration * 100) / 100, detector: 'MediaPipe Pose Landmarker Lite (tasks-vision 1.2.3)', sampledFps: fps } });
				const { id } = await api('POST', '/api/motions', record);
				ids.push(id);
				landmarks[id] = clean.map((f) => f.image);
			}
			const secs = Math.round((performance.now() - t0) / 1000);
			$('anim-run').replaceChildren(el('div', { className: 'card muted small', textContent: `Done in ${secs} s: ${tracks.length} ${tracks.length === 1 ? 'person' : 'people'}, ${raw.frames.length} frames. Saved to your library.` }));
			st.running = null;
			await open(ids, { videoFile: file, landmarks });
		} catch (err) {
			st.running = null;
			$('anim-run').replaceChildren(el('div', { className: 'card sys-alert', textContent: err.name === 'AbortError' ? 'Stopped. Nothing was saved.' : err.message }));
		} finally { $('anim-pick').classList.remove('busy'); st.running = null; }
	}

	// ---------- result: video + skeleton, the figure, timeline, confidence, description ----------
	async function open(ids, { videoFile = null, landmarks = null } = {}) {
		stop();
		const motions = await Promise.all(ids.map((id) => api('GET', `/api/motions/${id}`)));
		st.result = { motions, current: 0 };
		st.landmarks = landmarks;
		if (st.videoUrl) URL.revokeObjectURL(st.videoUrl);
		st.videoUrl = videoFile ? URL.createObjectURL(videoFile) : null;
		renderResult();
		if (st.tab !== 'video') setTab('video');
		$('anim-result').scrollIntoView({ block: 'start', behavior: 'smooth' });
	}

	function renderResult() {
		const { motions, current } = st.result;
		const m = motions[current];
		const box = $('anim-result');
		const people = motions.length > 1 ? el('div', { className: 'seg anim-people' }, ...motions.map((x, i) => {
			const b = el('button', { type: 'button', textContent: `Person ${i + 1}` });
			b.setAttribute('aria-pressed', String(i === current));
			b.style.setProperty('--dot', COLOURS[i % COLOURS.length]);
			b.addEventListener('click', () => { st.result.current = i; renderResult(); });
			return b;
		})) : null;
		const stageEl = el('div', { className: `anim-stage${st.videoUrl ? ' two' : ''}` });
		if (st.videoUrl) {
			const v = el('video', { src: st.videoUrl, muted: true, playsInline: true, preload: 'auto', className: 'anim-video' });
			v.muted = true;
			// A landscape clip gets the full width, with the figure below it.
			v.addEventListener('loadedmetadata', () => { const wide = v.videoWidth > v.videoHeight * 1.1; stageEl.classList.toggle('wide', wide); if (wide) v.parentElement.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`; });
			const c = el('canvas', { className: 'anim-overlay' });
			stageEl.append(el('div', { className: 'anim-pane' }, v, c, el('span', { className: 'anim-label', textContent: 'Your clip' })));
		}
		// One 3D view for the page's whole life (a phone has few WebGL contexts), moved into each result.
		st.holder ||= el('div', { className: 'anim-figure-holder' });
		const view = el('div', { className: 'anim-pane anim-figure' }, st.holder, el('span', { className: 'anim-label', textContent: 'On the figure' }));
		stageEl.append(view);
		const play = el('button', { type: 'button', className: 'anim-play', ariaLabel: 'Play' });
		const scrub = el('input', { type: 'range', min: 0, max: m.frames.length - 1, step: 1, value: 0, className: 'anim-scrub', ariaLabel: 'Timeline' });
		const time = el('span', { className: 'anim-time muted small' });
		const q = m.quality || {};
		const shared = motions.length > 1 ? el('p', { className: 'muted small', textContent: `Everyone in this clip shares one starting point, so exported files keep their places relative to each other (person ${current + 1} starts ${Math.round(Math.abs(m.frames[0].root[0]))} cm ${m.frames[0].root[0] >= 0 ? 'right' : 'left'} of the camera's centre).` }) : null;
		const conf = el('div', { className: 'anim-conf' }, ...Object.entries(AREA_NAMES).filter(([k]) => q[k]).map(([k, label]) => {
			const pct = Math.round((q[k].seen || 0) * 100);
			return el('div', { className: `anim-conf-row${pct < 60 ? ' low' : ''}` }, el('span', { textContent: label }), el('div', { className: 'bar' }, el('div', { style: `width:${pct}%` })), el('span', { className: 'muted small', textContent: `${pct}% seen` }));
		}));
		const uncertain = (q.uncertain || []).map((k) => AREA_NAMES[k] || k);
		const dl = (fmt, label, extra = '') => { const a = el('a', { className: 'chip-btn', href: `/api/motions/${m.id}.${fmt}${extra}`, textContent: label }); return a; };
		const fbx = el('button', { type: 'button', className: 'chip-btn', textContent: 'FBX' });
		fbx.addEventListener('click', () => download(`/api/motions/${m.id}.fbx?names=mixamo`, fbx));
		const json = el('button', { type: 'button', className: 'chip-btn', textContent: 'JSON' });
		json.addEventListener('click', () => { const blob = new Blob([JSON.stringify(m, null, 1)], { type: 'application/json' }); const a = el('a', { href: URL.createObjectURL(blob), download: `${m.name}.json` }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); });
		box.replaceChildren(el('div', { className: 'card anim-result' },
			el('div', { className: 'anim-head' }, el('h3', { textContent: m.name }), el('span', { className: 'muted small', textContent: `${m.duration} s · ${m.fps} fps · ${m.frameCount} frames` })),
			...(people ? [people] : []),
			stageEl,
			el('div', { className: 'anim-transport' }, play, scrub, time),
			el('div', { className: 'card-cap', textContent: 'Tracking confidence' }), conf,
			...(uncertain.length ? [el('p', { className: 'anim-warn small', textContent: `Not clearly in view for much of the clip: ${uncertain.join(', ')}. Those parts hold their last known position instead of being guessed.` })] : []),
			el('div', { className: 'card-cap', textContent: 'Movement' }),
			el('ul', { className: 'anim-desc small' }, ...(m.description || []).map((d) => el('li', { textContent: d }))),
			el('div', { className: 'card-cap', textContent: 'Export' }),
			el('div', { className: 'row anim-export' }, dl('bvh', 'BVH'), fbx, json),
			...(shared ? [shared] : []),
			el('p', { className: 'muted small', textContent: 'FBX uses Mixamo bone names, so it retargets onto most humanoid rigs. Root motion is estimated from one camera.' })));
		setupPlayer(m, play, scrub, time);
	}

	async function download(url, btn) {
		const label = btn.textContent;
		btn.disabled = true; btn.textContent = 'Making…';
		try {
			const res = await fetch(url);
			if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
			const blob = await res.blob();
			const name = decodeURIComponent((res.headers.get('content-disposition') || '').split("''")[1] || 'motion.fbx');
			const a = el('a', { href: URL.createObjectURL(blob), download: name });
			a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
		} catch (err) { toast(err.message); }
		finally { btn.disabled = false; btn.textContent = label; }
	}

	async function setupPlayer(m, play, scrub, time) {
		const fig = await figure();
		if (!st.viewer) st.viewer = { v: fig.body.createViewer(st.holder, { handles: false }) };
		const video = $('anim-result').querySelector('video'), canvas = $('anim-result').querySelector('canvas');
		const marks = st.landmarks?.[m.id];
		const show = (i) => {
			st.frame = i;
			const fr = m.frames[i];
			// Across the floor, the figure moves up to a metre each way; further is shown at the edge.
			const root = fr.root || [0, 0, 0];
			const pose = { ...fr.pose, hips: { ...fr.pose.hips, x: Math.max(-100, Math.min(100, root[0])), z: Math.max(-100, Math.min(100, root[2])) } };
			st.viewer.v.update({ ...fig.values, pose });
			scrub.value = String(i);
			time.textContent = `${fr.t.toFixed(1)} / ${m.duration.toFixed(1)} s`;
			if (video && Math.abs(video.currentTime - fr.t) > 0.06) video.currentTime = fr.t;
			if (canvas && video) drawSkeleton(canvas, video, marks?.[i]);
		};
		const setPlaying = (on) => {
			st.playing = on;
			play.classList.toggle('on', on);
			play.ariaLabel = on ? 'Pause' : 'Play';
			clearInterval(st.timer);
			if (on) st.timer = setInterval(() => show((st.frame + 1) % m.frames.length), 1000 / m.fps);
		};
		play.onclick = () => setPlaying(!st.playing);
		scrub.oninput = () => { setPlaying(false); show(Number(scrub.value)); };
		video?.addEventListener('seeked', () => drawSkeleton(canvas, video, marks?.[st.frame]));
		show(0);
		setPlaying(true);
	}

	function drawSkeleton(canvas, video, pts) {
		const r = video.getBoundingClientRect();
		canvas.width = Math.round(r.width * devicePixelRatio); canvas.height = Math.round(r.height * devicePixelRatio);
		const g = canvas.getContext('2d');
		g.clearRect(0, 0, canvas.width, canvas.height);
		if (!pts || !video.videoWidth) return;
		// The video is letterboxed inside its box (object-fit: contain): find the picture's rectangle.
		const k = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
		const w = video.videoWidth * k, h = video.videoHeight * k, ox = (canvas.width - w) / 2, oy = (canvas.height - h) / 2;
		const P = (p) => [ox + p[0] * w, oy + p[1] * h];
		g.lineWidth = 3 * devicePixelRatio; g.lineCap = 'round'; g.strokeStyle = COLOURS[st.result.current % COLOURS.length];
		for (const [a, b] of BONES) {
			if (!pts[a] || !pts[b]) continue;
			const [x1, y1] = P(pts[a]), [x2, y2] = P(pts[b]);
			g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
		}
		g.fillStyle = '#fff';
		for (const p of pts) { if (!p) continue; const [x, y] = P(p); g.beginPath(); g.arc(x, y, 2.5 * devicePixelRatio, 0, Math.PI * 2); g.fill(); }
	}

	function stop() {
		clearInterval(st.timer);
		st.playing = false;
	}

	// ---------- library ----------
	async function renderLibrary() {
		const box = $('anim-library');
		box.replaceChildren(el('div', { className: 'muted small', textContent: 'Loading…' }));
		const { motions } = await api('GET', '/api/motions');
		if (!motions.length) return box.replaceChildren(el('div', { className: 'card anim-empty' }, el('p', { textContent: 'No animations yet.' }), el('p', { className: 'muted small', textContent: 'Choose a video in "From video" and its motion is saved here, ready to play on the figure or export as BVH, FBX or JSON.' })));
		box.replaceChildren(...motions.map((m) => {
			const q = m.quality || {};
			const seen = Object.keys(AREA_NAMES).filter((k) => q[k]).map((k) => q[k].seen);
			const avg = seen.length ? Math.round((seen.reduce((a, b) => a + b, 0) / seen.length) * 100) : null;
			const row = el('div', { className: 'anim-item' },
				el('button', { type: 'button', className: 'anim-item-main' },
					el('div', { className: 'anim-item-title', textContent: m.name }),
					el('div', { className: 'muted small', textContent: `${m.duration} s · ${new Date(m.created).toLocaleDateString()}${avg != null ? ` · ${avg}% tracked` : ''}${m.people > 1 ? ` · ${m.people} people in clip` : ''}` })),
				el('button', { type: 'button', className: 'icon-btn always anim-del', ariaLabel: `Delete ${m.name}`, innerHTML: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12M9 7V5h6v2M8 7l1 12h6l1-12"/></svg>' }));
			row.querySelector('.anim-item-main').addEventListener('click', () => open([m.id]));
			row.querySelector('.anim-del').addEventListener('click', async () => { if (!confirm(`Delete "${m.name}"?`)) return; await api('DELETE', `/api/motions/${m.id}`); renderLibrary(); });
			return row;
		}));
	}

	return {
		show() { setTab(st.tab); },
		hide() { stop(); st.running?.abort(); }
	};
}
