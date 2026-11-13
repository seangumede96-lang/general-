import { renderMarkdown } from './markdown.js';

// If anything in the page breaks, say so on screen: on a phone there is no console to look at.
function showScriptError(message) {
	const box = document.getElementById('js-error');
	box.textContent = `Something in the page broke: ${message}. Take a screenshot of this for support, then reload.`;
	box.hidden = false;
	box.onclick = () => { box.hidden = true; };
}
window.addEventListener('error', (e) => showScriptError(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => showScriptError(e.reason?.message || String(e.reason)));


const $ = (id) => document.getElementById(id);
const els = {
	conversations: $('conversations'), thread: $('thread'), scroller: $('scroller'), title: $('title'),
	input: $('input'), send: $('send'), composer: $('composer'), scrim: $('scrim'),
	settings: $('settings'), settingsForm: $('settings-form'), settingsStatus: $('settings-status'),
	modelList: $('model-list'), keyNote: $('key-note')
};

const state = {
	conversations: [],
	currentId: null,
	messages: [],      // saved messages of the open conversation
	working: false,
	live: null,        // { text, thinking } for the reply being generated
	awaiting: new Map(), // tool-call id -> note (such as a price) for calls waiting for approval
	events: null       // EventSource of the open conversation
};

async function api(method, path, body) {
	const res = await fetch(path, {
		method,
		headers: body ? { 'Content-Type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
	return data;
}

// Any element with data-since shows the minutes and seconds since that moment, ticking once a second.
const sinceText = (ms) => { const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
setInterval(() => { for (const n of document.querySelectorAll('[data-since]')) n.textContent = sinceText(Number(n.dataset.since)); }, 1000);
// While a machine starts, a word rotates above its progress bar so it is plain that work is going on.
const BOOT_WORDS = {
	0: ['Booting…', 'Waking the GPU…', 'Warming up…', 'Spinning up…', 'Powering on…'],
	1: ['Unpacking…', 'Installing…', 'Assembling…', 'Tightening bolts…', 'Setting the table…'],
	download: ['Fetching gigabytes…', 'Downloading…', 'Hauling weights…', 'Pulling models…', 'Filling the tank…'],
	load: ['Cogitating…', 'Loading neurons…', 'Percolating…', 'Brewing…', 'Simmering…'],
	gen: ['Cooking…', 'Rendering…', 'Painting frames…', 'Conjuring…', 'Crafting…']
};
let bootTick = 0;
setInterval(() => {
	bootTick++;
	for (const n of document.querySelectorAll('.boot-word')) {
		const list = BOOT_WORDS[n.dataset.words] || BOOT_WORDS[0];
		n.textContent = list[bootTick % list.length];
	}
	for (const n of document.querySelectorAll('[data-eta-until]')) n.textContent = etaText(Number(n.dataset.etaUntil));
}, 1000);
const clockText = (sec) => `${Math.floor(sec / 60)}:${String(Math.max(0, Math.floor(sec % 60))).padStart(2, '0')}`;
const etaText = (until) => { const sec = Math.round((until - Date.now()) / 1000); return sec > 0 ? `about ${clockText(sec)} left` : 'any moment now'; };

/** Bar, elapsed time, estimated time left and a rotating status word for a machine that is starting. */
function progressNode(p, extra = '') {
	if (!p) return el('div');
	const label = p.steps[p.index] || '';
	const words = /download/i.test(label) ? 'download' : /loading the model/i.test(label) ? 'load' : /replacing|render/i.test(label) ? 'gen' : p.index === 0 ? 0 : 1;
	const word = el('span', { className: 'boot-word', textContent: BOOT_WORDS[words][bootTick % BOOT_WORDS[words].length] });
	word.dataset.words = String(words);
	const eta = el('span', { className: 'boot-eta', textContent: etaText(Date.now() + p.etaSeconds * 1000) });
	eta.dataset.etaUntil = String(Date.now() + p.etaSeconds * 1000);
	const meta = el('div', { className: 'boot-meta' },
		p.steps.length > 1 ? `Step ${p.index + 1} of ${p.steps.length} · ` : '', label, p.detail ? ` (${p.detail})` : '', ' · ', sinceNode(Date.now() - p.elapsedSeconds * 1000), ' so far', extra);
	const node = el('div', { className: 'boot' },
		el('div', { className: 'boot-top' }, el('span', { className: 'spin', textContent: '✻', ariaHidden: 'true' }), word, eta),
		el('div', { className: 'bar', role: 'progressbar', ariaValueNow: Math.round(p.fraction * 100), ariaValueMin: 0, ariaValueMax: 100 }, el('div', { style: `width:${Math.round(p.fraction * 100)}%` })),
		meta);
	// During the download step: one row per file with its size, progress and speed.
	if (p.files?.length) {
		const gb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
		node.append(el('div', { className: 'dl-files' }, ...p.files.map((f) => {
			const pct = f.total ? Math.min(100, Math.floor(f.done / f.total * 100)) : 0;
			const done = f.total > 0 && f.done >= f.total;
			const right = done ? `${gb(f.total)} · done` : f.total ? `${gb(f.done)} of ${gb(f.total)} · ${pct}%${f.speed > 0 ? ` · ${(f.speed / 1e6).toFixed(f.speed < 1e7 ? 1 : 0)} MB/s` : ''}` : `${gb(f.done)} so far`;
			return el('div', { className: `dl-row${done ? ' done' : ''}` },
				el('div', { className: 'dl-top' }, el('span', { className: 'dl-name', textContent: f.name.replace(/\.safetensors$/, '') }), el('span', { textContent: right })),
				el('div', { className: 'bar' }, el('div', { style: `width:${done ? 100 : pct}%` })));
		})));
	}
	if (p.quietSeconds > p.quietLimitSeconds) node.append(el('div', { className: 'boot-quiet', textContent: `No news from the machine for ${clockText(p.quietSeconds)}. Still waiting; if it never gets ready it is shut down by itself and stops charging.` }));
	return node;
}

function sinceNode(ms) { const n = document.createElement('span'); n.dataset.since = String(ms); n.textContent = sinceText(ms); return n; }

/* ---------- Sidebar ---------- */

function el(tag, props = {}, ...children) {
	const node = Object.assign(document.createElement(tag), props);
	node.append(...children);
	return node;
}

function renderSidebar() {
	if (!state.conversations.length) {
		els.conversations.replaceChildren(el('div', { className: 'side-empty', textContent: 'No conversations yet' }));
		return;
	}
	els.conversations.replaceChildren(...state.conversations.map((c) => {
		const open = el('button', { className: 'conv-open', textContent: c.title || 'New chat' });
		open.addEventListener('click', () => openConversation(c.id));
		const del = el('button', { className: 'conv-del', ariaLabel: `Delete ${c.title || 'chat'}` });
		del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/></svg>';
		del.addEventListener('click', () => deleteConversation(c));
		return el('div', { className: `conv${c.id === state.currentId ? ' active' : ''}` }, open, del);
	}));
}

async function refreshConversations() {
	state.conversations = (await api('GET', '/api/conversations')).conversations;
	renderSidebar();
}

async function deleteConversation(c) {
	if (!confirm(`Delete "${c.title || 'New chat'}"? This cannot be undone.`)) return;
	await api('DELETE', `/api/conversations/${c.id}`);
	if (c.id === state.currentId) showBlank();
	await refreshConversations();
}

const setDrawer = (open) => {
	document.body.classList.toggle('drawer', open);
	els.scrim.hidden = !open;
};

/* ---------- Thread ---------- */

const nearBottom = () => els.scroller.scrollHeight - els.scroller.scrollTop - els.scroller.clientHeight < 80;
const scrollToBottom = () => { els.scroller.scrollTop = els.scroller.scrollHeight; };

function assistantNode({ content, reasoning, status }, streaming = false) {
	const node = el('div', { className: 'msg assistant' });
	if (reasoning) {
		const details = el('details', { className: 'thinking', open: streaming && !content });
		details.append(el('summary', { textContent: streaming && !content ? 'Thinking…' : 'Thought process' }), el('div', { className: 'thought', textContent: reasoning }));
		node.append(details);
	}
	const body = el('div', { className: 'body' });
	body.innerHTML = renderMarkdown(content || '');
	if (streaming) body.append(el('span', { className: 'cursor', ariaLabel: 'Generating' }));
	node.append(body);
	if (status === 'stopped') node.append(el('div', { className: 'note', textContent: 'Stopped' }));
	return node;
}

const fmtSize = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/;

/** One attached file inside a sent message: a picture, a playable video, or a download chip. */
function fileNode(f) {
	const src = `/api/uploads/${f.id}`;
	if (INLINE_IMAGE.test(f.type)) return el('img', { src, alt: f.name, loading: 'lazy' });
	if (f.type.startsWith('video/')) return el('video', { src, controls: true, preload: 'metadata', playsInline: true });
	return el('a', { className: 'file-chip', href: src, download: f.name },
		el('div', {}, el('div', { className: 'pend-name', textContent: f.name }), el('div', { className: 'pend-size', textContent: fmtSize(f.size) })));
}

const TOOL_LABELS = {
	list_files: (a) => (a.path ? `List files in ${a.path}` : 'List shared folders'),
	read_file: (a) => `Read ${a.path || 'a file'}`,
	write_file: (a) => `Write ${a.path || 'a file'}`,
	remember: () => 'Save to memory',
	recall: (a) => (a.query ? `Search memory for "${a.query}"` : 'Review recent memories'),
	gpu_status: () => 'Check GPU budget',
	start_gpu: (a) => `Start a GPU for ${a.minutes ?? '?'} min`,
	stop_gpu: () => 'Stop the GPU'
};
const STATUS_TEXT = { running: 'Running', awaiting: 'Needs approval', ok: 'Done', error: 'Failed', denied: 'Declined' };

function toolNode(call, result) {
	let args = {};
	try { args = JSON.parse(call.arguments || '{}') ?? {}; } catch { /* shown raw below */ }
	const status = result ? result.status : state.awaiting.has(call.id) ? 'awaiting' : state.working ? 'running' : 'error';
	const label = (TOOL_LABELS[call.name] || (() => call.name))(args);

	const details = el('details', { className: `tool ${status}`, open: status === 'awaiting' });
	const summary = el('summary', {},
		el('span', { className: 'tool-label', textContent: label }),
		el('span', { className: 'tool-status', textContent: result || state.working ? STATUS_TEXT[status] : 'Interrupted' }));
	const body = el('div', { className: 'tool-body' });
	const shown = Object.entries(args).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n') || call.arguments || '(no input)';
	body.append(el('div', { className: 'tool-cap', textContent: 'Input' }), el('pre', { textContent: shown }));
	if (result) body.append(el('div', { className: 'tool-cap', textContent: 'Result' }), el('pre', { textContent: result.content }));
	details.append(summary, body);

	if (status !== 'awaiting') return details;
	const allow = el('button', { type: 'button', className: 'btn-primary', textContent: 'Allow' });
	const deny = el('button', { type: 'button', className: 'btn-ghost', textContent: 'Decline' });
	const decide = (decision) => async () => {
		allow.disabled = deny.disabled = true;
		try { await api('POST', `/api/conversations/${state.currentId}/approvals/${encodeURIComponent(call.id)}`, { decision }); }
		catch { allow.disabled = deny.disabled = false; }
	};
	allow.addEventListener('click', decide('allow'));
	deny.addEventListener('click', decide('deny'));
	const note = state.awaiting.get(call.id);
	return el('div', { className: 'approval' }, details,
		...(note ? [el('div', { className: 'approval-note', textContent: note })] : []),
		el('div', { className: 'approval-actions' }, deny, allow));
}

function messageNode(m, results) {
	if (m.role === 'user') {
		const files = m.attachments ? JSON.parse(m.attachments) : [];
		if (!files.length) return el('div', { className: 'msg user', textContent: m.content });
		const node = el('div', { className: 'msg user has-files' }, el('div', { className: 'files' }, ...files.map(fileNode)));
		if (m.content) node.append(el('div', { className: 'bubble', textContent: m.content }));
		return node;
	}
	if (m.role === 'error') return el('div', { className: 'msg error', role: 'alert', textContent: m.content });
	const calls = m.tool_calls ? JSON.parse(m.tool_calls) : [];
	if (!calls.length) return assistantNode(m);
	const group = el('div', { className: 'msg assistant' });
	if (m.content || m.reasoning) group.append(...assistantNode(m).childNodes);
	group.append(...calls.map((c) => toolNode(c, results.get(c.id))));
	return group;
}

/** In plain words, what the model is doing at this moment. */
function turnStatus(results) {
	if (state.awaiting.size) return 'Waiting for you to allow or decline';
	const last = state.messages.filter((m) => m.role === 'assistant' && m.tool_calls).at(-1);
	const open = last && JSON.parse(last.tool_calls).find((c) => !results.has(c.id));
	if (open) {
		let args = {};
		try { args = JSON.parse(open.arguments || '{}') ?? {}; } catch { /* label falls back to the tool name */ }
		return `Doing: ${(TOOL_LABELS[open.name] || (() => open.name))(args)}`;
	}
	if (state.live?.text) return 'Writing the answer';
	if (state.live?.thinking) return 'Thinking it through';
	return state.messages.at(-1)?.role === 'tool' ? 'Reading the result' : 'Waiting for the model to respond';
}

function renderThread() {
	const results = new Map(state.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m]));
	const nodes = state.messages.filter((m) => m.role !== 'tool').map((m) => messageNode(m, results));
	if (state.working) {
		nodes.push(Object.assign(assistantNode(state.live || {}, true), { id: 'live' }));
		nodes.push(el('div', { className: 'turn-status', id: 'turn-status' }, el('span', { className: 'dot' }), el('span', { id: 'turn-status-label', textContent: turnStatus(results) }), '·', sinceNode(state.turnStartedAt || Date.now())));
	}
	els.thread.replaceChildren(...nodes);
	document.body.classList.toggle('is-empty', !nodes.length);
	document.body.classList.toggle('working', state.working);
	syncSend();
	scrollToBottom();
}

let liveFrame = 0;
function renderLive() {
	if (liveFrame) return;
	liveFrame = requestAnimationFrame(() => {
		liveFrame = 0;
		const old = $('live');
		if (!old || !state.working) return;
		const stick = nearBottom();
		const wasOpen = old.querySelector('details')?.open;
		const label = $('turn-status-label');
		if (label) label.textContent = state.live.text ? 'Writing the answer' : 'Thinking it through';
		const next = Object.assign(assistantNode(state.live, true), { id: 'live' });
		const details = next.querySelector('details');
		if (details && wasOpen !== undefined && state.live.text) details.open = wasOpen;
		old.replaceWith(next);
		if (stick) scrollToBottom();
	});
}

function syncSend() {
	const hasFile = pending.some((p) => p.id);
	const busy = pending.some((p) => p.uploading);
	els.send.disabled = !state.working && (busy || (!els.input.value.trim() && !hasFile));
	els.send.setAttribute('aria-label', state.working ? 'Stop generating' : 'Send');
}

/* ---------- Conversation lifecycle ---------- */

function closeEvents() {
	state.events?.close();
	state.events = null;
}

function showBlank() {
	localStorage.removeItem('lastView');
	setView('chat');
	closeEvents();
	Object.assign(state, { currentId: null, messages: [], working: false, live: null, awaiting: new Map() });
	els.title.textContent = 'New chat';
	history.replaceState(null, '', location.pathname);
	renderSidebar();
	renderThread();
}

/** Open a conversation and resolve once its event stream has delivered the first snapshot. */
function openConversation(id) {
	setView('chat');
	closeEvents();
	setDrawer(false);
	state.currentId = id;
	localStorage.setItem('lastView', id);
	history.replaceState(null, '', `#${id}`);
	els.title.textContent = state.conversations.find((c) => c.id === id)?.title || 'New chat';
	renderSidebar();

	return new Promise((resolve) => {
		const events = new EventSource(`/api/conversations/${id}/events`);
		state.events = events;
		events.onmessage = (e) => {
			if (state.events !== events) return;
			handleEvent(JSON.parse(e.data));
			resolve();
		};
		events.onerror = () => {
			// EventSource retries by itself; a closed stream means the conversation is gone.
			if (events.readyState === EventSource.CLOSED && state.events === events) { showBlank(); refreshConversations(); }
			resolve();
		};
	});
}

function handleEvent(ev) {
	switch (ev.t) {
		case 'snapshot':
			state.messages = ev.messages;
			state.working = ev.working;
			state.live = ev.working ? { text: ev.text, thinking: ev.thinking } : null;
			if (ev.working && !state.working) state.turnStartedAt = Date.now();
			state.awaiting = new Map((ev.awaiting || []).map((a) => [a.id, a.note]));
			renderThread();
			break;
		case 'message':
			if (!state.messages.some((m) => m.id === ev.message.id)) state.messages.push(ev.message);
			if (state.live) state.live = { text: '', thinking: '' };
			renderThread();
			break;
		case 'approval':
			if (ev.waiting) state.awaiting.set(ev.id, ev.note || ''); else state.awaiting.delete(ev.id);
			renderThread();
			break;
		case 'user':
			if (!state.messages.some((m) => m.id === ev.message.id)) state.messages.push(ev.message);
			renderThread();
			break;
		case 'title':
			els.title.textContent = ev.title;
			refreshConversations();
			break;
		case 'turn':
			if (ev.phase === 'start') {
				state.working = true;
				state.turnStartedAt = Date.now();
				state.live = { text: '', thinking: '' };
			} else {
				state.working = false;
				state.live = null;
				state.awaiting.clear();
				refreshChip();
				refreshConversations();
			}
			renderThread();
			break;
		case 'text':
			if (state.live) { state.live.text += ev.text; renderLive(); }
			break;
		case 'thinking':
			if (state.live) { state.live.thinking += ev.text; renderLive(); }
			break;
	}
}

async function send() {
	const text = els.input.value.trim();
	const ready = pending.filter((p) => p.id);
	if ((!text && !ready.length) || state.working || pending.some((p) => p.uploading)) return;
	els.input.value = '';
	pending = pending.filter((p) => !p.id);
	renderTray();
	autoGrow();
	try {
		if (!state.currentId) {
			const conv = await api('POST', '/api/conversations');
			state.conversations.unshift(conv);
			await openConversation(conv.id);
		}
		await api('POST', `/api/conversations/${state.currentId}/messages`, { text, attachments: ready.map((p) => p.id) });
		for (const p of ready) if (p.preview) URL.revokeObjectURL(p.preview);
	} catch (err) {
		els.input.value = text;
		pending = [...ready, ...pending];
		renderTray();
		autoGrow();
		state.messages.push({ id: `local-${Date.now()}`, role: 'error', content: `Message not sent: ${err.message}` });
		renderThread();
	}
}

/* ---------- Attachments ---------- */

/** Files chosen but not yet sent: { file, preview, progress, uploading, id, error, xhr } */
let pending = [];

function renderTray() {
	$('tray').replaceChildren(...pending.map((p) => {
		const isImage = p.file.type.startsWith('image/');
		const isVideo = p.file.type.startsWith('video/');
		const node = el('div', { className: `pend${isImage || isVideo ? '' : ' file'}${p.error ? ' failed' : ''}`, title: p.file.name });
		if (isImage) node.append(el('img', { src: p.preview, alt: p.file.name }));
		else if (isVideo) node.append(el('video', { src: `${p.preview}#t=0.1`, muted: true, preload: 'metadata', playsInline: true }));
		else node.append(el('div', { className: 'pend-name', textContent: p.file.name }), el('div', { className: 'pend-size', textContent: fmtSize(p.file.size) }));
		if (p.uploading) node.append(el('div', { className: 'pend-bar', style: `width:${p.progress}%` }));
		if (p.error) node.append(el('div', { className: 'pend-err', textContent: p.error }));
		const x = el('button', { type: 'button', className: 'pend-x', ariaLabel: `Remove ${p.file.name}` });
		x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
		x.addEventListener('click', () => {
			p.xhr?.abort();
			if (p.preview) URL.revokeObjectURL(p.preview);
			pending = pending.filter((q) => q !== p);
			renderTray();
		});
		node.append(x);
		return node;
	}));
	syncSend();
}

/** Upload one file with progress. XMLHttpRequest is used because fetch cannot report upload progress. */
function uploadFile(p) {
	const xhr = p.xhr = new XMLHttpRequest();
	xhr.open('POST', `/api/uploads?name=${encodeURIComponent(p.file.name)}`);
	xhr.setRequestHeader('Content-Type', p.file.type || 'application/octet-stream');
	xhr.upload.onprogress = (e) => { if (e.lengthComputable) { p.progress = Math.round(e.loaded / e.total * 100); renderTray(); } };
	xhr.onload = () => {
		p.uploading = false;
		let body = {};
		try { body = JSON.parse(xhr.responseText); } catch { /* handled below */ }
		if (xhr.status === 200 && body.id) p.id = body.id; else p.error = body.error || 'Upload failed';
		renderTray();
	};
	xhr.onerror = () => { p.uploading = false; p.error = 'Upload failed'; renderTray(); };
	xhr.onabort = () => { p.uploading = false; };
	xhr.send(p.file);
}

function addFiles(files) {
	for (const file of files) {
		if (pending.length >= 10) break;
		const visual = file.type.startsWith('image/') || file.type.startsWith('video/');
		const p = { file, preview: visual ? URL.createObjectURL(file) : null, progress: 0, uploading: true, id: null, error: null };
		pending.push(p);
		uploadFile(p);
	}
	renderTray();
}

$('file-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
// Pasting a screenshot or dropping files onto the page attaches them too.
els.input.addEventListener('paste', (e) => { if (e.clipboardData?.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } });
document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', (e) => { if (e.dataTransfer?.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });

const stop = () => api('POST', `/api/conversations/${state.currentId}/stop`).catch(() => {});

/* ---------- Composer ---------- */

function autoGrow() {
	els.input.style.height = 'auto';
	els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
	syncSend();
}

els.input.addEventListener('input', autoGrow);
els.input.addEventListener('keydown', (e) => {
	// Enter sends with a keyboard; on touch screens Enter stays a newline, as in mobile chat apps.
	const touch = matchMedia('(pointer: coarse)').matches;
	if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch) { e.preventDefault(); send(); }
});
els.composer.addEventListener('submit', (e) => {
	e.preventDefault();
	if (state.working) stop(); else send();
});

els.thread.addEventListener('click', async (e) => {
	const btn = e.target.closest('.copy');
	if (!btn) return;
	try {
		await navigator.clipboard.writeText(btn.closest('pre').querySelector('code').textContent);
		btn.textContent = 'Copied';
	} catch { btn.textContent = 'Copy failed'; }
	setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
});

for (const id of ['new-chat', 'header-new']) $(id).addEventListener('click', () => { setDrawer(false); showBlank(); els.input.focus(); });
$('menu').addEventListener('click', () => setDrawer(true));
els.scrim.addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(false); });

/* ---------- Settings ---------- */

function setStatus(text, kind = '') {
	els.settingsStatus.textContent = text;
	els.settingsStatus.className = kind;
}

const formValues = () => Object.fromEntries(new FormData(els.settingsForm));

$('open-settings').addEventListener('click', async () => {
	setDrawer(false);
	const s = await api('GET', '/api/settings');
	for (const [k, v] of Object.entries(s)) {
		const field = els.settingsForm.elements[k];
		if (field) field.value = v ?? '';
	}
	els.settingsForm.elements.apiKey.value = '';
	els.settingsForm.elements.apiKey.placeholder = s.hasApiKey ? 'Saved (hidden)' : 'Not set';
	setStatus('');
	openDialog(els.settings);
});

$('cancel-settings').addEventListener('click', () => els.settings.close());

$('test-endpoint').addEventListener('click', async () => {
	setStatus('Saving and testing…');
	try {
		await api('PUT', '/api/settings', formValues());
		const { models } = await api('GET', '/api/models');
		els.modelList.replaceChildren(...models.map((m) => el('option', { value: m })));
		setStatus(models.length ? `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.` : 'Connected, but the endpoint lists no models.', 'good');
	} catch (err) {
		setStatus(err.message, 'bad');
	}
});

els.settingsForm.addEventListener('submit', async (e) => {
	e.preventDefault();
	try {
		await api('PUT', '/api/settings', formValues());
		els.settings.close();
		refreshChip();
	} catch (err) {
		setStatus(err.message, 'bad');
	}
});

/* ---------- System page ---------- */

const sys = {
	view: $('system'), error: $('sys-error'), remaining: $('sys-remaining'), meter: $('sys-meter'), spent: $('sys-spent'),
	unknown: $('sys-unknown'), active: $('sys-active'), minutes: $('sys-minutes'), quoteOut: $('sys-quote-out'),
	form: $('sys-form'), formStatus: $('sys-form-status'), history: $('sys-history'), timer: 0
};
const money = (n) => `$${Number(n).toFixed(2)}`;
const clock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

/* Pages other than chat. Each has a section in the HTML and hooks to start and stop its refresh. */
const pages = {
	system: { title: 'System', show: () => { refreshSystem(true); sys.timer = setInterval(() => refreshSystem(false), 5000); }, hide: () => clearInterval(sys.timer) },
	video: { title: 'Video', show: () => video.show(), hide: () => video.hide() },
	characters: { title: 'Characters', show: () => chars.show(), hide: () => chars.hide() },
	mocap: { title: 'Motion capture', show: () => mocap.show(), hide: () => mocap.hide() },
	body: { title: 'Body', show: () => bodyEditor.show(), hide: () => {} }
};
// stack: pages underneath the one showing (a sub-page such as the body editor sits on Characters),
// each with a history entry of its own so the phone's back gesture steps back through them.
const nav = { page: null, returnTo: null, pushed: false, stack: [] };
/** Pages that are opened from another page, and so go back to it. */
const PARENT_PAGE = { body: 'characters' };

function setView(view) {
	const page = pages[view] ? view : null;
	if (nav.page && nav.page !== page) pages[nav.page].hide();
	// "view-system" is the historical class name for "a page other than chat is showing".
	document.body.classList.toggle('view-system', Boolean(page));
	for (const name of Object.keys(pages)) $(name).hidden = name !== page;
	$('back').hidden = !page;
	const changed = nav.page !== page;
	nav.page = page;
	if (!page) nav.stack = [];
	if (page && changed) {
		localStorage.setItem('lastView', page);
		closeEvents();
		els.title.textContent = pages[page].title;
		renderSidebar();
		pages[page].show();
	}
}

/**
 * Open a page, remembering which chat was open so Back returns to it. A sub-page (sub: true)
 * opens on top of the current page, so Back returns to that page rather than to the chat.
 */
function openPage(name, { sub = false } = {}) {
	if (nav.page === name) return;
	if (!nav.page) {
		nav.returnTo = state.currentId;
		state.currentId = null;
		nav.stack = [];
		// A history entry of its own, so the phone's back button or gesture leaves the page too.
		history.pushState({ page: name }, '', `#${name}`);
		nav.pushed = true;
	} else if (sub) {
		nav.stack.push(nav.page);
		history.pushState({ page: name }, '', `#${name}`);
	} else {
		history.replaceState({ page: name }, '', `#${name}`);
	}
	setView(name);
}

/** One step back: the page underneath, else the chat. */
function goBack() {
	if (nav.pushed) history.back(); // popstate does the rest
	else if (nav.stack.length) setView(nav.stack.pop());
	else leavePage();
}

/** Leave a page for the chat that was open before, or a blank chat. */
function leavePage() {
	if (!nav.page) return;
	const id = nav.returnTo;
	nav.returnTo = null;
	nav.pushed = false;
	nav.stack = [];
	if (id && state.conversations.some((c) => c.id === id)) openConversation(id);
	else showBlank();
}

$('back').addEventListener('click', goBack);

/**
 * Open a dialog with its own history entry, so the phone's back button or gesture closes it
 * instead of leaving the app or getting stuck. Closing it any other way removes that entry.
 */
function openDialog(dialog) {
	if (dialog.open) return;
	dialog.showModal();
	history.pushState({ dialog: dialog.id }, '');
	dialog.dataset.pushed = '1';
}
for (const dialog of document.querySelectorAll('dialog')) {
	dialog.addEventListener('close', () => {
		// Remove the dialog's history entry; the popstate that follows is ours, not a Back press.
		if (dialog.dataset.pushed) { delete dialog.dataset.pushed; if (history.state?.dialog === dialog.id) { nav.ownBack = true; history.back(); } }
	});
}
window.addEventListener('popstate', () => {
	if (nav.ownBack) { nav.ownBack = false; return; }
	const open = [...document.querySelectorAll('dialog[open]')];
	if (open.length) { for (const d of open) { delete d.dataset.pushed; d.close(); } return; }
	if (nav.stack.length) { setView(nav.stack.pop()); return; }
	leavePage();
});

function kv(pairs) {
	return el('div', { className: 'kv' }, ...pairs.map(([k, v]) => el('span', {}, `${k} `, el('b', { textContent: v }))));
}

async function stopPod(id, label) {
	if (!confirm(`Delete ${label} now? Anything on it is lost.`)) return;
	try { await api('DELETE', `/api/system/pods/${id}`); } catch (err) { alert(err.message); }
	refreshSystem(false);
}

async function refreshSystem(fillForm) {
	let s;
	try { s = await api('GET', '/api/system'); } catch (err) { sys.error.hidden = false; sys.error.textContent = err.message; return; }
	if (nav.page !== 'system') return;
	sys.error.hidden = !s.error;
	sys.error.textContent = s.error || '';

	const { total, spent, remaining, balance, cap, known } = s.budget;
	sys.remaining.textContent = known ? money(remaining) : '–';
	sys.meter.style.width = `${total > 0 ? Math.min(100, spent / total * 100) : 0}%`;
	sys.meter.parentElement.classList.toggle('low', known && remaining < 1);
	const parts = [];
	if (balance !== null) parts.push(`RunPod balance ${money(balance)}`);
	else if (s.configured) parts.push('RunPod balance could not be read');
	if (cap !== null) parts.push(`capped by you at ${money(cap)} in total`);
	parts.push(`${money(spent)} spent through this app`);
	sys.spent.textContent = parts.join(' · ');

	sys.unknown.replaceChildren(...s.unknown.map((p) => {
		const del = el('button', { type: 'button', className: 'btn-danger', textContent: 'Delete' });
		del.addEventListener('click', () => stopPod(p.id, `"${p.name}"`));
		return el('div', { className: 'card warn' },
			el('div', { className: 'card-cap', textContent: 'Pod not started by this app' }),
			el('div', { className: 'pod' },
				el('div', { className: 'pod-main' }, el('div', { className: 'pod-title', textContent: p.name || p.id }), kv([['Status', p.status], ['Rate', `${money(p.rate)}/h`]])),
				del));
	}));

	if (!s.configured) sys.active.replaceChildren(el('div', { className: 'muted', textContent: 'Add a RunPod API key below to get started.' }));
	else if (!s.active.length) sys.active.replaceChildren(el('div', { className: 'muted', textContent: 'Nothing is running. Nothing is being charged.' }));
	else sys.active.replaceChildren(...s.active.map((p) => {
		const stop = el('button', { type: 'button', className: 'btn-danger', textContent: 'Stop' });
		stop.addEventListener('click', () => stopPod(p.id, 'the running pod'));
		return el('div', { className: 'pod' },
			el('div', { className: 'pod-main' },
				el('div', { className: 'pod-title', textContent: `${p.gpu} · ${p.purpose || p.name}` }),
				kv([['Cost so far', money(p.cost)], ['Rate', `${money(p.rate)}/h`], ['Time left', clock(p.secondsLeft)], ['Idle stop in', clock(p.idleStopInSeconds)]])),
			stop);
	}));

	sys.history.replaceChildren(...(s.history.length ? s.history.map((p) => el('div', { className: 'hist' },
		el('span', {}, `${new Date(p.created_at).toLocaleDateString()} · ${p.gpu} · ${p.purpose || p.name}`, el('span', { className: 'muted', textContent: ` (${p.end_reason || 'ended'})` })),
		el('span', { textContent: `${p.final ? '' : '≈ '}${money(p.cost)}` })))
		: [el('div', { className: 'muted', textContent: 'No pods yet.' })]));

	const brainText = { off: 'Asleep. Nothing is being charged for it.', starting: 'Waking up: downloading and loading the model. This takes several minutes.', ready: 'Awake. Chat is using it.' };
	Object.assign($('sys-brain-state'), { className: `brain-state ${s.brain.state}`, textContent: brainText[s.brain.state] });

	if (fillForm) {
		const settings = await api('GET', '/api/settings');
		$('sys-brain-model').value = settings.brainModel;
		$('sys-brain-out').replaceChildren();
		for (const name of ['budgetTotal', 'maxPodMinutes', 'idleMinutes']) sys.form.elements[name].value = settings[name];
		sys.form.elements.runpodApiKey.value = '';
		sys.form.elements.runpodApiKey.placeholder = settings.hasRunpodApiKey ? 'Saved (hidden)' : 'Not set';
		sys.form.elements.hfToken.value = '';
		sys.form.elements.hfToken.placeholder = settings.hasHfToken ? 'Saved (hidden)' : 'Not set';
		sys.formStatus.textContent = '';
		sys.quoteOut.replaceChildren();
	}
}

/** Show the worst-case price for a pod, then start it only when the user confirms that price. */
async function quoteAndStart(kind, minutes, out) {
	out.replaceChildren(el('div', { className: 'muted small', textContent: 'Checking prices…' }));
	const fail = (message) => out.replaceChildren(el('div', { className: 'sys-alert', textContent: message }));
	let q;
	try { q = await api('POST', '/api/system/quote', { minutes, kind }); } catch (err) { return fail(err.message); }
	if (!q.allowed) return fail(q.reason);
	const go = el('button', { type: 'button', className: 'btn-primary', textContent: `Start for up to ${money(q.estimate)}` });
	go.addEventListener('click', async () => {
		go.disabled = true;
		go.textContent = 'Starting…';
		try {
			await api('POST', '/api/system/pods', { minutes, confirmEstimate: q.estimate, kind });
			out.replaceChildren();
		} catch (err) { fail(err.message); }
		refreshSystem(false);
	});
	out.replaceChildren(el('div', { className: 'row' }, el('span', { className: 'small', textContent: q.summary }), el('span', { className: 'spacer' }), go));
}

$('sys-quote').addEventListener('click', () => quoteAndStart('test', Number(sys.minutes.value), sys.quoteOut));
$('sys-brain-quote').addEventListener('click', async () => {
	const out = $('sys-brain-out');
	try { await api('PUT', '/api/settings', { brainModel: $('sys-brain-model').value.trim() }); }
	catch (err) { out.replaceChildren(el('div', { className: 'sys-alert', textContent: err.message })); return; }
	quoteAndStart('brain', Number($('sys-brain-minutes').value), out);
});

sys.form.addEventListener('submit', async (e) => {
	e.preventDefault();
	try {
		await api('PUT', '/api/settings', Object.fromEntries(new FormData(sys.form)));
		sys.formStatus.textContent = 'Saved.';
		refreshSystem(true);
	} catch (err) { sys.formStatus.textContent = err.message; }
});

$('open-system').addEventListener('click', () => { setDrawer(false); openPage('system'); });
$('open-video').addEventListener('click', () => { setDrawer(false); openPage('video'); });
$('open-mocap').addEventListener('click', () => { setDrawer(false); openPage('mocap'); });
$('open-characters').addEventListener('click', () => { setDrawer(false); openPage('characters'); });

/* ---------- Video Studio ---------- */

const VIDEO_STEPS = [['starting', 'Renting a GPU'], ['loading', 'Setting up the video engine'], ['uploading', 'Sending your clip'], ['generating', 'Replacing the character'], ['saving', 'Saving the result']];

/** Upload one file, reporting progress; resolves with the server's { id, name, type, size }. */
function uploadWithProgress(file, onProgress) {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open('POST', `/api/uploads?name=${encodeURIComponent(file.name)}`);
		xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
		xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); };
		xhr.onload = () => {
			let body = {};
			try { body = JSON.parse(xhr.responseText); } catch { /* handled below */ }
			if (xhr.status === 200 && body.id) resolve(body); else reject(new Error(body.error || 'Upload failed'));
		};
		xhr.onerror = () => reject(new Error('Upload failed'));
		xhr.send(file);
	});
}

const video = {
	timer: 0, clip: null, picture: null, jobs: [], dismissed: new Set(),

	show() { this.refresh(); this.timer = setInterval(() => this.refresh(), 3000); },
	hide() { clearInterval(this.timer); },

	async refresh() {
		let data;
		try { data = await api('GET', '/api/video'); } catch { return; }
		if (nav.page !== 'video') return;
		this.jobs = data.jobs;
		this.maxClipSeconds = data.limits.maxClipSeconds;
		this.render();
	},

	render() {
		const active = this.jobs.find((j) => j.active);
		$('vid-active').replaceChildren(...(active ? [this.activeCard(active)] : []));
		const latest = this.jobs.find((j) => !j.active && !this.dismissed.has(j.id) && Date.now() - j.ended_at < 3600 * 1000);
		$('vid-result').replaceChildren(...(!active && latest ? [this.resultCard(latest)] : []));
		$('vid-form').hidden = Boolean(active);
		const past = this.jobs.filter((j) => !j.active);
		$('vid-history').replaceChildren(...(past.length ? past.map((j) => {
			const when = new Date(j.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
			const right = j.result
				? el('a', { href: `/api/uploads/${j.result}`, download: '', textContent: 'Download' })
				: el('span', { className: 'muted', textContent: j.status === 'cancelled' ? 'Cancelled' : 'Failed' });
			return el('div', { className: 'hist' }, el('span', {}, when, el('span', { className: 'muted', textContent: ` · ${j.params.seconds} s clip${j.status === 'failed' ? ` · ${j.detail}` : ''}` })), right);
		}) : [el('div', { className: 'muted', textContent: 'Nothing yet.' })]));
		this.note();
	},

	activeCard(job) {
		const at = VIDEO_STEPS.findIndex(([s]) => s === job.status);
		const stop = el('button', { type: 'button', className: 'btn-danger', textContent: 'Cancel' });
		stop.addEventListener('click', async () => {
			if (!confirm('Cancel this video? The GPU is shut down and time already used is still charged.')) return;
			stop.disabled = true;
			await api('POST', `/api/video/jobs/${job.id}/cancel`).catch(() => {});
			this.refresh();
		});
		return el('div', { className: 'card' },
			el('div', { className: 'card-cap', textContent: 'Working on your video' }),
			el('ul', { className: 'steps' }, ...VIDEO_STEPS.map(([, label], i) => {
				const text = el('span', {}, label);
				if (i === at && job.detail && job.detail !== label) text.append(' ', el('small', { textContent: `· ${job.detail}` }));
				return el('li', { className: i < at ? 'done' : i === at ? 'now' : '' }, text);
			})),
			progressNode(job.progress),
			el('div', { className: 'row' },
				el('span', { className: 'muted small', textContent: `${job.params.run === 'until-done' ? 'Runs until the video is done' : `GPU time left: ${job.gpuSecondsLeft == null ? `up to ${job.params.minutes} min` : clock(job.gpuSecondsLeft)}`}, at most ${money(job.params.estimate)}. You can leave this page.` }),
				el('span', { className: 'spacer' }), stop));
	},

	resultCard(job) {
		const dismiss = el('button', { type: 'button', className: 'btn-ghost', textContent: 'Make another' });
		dismiss.addEventListener('click', () => { this.dismissed.add(job.id); this.render(); });
		if (job.status !== 'done') {
			return el('div', { className: 'card' },
				el('div', { className: 'card-cap', textContent: job.status === 'cancelled' ? 'Cancelled' : 'That did not work' }),
				el('p', { className: 'sys-alert', textContent: job.detail || 'The video could not be made.' }),
				el('div', { className: 'row' }, el('span', { className: 'muted small', textContent: 'The GPU has been shut down.' }), el('span', { className: 'spacer' }), dismiss));
		}
		const src = `/api/uploads/${job.result}`;
		return el('div', { className: 'card' },
			el('div', { className: 'card-cap', textContent: 'Your video is ready' }),
			el('video', { className: 'result-video', src, controls: true, playsInline: true, preload: 'metadata' }),
			el('div', { className: 'row' }, el('span', { className: 'spacer' }), dismiss, el('a', { className: 'btn-primary', href: src, download: '', textContent: 'Save to phone' })));
	},

	note() {
		const c = this.clip;
		$('vid-note').textContent = c?.meta && c.meta.seconds > this.maxClipSeconds
			? `Only the first ${this.maxClipSeconds} seconds will be processed (your clip is ${Math.round(c.meta.seconds)} s).`
			: '';
	},

	/** Read a video file's length and size in the browser, before anything is uploaded. */
	metadata(file) {
		return new Promise((resolve) => {
			const v = document.createElement('video');
			v.preload = 'metadata';
			v.onloadedmetadata = () => resolve({ seconds: v.duration, width: v.videoWidth, height: v.videoHeight });
			v.onerror = () => resolve(null);
			v.src = URL.createObjectURL(file);
		});
	},

	async choose(kind, file) {
		const slot = $(kind === 'clip' ? 'vid-video-slot' : 'vid-image-slot');
		const button = slot.parentElement;
		$('vid-quote-out').replaceChildren();
		const item = { file, id: null, meta: null };
		this[kind] = item;
		if (kind === 'clip') {
			item.meta = await this.metadata(file);
			if (!item.meta || !(item.meta.seconds > 0)) { this.clip = null; slot.textContent = 'That video could not be read. Try another.'; return; }
		}
		const url = URL.createObjectURL(file);
		const preview = kind === 'clip' ? el('video', { src: `${url}#t=0.1`, muted: true, playsInline: true, preload: 'metadata' }) : el('img', { src: url, alt: 'Character picture' });
		const status = el('span', { className: 'pick-cap', textContent: 'Uploading 0%' });
		slot.replaceChildren(preview);
		button.classList.add('filled');
		button.querySelector('.pick-status')?.remove();
		status.classList.add('pick-status');
		button.append(status);
		this.note();
		try {
			const up = await uploadWithProgress(file, (pct) => { status.textContent = `Uploading ${pct}%`; });
			if (this[kind] !== item) return;
			item.id = up.id;
			status.textContent = kind === 'clip' ? `${Math.round(item.meta.seconds)} s · ${item.meta.width}×${item.meta.height}` : 'Ready';
		} catch (err) {
			if (this[kind] === item) { this[kind] = null; status.textContent = err.message; }
		}
	},

	/** Take a picture made on the Characters page as the character for the next video. */
	usePicture(id, src) {
		this.picture = { id, meta: null };
		const slot = $('vid-image-slot');
		slot.replaceChildren(el('img', { src, alt: 'Character picture' }));
		slot.parentElement.classList.add('filled');
		slot.parentElement.querySelector('.pick-status')?.remove();
		slot.parentElement.append(el('span', { className: 'pick-cap pick-status', textContent: 'From Characters' }));
	},

	request() {
		return {
			kind: 'replace', input: this.clip.id, reference: this.picture.id, prompt: $('vid-prompt').value,
			seconds: this.clip.meta.seconds, width: this.clip.meta.width, height: this.clip.meta.height,
			runMinutes: $('vid-run').value
		};
	},

	async quote() {
		const out = $('vid-quote-out');
		const fail = (message) => out.replaceChildren(el('div', { className: 'sys-alert', textContent: message }));
		if (!this.clip?.id) return fail(this.clip ? 'Your clip is still uploading.' : 'Choose a video first.');
		if (!this.picture?.id) return fail(this.picture ? 'The picture is still uploading.' : 'Choose a picture of the character first.');
		if (!$('vid-rights').checked) return fail('Tick the box to confirm you may use this footage.');
		out.replaceChildren(el('div', { className: 'muted small', textContent: 'Checking prices…' }));
		let q;
		try { q = await api('POST', '/api/video/quote', this.request()); } catch (err) { return fail(err.message); }
		if (!q.allowed) return fail(q.reason);
		const go = el('button', { type: 'button', className: 'btn-primary', textContent: `Process for up to ${money(q.estimate)}` });
		go.addEventListener('click', async () => {
			go.disabled = true;
			go.textContent = 'Starting…';
			try {
				await api('POST', '/api/video/jobs', { ...this.request(), rightsConfirmed: true, confirmEstimate: q.estimate });
				this.clip = this.picture = null;
				$('vid-form').reset();
				$('vid-run').value = localStorage.getItem('videoRun') || 'auto';
				for (const [slot, text] of [['vid-video-slot', 'Choose a video'], ['vid-image-slot', 'Choose a picture']]) {
					$(slot).textContent = text;
					$(slot).parentElement.classList.remove('filled');
					$(slot).parentElement.querySelector('.pick-status')?.remove();
				}
				out.replaceChildren();
				this.refresh();
			} catch (err) { fail(err.message); }
		});
		out.replaceChildren(
			el('div', { className: 'small', textContent: q.run === 'until-done'
				? `${q.seconds} seconds of video, estimated at about ${q.needed} minutes. The GPU runs until the video is done, with no time limit; it is also stopped if setup shows no progress for 20 minutes or generating takes far longer than expected, and after ${Math.round(q.minutes / 6) / 10} hours if this phone goes offline. Worst case: ${q.summary}`
				: `${q.seconds} seconds of video, estimated at about ${q.needed} minutes. The GPU may run for up to ${q.minutes} minutes. ${q.summary}` }),
			...(q.warning ? [el('div', { className: 'sys-alert', style: 'margin-top:8px', textContent: q.warning })] : []),
			el('div', { className: 'row', style: 'margin-top:10px' }, el('span', { className: 'muted small', textContent: 'You pay only for the minutes used.' }), el('span', { className: 'spacer' }), go));
	}
};

$('vid-video-input').addEventListener('change', (e) => { if (e.target.files[0]) video.choose('clip', e.target.files[0]); e.target.value = ''; });
$('vid-image-input').addEventListener('change', (e) => { if (e.target.files[0]) video.choose('picture', e.target.files[0]); e.target.value = ''; });
$('vid-form').addEventListener('submit', (e) => { e.preventDefault(); video.quote(); });
// The run length is remembered; changing it clears an old price so the new one is fetched.
$('vid-run').value = localStorage.getItem('videoRun') || 'auto';
if (!$('vid-run').value) $('vid-run').value = 'auto';
$('vid-run').addEventListener('change', () => { localStorage.setItem('videoRun', $('vid-run').value); $('vid-quote-out').replaceChildren(); });

/* ---------- Characters ---------- */

const KNOWN_TRIGGERS = [[/GTA_VI_3D_Style/i, 'gta6game_']];
// Strengths that worked when these LoRAs were tuned by hand; anything else starts at 0.9.
const KNOWN_STRENGTHS = [[/GTA_VI_3D_Style/i, 0.9]];
const savedStrengths = () => { try { return JSON.parse(localStorage.getItem('loraStrengths') || '{}'); } catch { return {}; } };
const defaultStrength = (name) => savedStrengths()[name] ?? KNOWN_STRENGTHS.find(([re]) => re.test(name))?.[1] ?? 0.9;
const loraLabel = (name) => name.split('/').pop().replace(/\.safetensors$/, '');

const chars = {
	timer: 0, data: null, refs: { face: [], body: [], look: [] }, sig: '', loraSig: null,

	show() { this.refresh(); this.timer = setInterval(() => this.refresh(), 3000); },
	hide() { clearInterval(this.timer); },

	async refresh() {
		let d;
		try { d = await api('GET', '/api/images'); } catch { return; }
		if (nav.page !== 'characters') return;
		this.data = d;
		this.renderSession();
		// Rebuild the gallery only when something changed, so pictures do not flicker every poll.
		const sig = JSON.stringify(d.generations.map((g) => [g.id, g.status]));
		if (sig !== this.sig) { this.sig = sig; this.renderGallery(); }
		this.renderLive();
	},

	/** Live progress of running pictures, updated every poll without rebuilding the gallery. */
	renderLive() {
		for (const g of this.data.generations.filter((x) => x.status === 'running' && x.progress)) {
			const box = document.querySelector(`.gen-live[data-id="${g.id}"]`);
			if (!box) continue;
			const p = g.progress;
			const elapsed = Math.max(0, Math.round((Date.now() - g.created_at) / 1000));
			const fraction = p.steps ? 0.15 + 0.75 * (p.step / p.steps) : p.stage === 'Finishing the pictures' || p.stage === 'Saving' ? 0.95 : 0.08;
			box.querySelector('.bar > div').style.width = `${Math.round(fraction * 100)}%`;
			const quiet = Math.round((Date.now() - p.at) / 1000);
			box.querySelector('.boot-meta').textContent = `${p.steps ? `Drawing: step ${p.step} of ${p.steps}` : p.stage} · ${clock(elapsed)} so far${quiet > 90 ? ` · no update for ${clock(quiet)}` : ''}`;
		}
	},

	renderSession() {
		const { session, loras, b2 } = this.data;
		const text = { off: 'Off. Nothing is being charged.', starting: `Starting up${session.detail ? `: ${session.detail}` : ''}. About 6 minutes.`, ready: `Ready. ${clock(session.secondsLeft)} left; it also stops after 10 quiet minutes.` };
		Object.assign($('img-state'), { className: `brain-state ${session.state}`, textContent: session.state === 'starting' ? 'Starting up' : text[session.state] });
		if (session.state === 'starting') $('img-state').append(progressNode(session.progress));
		const box = $('img-session');
		if (session.state === 'off') {
			if (!box.querySelector('#img-minutes')) {
				const minutes = el('input', { id: 'img-minutes', type: 'number', min: 5, value: 30, inputMode: 'numeric' });
				const get = el('button', { type: 'button', className: 'btn-ghost', textContent: 'Get price' });
				const out = el('div', { className: 'quote-out' });
				get.addEventListener('click', () => this.quote(Number(minutes.value), out));
				box.replaceChildren(
					...(session.lastEnd ? [el('details', { className: 'sys-alert' }, el('summary', { textContent: `Last time ${session.lastEnd}` }),
						...(session.setupLog?.length ? [el('pre', { className: 'setup-log', textContent: session.setupLog.join('\n') })] : []))] : []),
					el('p', { className: 'muted small', textContent: b2 ? 'Rents a GPU, installs Krea 2 and loads your LoRAs from Backblaze. Then you can make as many pictures as you like until it stops.' : 'Rents a GPU and installs Krea 2. Backblaze is not connected, so no style LoRAs will be loaded.' }),
					el('div', { className: 'row' }, el('label', { className: 'inline' }, 'Minutes ', minutes), get), out);
			}
		} else {
			const stop = el('button', { type: 'button', className: 'btn-danger', textContent: 'End session' });
			stop.addEventListener('click', async () => { if (confirm('End the session and shut the GPU down?')) { await api('DELETE', '/api/images/session').catch(() => {}); this.refresh(); } });
			box.replaceChildren(el('div', { className: 'row' }, el('span', { className: 'spacer' }), stop));
		}
		// One row per LoRA loaded in this session: tick to use it, with its own strength.
		const names = loras.map((l) => l.name);
		if (JSON.stringify(names) !== this.loraSig) {
			this.loraSig = JSON.stringify(names);
			$('img-loras').replaceChildren(...(names.length ? names.map((name, i) => {
				const preferred = names.findIndex((x) => KNOWN_STRENGTHS.some(([re]) => re.test(x)));
				const box = el('input', { type: 'checkbox', checked: i === (preferred === -1 ? 0 : preferred) });
				box.dataset.lora = name;
				box.addEventListener('change', () => this.loraNote());
				return el('label', { className: 'lora-row' }, box, el('span', { textContent: loraLabel(name) }), el('input', { type: 'number', min: 0, max: 2, step: 0.05, value: defaultStrength(name), ariaLabel: `Strength of ${loraLabel(name)}` }));
			}) : [el('div', { className: 'muted small', textContent: session.state === 'off' ? 'Your LoRAs are listed here once a session starts.' : 'No LoRAs were found in the loras/ folder of your Backblaze bucket.' })]));
			this.loraNote();
		}
		// The button always answers a tap; what it can do right now is written on it.
		const making = this.data.generations.some((g) => g.status === 'running');
		$('img-go').disabled = making;
		$('img-go').textContent = making ? 'Making…' : session.state === 'ready' ? 'Generate' : session.state === 'starting' ? 'Generate (starting up…)' : 'Generate';
	},

	chosenLoras() {
		return [...$('img-loras').querySelectorAll('.lora-row')].filter((r) => r.querySelector('input[type=checkbox]').checked)
			.map((r) => ({ name: r.querySelector('input[type=checkbox]').dataset.lora, strength: Number(r.querySelector('input[type=number]').value) || 0.9 })).slice(0, 3);
	},

	triggers() {
		return this.chosenLoras().map((l) => KNOWN_TRIGGERS.find(([re]) => re.test(l.name))?.[1]).filter(Boolean);
	},

	loraNote() {
		const t = this.triggers();
		const many = [...$('img-loras').querySelectorAll('input[type=checkbox]:checked')].length > 3;
		$('img-lora-note').textContent = [many ? 'Only the first three ticked LoRAs are used.' : '', t.length ? `Trigger word "${t.join('", "')}" is added for you. For other LoRAs, type their trigger word yourself.` : ''].filter(Boolean).join(' ');
	},

	async quote(minutes, out) {
		const fail = (m) => out.replaceChildren(el('div', { className: 'sys-alert', textContent: m }));
		out.replaceChildren(el('div', { className: 'muted small', textContent: 'Checking prices…' }));
		let q;
		try { q = await api('POST', '/api/images/quote', { minutes }); } catch (err) { return fail(err.message); }
		if (!q.allowed) return fail(q.reason);
		const go = el('button', { type: 'button', className: 'btn-primary', textContent: `Start for up to ${money(q.estimate)}` });
		go.addEventListener('click', async () => {
			go.disabled = true; go.textContent = 'Starting…';
			try { await api('POST', '/api/images/session', { minutes, confirmEstimate: q.estimate }); this.refresh(); } catch (err) { fail(err.message); }
		});
		out.replaceChildren(el('div', { className: 'row' }, el('span', { className: 'small', textContent: `${q.useMinutes} minutes of use, plus up to ${q.setupMinutes} for setup. ${q.summary}` }), el('span', { className: 'spacer' }), go));
	},

	shape: null,
	setShape(id, src) {
		this.shape = id ? { id } : null;
		$('img-shape-thumb').replaceChildren(...(id ? [el('img', { src, alt: 'Body shape' })] : ['None']));
		$('img-shape-strength-row').hidden = !id;
		this.shapeText();
	},
	shapeText() {
		const v = Number($('img-shape-strength').value);
		$('img-shape-strength-text').textContent = v >= 70 ? ' Tight: shape followed closely, may look stiff' : v >= 30 ? ' Balanced' : ' Loose: more natural, shape only roughly';
	},
	/** Slider 0-100 (right = follow tighter) to the depth add-on's strength. */
	depthStrength() {
		return Math.round((0.55 + Number($('img-shape-strength').value) / 100 * 0.55) * 100) / 100;
	},

	/** Reference pictures per role: { face: [{ id, src }], body: [...], look: [...] }, up to 3 in each box. */
	refCount() { return Object.values(this.refs).reduce((n, list) => n + list.length, 0); },

	addRef(role, id, src) {
		const list = (this.refs[role] ||= []);
		if (list.length >= 3) return false;
		list.push({ id, src });
		this.renderRefs();
		return true;
	},

	/**
	 * The image engine takes one picture per box, so two or three pictures in a box are joined
	 * side by side into one sheet, made here on the phone and uploaded. Returns the upload id.
	 */
	async sheetFor(list) {
		if (list.length === 1) return list[0].id;
		const images = await Promise.all(list.map((r) => new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error('A reference picture could not be read.'));
			img.src = r.src;
		})));
		const h = 768;
		const widths = images.map((img) => Math.round(img.naturalWidth * h / img.naturalHeight));
		const canvas = Object.assign(document.createElement('canvas'), { width: widths.reduce((a, b) => a + b, 0) + 16 * (images.length - 1), height: h });
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = '#fff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		let x = 0;
		images.forEach((img, i) => { ctx.drawImage(img, x, 0, widths[i], h); x += widths[i] + 16; });
		const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
		const up = await uploadWithProgress(new File([blob], 'reference-sheet.jpg', { type: 'image/jpeg' }), () => {});
		return up.id;
	},

	/** Each box shows its pictures, each with ×, and a "+ Add" tile while fewer than 3 are chosen in total. */
	renderRefs() {
		const count = this.refCount();
		for (const box of document.querySelectorAll('.pick.ref')) {
			const { role } = box.dataset;
			const list = this.refs[role] || [];
			const full = list.length >= 3;
			const thumbs = list.map((r, i) => {
				const x = el('button', { type: 'button', className: 'pend-x', ariaLabel: 'Remove this picture' });
				x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
				x.addEventListener('click', () => { list.splice(i, 1); this.renderRefs(); });
				return el('div', { className: 'ref-thumb' }, el('img', { src: r.src, alt: `${role} reference` }), x);
			});
			// The tile is a label for the box's file input: tapping it opens the phone's picker directly.
			const add = full
				? el('div', { className: 'ref-add off' }, el('b', { textContent: '3' }), 'Box full')
				: el('label', { className: 'ref-add', htmlFor: `img-ref-${role}` }, el('b', { textContent: '+' }), list.length ? 'Add another' : 'Add');
			box.querySelector('.pick-body').replaceChildren(...thumbs, add);
			box.classList.toggle('filled', list.length > 0);
		}
		$('img-ref-note').textContent = `${count} of 9 pictures chosen, up to 3 in each box. Tap + to add (you can pick several at once), × to remove. Two or three pictures in a box are joined into one sheet for the image engine. Crop face pictures to the face only, or their clothes leak in. Use made-up characters, or real adults who agreed.`;
	},

	async generate() {
		const out = $('img-out');
		const say = (m) => out.replaceChildren(el('div', { className: 'sys-alert', textContent: m }));
		const state = this.data?.session.state;
		if (state === 'off') {
			say('Start an image session first: scroll to the top of this page, tap Get price, then Start. Your description and pictures here are kept.');
			$('img-state').scrollIntoView({ behavior: 'smooth', block: 'center' });
			return;
		}
		if (state === 'starting') return say('The image engine is still starting up. The top of this page shows which step it is on; Generate works as soon as it says Ready.');
		if (!$('img-prompt').value.trim()) return say('Type what you want a picture of first.');
		out.replaceChildren(el('div', { className: 'muted small', textContent: 'Sending…' }));
		// Boxes with several pictures are sent as one sheet each.
		const refs = {};
		const refCounts = {};
		try {
			for (const [role, list] of Object.entries(this.refs)) {
				if (!list.length) continue;
				if (list.length > 1) out.replaceChildren(el('div', { className: 'muted small', textContent: `Joining the ${role === 'look' ? 'outfit' : role} pictures…` }));
				refs[role] = [await this.sheetFor(list)];
				refCounts[role] = list.length;
			}
		} catch (err) { return say(err.message); }
		const loras = this.chosenLoras();
		// Remember the strengths used, so next time each LoRA starts where you left it.
		localStorage.setItem('loraStrengths', JSON.stringify({ ...savedStrengths(), ...Object.fromEntries(loras.map((l) => [l.name, l.strength])) }));
		try {
			await api('POST', '/api/images/generate', { prompt: $('img-prompt').value.trim(), enhance: $('img-enhance').checked, prefix: this.triggers().join(' '), loras, size: $('img-size').value, quality: $('img-quality').value, count: Number($('img-count').value), refs, refCounts, depth: this.shape?.id || '', depthStrength: this.depthStrength() });
			out.replaceChildren();
			this.refresh();
		} catch (err) { out.replaceChildren(el('div', { className: 'sys-alert', textContent: err.message })); }
	},

	renderGallery() {
		$('img-gallery').replaceChildren(...this.data.generations.map((g) => {
			const card = el('div', { className: 'card gen' });
			if (g.params.asked && g.params.asked !== g.prompt) card.append(el('div', { className: 'small', style: 'margin-bottom:4px', textContent: `You asked: ${g.params.asked}` }));
			card.append(el('div', { className: 'gen-prompt', textContent: g.prompt }));
			if (g.params.note) card.append(el('div', { className: 'approval-note', style: 'padding:0 0 8px', textContent: g.params.note }));
			if (g.status === 'running') {
				card.append(el('div', { className: 'brain-state starting', textContent: `Making ${g.params.count} picture${g.params.count > 1 ? 's' : ''}${g.params.quality === 'max' ? ' at max quality' : ''}… ${g.params.quality === 'max' ? 'this can take a few minutes' : 'usually under a minute'}.` }));
				const live = el('div', { className: 'gen-live' }, el('div', { className: 'bar' }, el('div', { style: 'width:4%' })), el('div', { className: 'boot-meta' }));
				live.dataset.id = g.id;
				card.append(live);
			}
			if (g.status === 'failed') card.append(el('p', { className: 'sys-alert', textContent: g.detail }));
			if (g.images.length) card.append(el('div', { className: 'shots' }, ...g.images.map((id) => {
				const src = `/api/uploads/${id}`;
				const useAs = (role, label) => {
					const btn = el('button', { type: 'button', textContent: label });
					btn.addEventListener('click', () => {
						if (!this.addRef(role, id, src)) return alert('That box already has 3 pictures. Remove one first.');
						$('img-form').scrollIntoView({ behavior: 'smooth' });
					});
					return btn;
				};
				const toVideo = el('button', { type: 'button', textContent: 'Use in Video' });
				toVideo.addEventListener('click', () => { openPage('video', { sub: true }); video.usePicture(id, src); });
				const open = el('button', { type: 'button', className: 'shot-open', ariaLabel: 'Open picture' }, el('img', { src, loading: 'lazy', alt: 'Generated picture' }));
				open.addEventListener('click', () => photoViewer.open(this.data.generations.flatMap((x) => x.images.map((i) => `/api/uploads/${i}`)), src));
				return el('div', { className: 'shot' }, open,
					el('div', { className: 'shot-actions' }, el('a', { href: src, download: '', textContent: 'Save' }), useAs('face', 'Use as face'), useAs('body', 'Use as body'), useAs('look', 'Use as outfit'), toVideo));
			})));
			if (g.status !== 'running') {
				const del = el('button', { type: 'button', className: 'link', textContent: 'Delete' });
				del.addEventListener('click', async () => { if (confirm('Delete these pictures from the phone?')) { await api('DELETE', `/api/images/${g.id}`).catch(() => {}); this.sig = ''; this.refresh(); } });
				const again = el('button', { type: 'button', className: 'link', textContent: 'Reuse description' });
				again.addEventListener('click', () => { $('img-prompt').value = g.params.asked || g.prompt; $('img-form').scrollIntoView({ behavior: 'smooth' }); });
				card.append(el('div', { className: 'row small', style: 'margin-top:10px' }, again, el('span', { className: 'spacer' }), del));
			}
			return card;
		}));
	}
};

$('img-form').addEventListener('submit', (e) => { e.preventDefault(); chars.generate(); });
$('img-shape-open').addEventListener('click', () => openPage('body', { sub: true }));
/** Quality: remembered between visits; max quality makes at most 2 pictures per request. */
function qualityChanged() {
	const max = $('img-quality').value === 'max';
	localStorage.setItem('imgQuality', $('img-quality').value);
	$('img-count').max = max ? '2' : '4';
	// Max 2K is heavy: start at one picture each time it is chosen (two stays possible).
	if (max && (Number($('img-count').value) > 2 || qualityChanged.last !== 'max')) $('img-count').value = '1';
	qualityChanged.last = $('img-quality').value;
	const sizes = max ? { portrait: '1664 × 2496', square: '2048 × 2048', landscape: '2496 × 1664' } : { portrait: '1024 × 1536', square: '1024 × 1024', landscape: '1536 × 1024' };
	$('img-quality-note').textContent = `${sizes[$('img-size').value] || sizes.portrait} pixels.${max ? ' The model\'s largest size; each picture takes longer.' : ''}`;
}
$('img-quality').value = localStorage.getItem('imgQuality') === 'max' ? 'max' : 'standard';
$('img-quality').addEventListener('change', qualityChanged);
$('img-size').addEventListener('change', qualityChanged);
$('img-count').addEventListener('change', () => { const n = Math.min(Number($('img-count').max), Math.max(1, Math.round(Number($('img-count').value) || 1))); $('img-count').value = String(n); });
qualityChanged();
$('img-shape-clear').addEventListener('click', () => chars.setShape(null));
$('img-shape-strength').addEventListener('input', () => chars.shapeText());
chars.renderRefs();
for (const input of document.querySelectorAll('.ref-input')) {
	input.addEventListener('change', async (e) => {
		const { role } = input.dataset;
		const files = [...e.target.files].slice(0, 3 - (chars.refs[role] || []).length);
		e.target.value = '';
		const note = $('img-out');
		for (const file of files) {
			note.replaceChildren(el('div', { className: 'muted small', textContent: `Uploading ${file.name}…` }));
			try { const up = await uploadWithProgress(file, () => {}); chars.addRef(role, up.id, URL.createObjectURL(file)); }
			catch (err) { note.replaceChildren(el('div', { className: 'sys-alert', textContent: err.message })); return; }
		}
		note.replaceChildren();
	});
}
// Labels acting as buttons should also answer the keyboard.
for (const label of document.querySelectorAll('label[role="button"]')) {
	label.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); label.click(); } });
}

/* ---------- Motion capture ---------- */

const MC_COLOURS = ['#8b7cf6', '#f6a35b', '#5bd0f6', '#81c995', '#f66b8b', '#f6e35b'];
const MC_STEPS = [['preparing', 'Passing your clip to the GPU'], ['starting', 'Starting the GPU'], ['loading', 'Setting up and downloading models'], ['tracking', 'Tracking the people and measuring their bodies'], ['checking', 'Checking the results'], ['saving', 'Bringing the joint data back']];
const mmss = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

/**
 * The owner's clip is shown here, on the phone, only so they can mark who is who; nothing of it
 * is shown anywhere else. The GPU gets their marks as points relative to the frame.
 */
const mocap = {
	timer: 0, clip: null, people: [], sel: 0, mode: 1, jobs: [], limits: null, dismissed: new Set(),

	show() { this.refresh(); this.timer = setInterval(() => this.refresh(), 3000); if (!this.people.length) this.resetPeople(); },
	hide() { clearInterval(this.timer); $('mc-video').pause(); },

	resetPeople() { this.people = [{ name: 'Person A', marks: [] }, { name: 'Person B', marks: [] }]; this.sel = 0; this.renderPeople(); },

	async refresh() {
		let data;
		try { data = await api('GET', '/api/mocap'); } catch { return; }
		if (nav.page !== 'mocap') return;
		this.jobs = data.jobs;
		this.limits = data.limits;
		this.render();
	},

	render() {
		const active = this.jobs.find((j) => j.active);
		$('mc-active').replaceChildren(...(active ? [this.activeCard(active)] : []));
		const latest = this.jobs.find((j) => !j.active && !this.dismissed.has(j.id) && Date.now() - j.ended_at < 3600 * 1000);
		$('mc-result').replaceChildren(...(!active && latest ? [this.resultCard(latest)] : []));
		$('mc-form').hidden = Boolean(active);
		const past = this.jobs.filter((j) => !j.active);
		$('mc-history').replaceChildren(...(past.length ? past.map((j) => {
			const when = new Date(j.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
			const right = j.result ? el('a', { href: `/api/uploads/${j.result}`, download: '', textContent: 'Joint data' }) : el('span', { className: 'muted', textContent: j.status === 'cancelled' ? 'Cancelled' : 'Failed' });
			const what = j.status === 'done' ? (j.qc?.verdict || '') : j.status === 'failed' ? j.detail : '';
			return el('div', { className: 'hist' }, el('span', {}, when, el('span', { className: 'muted', textContent: ` · ${j.params.seconds} s · ${(j.params.people || []).length || 'auto'} ${(j.params.people || []).length === 1 ? 'person' : 'people'}${what ? ` · ${what}` : ''}` })), right);
		}) : [el('div', { className: 'muted', textContent: 'Nothing yet.' })]));
		const l = this.limits;
		$('mc-note').textContent = !l ? '' : !l.b2 ? 'Backblaze is needed (System page).' : !l.hfToken ? 'Add a Hugging Face token on the System page.' : this.clip?.meta ? `${this.clip.meta.seconds.toFixed(1)} s clip` : `Clips up to ${l.maxSeconds} s.`;
	},

	activeCard(job) {
		const at = MC_STEPS.findIndex(([s]) => s === job.status);
		const stop = el('button', { type: 'button', className: 'btn-danger', textContent: 'Cancel' });
		stop.addEventListener('click', async () => {
			if (!confirm('Cancel this motion capture? The GPU is shut down and time already used is still charged.')) return;
			stop.disabled = true;
			await api('POST', `/api/mocap/jobs/${job.id}/cancel`).catch(() => {});
			this.refresh();
		});
		return el('div', { className: 'card' },
			el('div', { className: 'card-cap', textContent: 'Working on your motion capture' }),
			el('ul', { className: 'steps' }, ...MC_STEPS.map(([, label], i) => {
				const text = el('span', {}, label);
				if (i === at && job.detail && job.detail !== label) text.append(' ', el('small', { textContent: `· ${job.detail}` }));
				return el('li', { className: i < at ? 'done' : i === at ? 'now' : '' }, text);
			})),
			el('div', { className: 'row' },
				el('span', { className: 'muted small', textContent: `${job.params.run === 'until-done' ? 'Runs until done' : `GPU time left: ${job.gpuSecondsLeft == null ? `up to ${job.params.minutes} min` : clock(job.gpuSecondsLeft)}`}, at most ${money(job.params.estimate)}. You can leave this page.` }),
				el('span', { className: 'spacer' }), stop));
	},

	/** The result in numbers only: the quality report and the joint data to download. */
	resultCard(job) {
		const dismiss = el('button', { type: 'button', className: 'btn-ghost', textContent: 'Make another' });
		dismiss.addEventListener('click', () => { this.dismissed.add(job.id); this.render(); });
		if (job.status !== 'done') {
			return el('div', { className: 'card' }, el('div', { className: 'card-cap', textContent: job.status === 'cancelled' ? 'Cancelled' : 'That did not work' }),
				el('p', { className: 'sys-alert', textContent: job.detail }), el('p', { className: 'muted small', textContent: 'The GPU has been shut down.' }), el('div', { className: 'row' }, el('span', { className: 'spacer' }), dismiss));
		}
		const qc = job.qc || {};
		const lines = [qc.verdict || 'No quality report.', `${qc.frames ?? '?'} frames at ${qc.fps ?? '?'} fps`];
		for (const [pid, r] of Object.entries(qc.people || {})) {
			const name = (job.params.people || [])[Number(pid) - 1] || `Person ${pid}`;
			lines.push(`${name}: in ${r.frames_present} frames, missing ${r.frames_missing}${r.jitter_median_cm != null ? `, jitter ${r.jitter_median_cm} cm` : ''}${r.jumps_over_15cm != null ? `, jumps ${r.jumps_over_15cm}` : ''}${r.bone_length_drift_pct_median != null ? `, bone drift ${r.bone_length_drift_pct_median}%` : ''}`);
		}
		if (qc.swaps?.length) lines.push(`Possible identity swaps at frames ${qc.swaps.slice(0, 10).map((x) => x.frame).join(', ')}${qc.swaps.length > 10 ? '…' : ''}`);
		return el('div', { className: 'card' },
			el('div', { className: 'card-cap', textContent: 'Motion capture done' }),
			el('div', { className: 'mc-qc', textContent: lines.join('\n') }),
			job.params.b2Path ? el('p', { className: 'muted small', textContent: `Also saved in Backblaze: ${job.params.b2Path}` }) : el('span'),
			el('div', { className: 'row' }, dismiss, el('span', { className: 'spacer' }), el('a', { className: 'btn-primary', href: `/api/uploads/${job.result}`, download: '', textContent: 'Download joint data' })));
	},

	async choose(file) {
		const slot = $('mc-video-slot');
		const button = slot.parentElement;
		$('mc-quote-out').replaceChildren();
		const item = { file, id: null, meta: await video.metadata(file), url: URL.createObjectURL(file) };
		if (!item.meta || !(item.meta.seconds > 0)) { slot.textContent = 'That video could not be read. Try another.'; return; }
		this.clip = item;
		this.resetPeople();
		const status = el('span', { className: 'pick-cap pick-status', textContent: 'Uploading 0%' });
		slot.textContent = file.name;
		button.classList.add('filled');
		button.querySelector('.pick-status')?.remove();
		button.append(status);
		const v = $('mc-video');
		v.src = item.url;
		$('mc-scrub').max = String(item.meta.seconds);
		$('mc-start').value = '0';
		$('mc-length').value = String(Math.min(5, Math.round(item.meta.seconds * 10) / 10));
		this.rangeNote();
		$('mc-scrub').value = '0';
		$('mc-marker').hidden = false;
		this.render();
		try {
			const up = await uploadWithProgress(file, (pct) => { status.textContent = `Uploading ${pct}%`; });
			if (this.clip !== item) return;
			item.id = up.id;
			status.textContent = `${item.meta.seconds.toFixed(1)} s · ${item.meta.width}×${item.meta.height}`;
		} catch (err) { if (this.clip === item) status.textContent = err.message; }
	},

	/** Where the picture sits inside the video element (it is letterboxed to fit). */
	contentBox() {
		const v = $('mc-video');
		const w = v.clientWidth, h = v.clientHeight, vw = v.videoWidth || 1, vh = v.videoHeight || 1;
		const k = Math.min(w / vw, h / vh);
		return { x: (w - vw * k) / 2, y: (h - vh * k) / 2, w: vw * k, h: vh * k };
	},

	/** Marks within this many seconds of the shown moment count as on it (seeking is not frame-exact). */
	near: 0.06,
	markAt(t) { return this.people[this.sel].marks.find((m) => Math.abs(m.t - t) < this.near); },

	tap(e) {
		if (!this.clip) return;
		const c = $('mc-overlay').getBoundingClientRect();
		const b = this.contentBox();
		const x = (e.clientX - c.left - b.x) / b.w, y = (e.clientY - c.top - b.y) / b.h;
		if (x < 0 || x > 1 || y < 0 || y > 1) return;
		const t = Math.round($('mc-video').currentTime * 100) / 100;
		let mark = this.markAt(t);
		if (!mark) { mark = { t, points: [] }; this.people[this.sel].marks.push(mark); }
		mark.points.push([Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000, this.mode]);
		$('mc-auto').checked = false;
		$('mc-auto-warn').hidden = true;
		this.renderPeople();
		this.rangeNote();
	},

	draw() {
		const cv = $('mc-overlay');
		const v = $('mc-video');
		cv.width = v.clientWidth * devicePixelRatio;
		cv.height = v.clientHeight * devicePixelRatio;
		const g = cv.getContext('2d');
		g.scale(devicePixelRatio, devicePixelRatio);
		const b = this.contentBox();
		const t = v.currentTime;
		this.people.forEach((p, i) => {
			for (const m of p.marks.filter((mm) => Math.abs(mm.t - t) < this.near)) {
				for (const [x, y, l] of m.points) {
					const px = b.x + x * b.w, py = b.y + y * b.h;
					g.lineWidth = 3;
					g.strokeStyle = '#000';
					g.fillStyle = MC_COLOURS[i % MC_COLOURS.length];
					if (l) { g.beginPath(); g.arc(px, py, 9, 0, Math.PI * 2); g.fill(); g.stroke(); }
					else { g.strokeStyle = MC_COLOURS[i % MC_COLOURS.length]; g.lineWidth = 4; g.beginPath(); g.moveTo(px - 8, py - 8); g.lineTo(px + 8, py + 8); g.moveTo(px + 8, py - 8); g.lineTo(px - 8, py + 8); g.stroke(); }
				}
			}
		});
		$('mc-time').textContent = mmss(t);
	},

	renderPeople() {
		$('mc-people').replaceChildren(...this.people.map((p, i) => {
			const b = el('button', { type: 'button', textContent: p.name });
			b.style.borderColor = MC_COLOURS[i % MC_COLOURS.length];
			if (i === this.sel) { b.classList.add('on'); b.style.background = MC_COLOURS[i % MC_COLOURS.length]; }
			b.addEventListener('click', () => { this.sel = i; this.renderPeople(); });
			return b;
		}), (() => {
			const add = el('button', { type: 'button', textContent: '+ Person' });
			add.addEventListener('click', () => { if (this.people.length >= 6) return; this.people.push({ name: `Person ${String.fromCharCode(65 + this.people.length)}`, marks: [] }); this.sel = this.people.length - 1; this.renderPeople(); });
			return add;
		})());
		$('mc-marks').replaceChildren(...this.people.map((p, i) => {
			const marks = p.marks.filter((m) => m.points.length);
			return el('div', { textContent: `${p.name}: ${marks.length ? marks.map((m) => `${m.points.filter((x) => x[2]).length} tap${m.points.filter((x) => x[2]).length === 1 ? '' : 's'}${m.points.some((x) => !x[2]) ? ` + ${m.points.filter((x) => !x[2]).length} not` : ''} at ${mmss(m.t)}`).join('; ') : 'not marked yet'}`, style: `color:${MC_COLOURS[i % MC_COLOURS.length]}` });
		}));
		for (const b of $('mc-mode').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.mode) === this.mode);
		$('mc-quote-out').replaceChildren();
		this.draw();
	},

	undo() {
		const p = this.people[this.sel];
		const m = p.marks.at(-1);
		if (!m) return;
		m.points.pop();
		if (!m.points.length) p.marks.pop();
		this.renderPeople();
	},

	/** Say which part of the clip will be used, and whether the marks fall inside it. */
	rangeNote() {
		if (!this.clip?.meta) return;
		const full = this.clip.meta.seconds;
		const start = Math.min(full, Math.max(0, Number($('mc-start').value) || 0));
		const len = Math.min(full - start, Math.max(0, Number($('mc-length').value) || 0));
		const marks = this.people.flatMap((p) => p.marks.filter((m) => m.points.some((x) => x[2])));
		const outside = marks.filter((m) => m.t < start - 0.05 || m.t > start + len).length;
		$('mc-range-note').textContent = `Using ${mmss(start)} to ${mmss(start + len)} (${len.toFixed(1)} s of ${full.toFixed(1)} s).${outside ? ` ${outside} of your marks are outside this part and will not be used.` : ''} Time and cost grow with length.`;
		$('mc-quote-out').replaceChildren();
	},

	request() {
		return {
			input: this.clip.id, seconds: this.clip.meta.seconds, start: Number($('mc-start').value) || 0, length: Number($('mc-length').value) || this.clip.meta.seconds, automatic: $('mc-auto').checked, runMinutes: $('mc-run').value,
			people: $('mc-auto').checked ? [] : this.people.filter((p) => p.marks.some((m) => m.points.some((x) => x[2]))).map((p) => ({ name: p.name, marks: p.marks }))
		};
	},

	async quote() {
		const out = $('mc-quote-out');
		const fail = (message) => out.replaceChildren(el('div', { className: 'sys-alert', textContent: message }));
		if (!this.clip) return fail('Choose a video first.');
		if (!this.clip.id) return fail('Your clip is still uploading.');
		if (!$('mc-rights').checked) return fail('Tick the box to confirm you may use this footage.');
		out.replaceChildren(el('div', { className: 'muted small', textContent: 'Checking prices…' }));
		let q;
		try { q = await api('POST', '/api/mocap/quote', this.request()); } catch (err) { return fail(err.message); }
		if (!q.allowed) return fail(q.reason);
		const go = el('button', { type: 'button', className: 'btn-primary', textContent: `Process for up to ${money(q.estimate)}` });
		go.addEventListener('click', async () => {
			go.disabled = true;
			go.textContent = 'Starting…';
			try {
				await api('POST', '/api/mocap/jobs', { ...this.request(), rightsConfirmed: true, confirmEstimate: q.estimate });
				out.replaceChildren();
				this.refresh();
			} catch (err) { fail(err.message); go.disabled = false; go.textContent = `Process for up to ${money(q.estimate)}`; }
		});
		const who = this.request().people;
		const warn = q.warning ? [el('div', { className: 'sys-alert', style: 'margin-top:8px', textContent: q.warning })] : [];
		out.replaceChildren(
			...warn,
			el('div', { className: 'small', textContent: `${q.seconds.toFixed(1)} s of the clip, ${who.length ? `${who.length} ${who.length === 1 ? 'person' : 'people'} marked` : 'people found automatically'}. Estimated about ${q.needed} minutes on a 48 GB GPU${q.run === 'until-done' ? '; it runs until done' : `, reserved for up to ${q.minutes} minutes`}. ${q.summary}` }),
			el('div', { className: 'row', style: 'margin-top:10px' }, el('span', { className: 'muted small', textContent: 'You pay only for the minutes used.' }), el('span', { className: 'spacer' }), go));
	}
};
$('mc-video-input').addEventListener('change', (e) => { if (e.target.files[0]) mocap.choose(e.target.files[0]); e.target.value = ''; });
$('mc-scrub').addEventListener('input', () => { $('mc-video').currentTime = Number($('mc-scrub').value); });
$('mc-video').addEventListener('seeked', () => mocap.draw());
$('mc-video').addEventListener('loadeddata', () => { $('mc-video').currentTime = 0; mocap.draw(); });
$('mc-overlay').addEventListener('pointerup', (e) => mocap.tap(e));
$('mc-undo').addEventListener('click', () => mocap.undo());
for (const id of ['mc-start', 'mc-length']) $(id).addEventListener('input', () => mocap.rangeNote());
$('mc-here').addEventListener('click', () => { $('mc-start').value = String(Math.round($('mc-video').currentTime * 10) / 10); mocap.rangeNote(); });
$('mc-whole').addEventListener('click', () => { if (!mocap.clip?.meta) return; $('mc-start').value = '0'; $('mc-length').value = String(Math.round(mocap.clip.meta.seconds * 10) / 10); mocap.rangeNote(); });
$('mc-auto').addEventListener('change', () => { $('mc-auto-warn').hidden = !$('mc-auto').checked; $('mc-quote-out').replaceChildren(); });
for (const b of $('mc-mode').querySelectorAll('button')) b.addEventListener('click', () => { mocap.mode = Number(b.dataset.mode); mocap.renderPeople(); });
$('mc-form').addEventListener('submit', (e) => { e.preventDefault(); mocap.quote(); });
new ResizeObserver(() => mocap.draw()).observe($('mc-video'));

/* ---------- Picture viewer ---------- */

/**
 * Pictures open full screen inside the app, as a dialog: Back (button or gesture) closes it and
 * returns to the results. (Opening them as links handed them to the browser, and Back then left
 * the app.) Tap zooms in and out; swipe or the arrows go through the other pictures.
 */
const photoViewer = {
	list: [], index: 0,
	open(list, src) {
		this.list = list.length ? list : [src];
		this.index = Math.max(0, this.list.indexOf(src));
		this.show();
		openDialog($('photo'));
	},
	show() {
		const src = this.list[this.index];
		$('photo-stage').classList.remove('zoomed');
		$('photo-img').src = src;
		$('photo-save').href = src;
		$('photo-count').textContent = this.list.length > 1 ? `${this.index + 1} of ${this.list.length}` : '';
		$('photo-prev').hidden = this.index === 0;
		$('photo-next').hidden = this.index >= this.list.length - 1;
	},
	step(d) {
		const i = this.index + d;
		if (i < 0 || i >= this.list.length) return;
		this.index = i;
		this.show();
	}
};
$('photo-close').addEventListener('click', () => $('photo').close());
$('photo-prev').addEventListener('click', () => photoViewer.step(-1));
$('photo-next').addEventListener('click', () => photoViewer.step(1));
{
	const stage = $('photo-stage');
	let start = null;
	stage.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY, t: Date.now() }; });
	stage.addEventListener('pointercancel', () => { start = null; });
	stage.addEventListener('pointerup', (e) => {
		if (!start) return;
		const dx = e.clientX - start.x, dy = e.clientY - start.y;
		const zoomed = stage.classList.contains('zoomed');
		if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
			// A tap: zoom in around the tapped spot, or back out.
			const img = $('photo-img');
			const r = img.getBoundingClientRect();
			const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
			stage.classList.toggle('zoomed');
			if (!zoomed) { stage.scrollLeft = fx * img.offsetWidth - stage.clientWidth / 2; stage.scrollTop = fy * img.offsetHeight - stage.clientHeight / 2; }
		} else if (!zoomed && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) photoViewer.step(dx < 0 ? 1 : -1);
		start = null;
	});
}

/* ---------- Body editor ---------- */

/**
 * A horizontal slider that does not get in the way of scrolling. On a phone, Chrome moves a
 * slider to wherever a finger lands, so scrolling past a list of them changes them by accident.
 * Here a finger has to move sideways first to drag (the thumb then moves with the finger, from
 * where it was); an upward or downward swipe scrolls the page and leaves the slider alone; a
 * plain tap still sets the value at that spot.
 */
function scrollFriendlySlider(track, input) {
	let start = null;
	const set = (v) => {
		const min = Number(input.min), max = Number(input.max);
		input.value = String(Math.min(max, Math.max(min, v)));
		input.dispatchEvent(new Event('input', { bubbles: true }));
	};
	const range = () => Number(input.max) - Number(input.min);
	track.addEventListener('pointerdown', (e) => {
		if (e.button > 0) return;
		start = { x: e.clientX, y: e.clientY, v: Number(input.value), drag: e.pointerType === 'mouse', id: e.pointerId };
		if (start.drag) { track.setPointerCapture(e.pointerId); set(Number(input.min) + ((e.clientX - track.getBoundingClientRect().left) / track.clientWidth) * range()); start.v = Number(input.value); }
	});
	track.addEventListener('pointermove', (e) => {
		if (!start || e.pointerId !== start.id) return;
		const dx = e.clientX - start.x, dy = e.clientY - start.y;
		if (!start.drag) {
			if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) { start = null; return; } // scrolling
			if (Math.abs(dx) <= 6) return;
			start.drag = true;
			start.x = e.clientX; // no jump: the thumb moves from where it was
			track.setPointerCapture(e.pointerId);
			return;
		}
		set(start.v + (dx / track.clientWidth) * range());
	});
	track.addEventListener('pointerup', (e) => {
		if (start && !start.drag && e.pointerId === start.id) set(Number(input.min) + ((e.clientX - track.getBoundingClientRect().left) / track.clientWidth) * range());
		start = null;
	});
	track.addEventListener('pointercancel', () => { start = null; });
}

const bodyEditor = {
	viewer: null, values: null, module: null,

	async show() {
		// The 3D library is about 2 MB, so it loads only when the editor is first opened.
		if (!this.module) {
			try { this.module = await import('./body.js'); }
			catch (err) { $('body-view').textContent = `The 3D view could not start: ${err.message}`; return; }
			this.viewer = this.module.createViewer($('body-view'));
			let current = null;
			try { current = JSON.parse(localStorage.getItem('bodyCurrent') || 'null'); } catch { current = null; }
			this.values = this.module.migrate(current || this.module.defaults('female'));
			this.build();
		}
		this.refresh();
	},

	/** Saved bodies; anything damaged in storage is skipped rather than breaking the editor. */
	saved() {
		try {
			const list = JSON.parse(localStorage.getItem('bodyTemplates') || '[]');
			return Array.isArray(list) ? list.filter((t) => t && typeof t.name === 'string' && t.values && typeof t.values === 'object') : [];
		} catch { return []; }
	},

	/** Draw the controls once; refresh() keeps them in step with the values. */
	build() {
		const m = this.module;
		const label = (sl, v) => sl.unit ? `${Math.round(v)} ${sl.unit}` : `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
		const slider = (sl) => {
			const input = el('input', { type: 'range', min: sl.min, max: sl.max, step: sl.step, ariaLabel: sl.label });
			const out = el('span');
			input.dataset.key = sl.key;
			input.addEventListener('input', () => { this.values[sl.key] = Number(input.value); out.textContent = label(sl, this.values[sl.key]); this.changed(); });
			return { input, out, sl };
		};
		this.controls = [];
		$('body-vsliders').replaceChildren(...m.SLIDERS.filter((x) => x.vertical).map((sl) => {
			const c = slider(sl); this.controls.push(c);
			return el('div', { className: 'vslider' }, c.out, c.input, el('b', { textContent: sl.label }));
		}));
		for (const [group] of m.GROUPS.filter(([g]) => g !== 'lengths')) $(`body-group-${group}`).replaceChildren(...m.SLIDERS.filter((x) => !x.vertical && x.group === group).map((sl) => {
			const c = slider(sl); this.controls.push(c);
			const track = el('div', { className: 'hs-track' }, c.input);
			scrollFriendlySlider(track, c.input);
			return el('div', { className: 'hslider' }, el('b', { textContent: sl.label }), track, c.out);
		}));
		// Tabs, as in a character creator: the figure stays in view while you switch groups.
		const tab = (name) => {
			for (const b of $('body-tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === name);
			for (const p of document.querySelectorAll('#body .creator-pane')) p.hidden = p.dataset.pane !== name;
			$('body-scroll').scrollTop = 0;
			localStorage.setItem('bodyTab', name);
		};
		for (const b of $('body-tabs').querySelectorAll('button')) b.addEventListener('click', () => tab(b.dataset.tab));
		const saved = localStorage.getItem('bodyTab');
		tab($('body-tabs').querySelector(`[data-tab="${saved}"]`) ? saved : 'shape');
		// Breast and butt types set the detail sliders for that area in one tap.
		for (const [kind, types] of [['breast', m.BREAST_TYPES], ['butt', m.BUTT_TYPES]]) {
			$(`body-${kind}-types`).replaceChildren(...Object.keys(types).map((name) => {
				const b = el('button', { type: 'button', textContent: name });
				b.addEventListener('click', () => { this.values = m.applyType(this.values, kind, name); this.changed(true); });
				return b;
			}));
		}
		this.labelOf = label;
		for (const button of $('body-base').querySelectorAll('button')) button.addEventListener('click', () => { this.values = m.defaults(button.dataset.base); this.changed(true); });
		$('body-reset').addEventListener('click', () => { this.values = m.defaults(this.values.base); this.changed(true); });
		$('body-heads').replaceChildren(...Object.keys(m.HEAD_SHAPES).map((shape) => {
			const b = el('button', { type: 'button', textContent: shape[0].toUpperCase() + shape.slice(1) });
			b.dataset.shape = shape;
			b.addEventListener('click', () => { this.values.headShape = shape; this.changed(true); });
			return b;
		}));
		for (const b of document.querySelectorAll('.body-views button')) b.addEventListener('click', () => this.viewer.setView(Number(b.dataset.angle)));
		$('body-save').addEventListener('click', () => {
			const name = $('body-name').value.trim() || `Body ${this.saved().length + 1}`;
			localStorage.setItem('bodyTemplates', JSON.stringify([...this.saved().filter((t) => t.name !== name), { name, values: { ...this.values } }]));
			$('body-name').value = '';
			this.refresh();
		});
		$('body-use').addEventListener('click', () => this.use());
	},

	changed(redraw = false) {
		localStorage.setItem('bodyCurrent', JSON.stringify(this.values));
		this.viewer.update(this.values);
		if (redraw) this.refresh();
	},

	refresh() {
		const m = this.module;
		if (!m) return;
		for (const c of this.controls) { c.input.value = this.values[c.sl.key]; c.out.textContent = this.labelOf(c.sl, this.values[c.sl.key]); }
		for (const b of $('body-base').querySelectorAll('button')) b.classList.toggle('on', b.dataset.base === this.values.base);
		for (const b of $('body-heads').querySelectorAll('button')) b.classList.toggle('on', b.dataset.shape === this.values.headShape);
		$('body-presets').replaceChildren(...Object.entries(m.PRESETS[this.values.base]).map(([name, preset]) => {
			const b = el('button', { type: 'button', textContent: name });
			b.addEventListener('click', () => { this.values = { ...m.defaults(this.values.base), headShape: this.values.headShape, ...preset }; this.changed(true); });
			return b;
		}));
		const saved = this.saved();
		$('body-saved').replaceChildren(...(saved.length ? saved.map((t) => {
			const b = el('button', { type: 'button', textContent: t.name });
			b.addEventListener('click', () => { this.values = m.migrate(t.values); this.changed(true); });
			const x = el('button', { type: 'button', className: 'chip-x', textContent: '×', ariaLabel: `Delete ${t.name}` });
			x.addEventListener('click', () => { if (confirm(`Delete "${t.name}"?`)) { localStorage.setItem('bodyTemplates', JSON.stringify(this.saved().filter((s) => s.name !== t.name))); this.refresh(); } });
			return el('span', { className: 'saved-chip' }, b, x);
		}) : [el('span', { className: 'muted small', textContent: 'Saved bodies appear here.' })]));
		this.viewer.update(this.values);
	},

	/** Render the body at the picture's size and hand it to the Characters page as a shape guide. */
	async use() {
		const button = $('body-use');
		button.disabled = true;
		button.textContent = 'Preparing…';
		try {
			const [w, h] = { portrait: [1024, 1536], square: [1024, 1024], landscape: [1536, 1024] }[$('img-size').value] || [1024, 1536];
			// The depth map is what the image engine follows; the shaded view is only the thumbnail.
			const depth = await this.viewer.snapshot(w, h, 0, 'depth');
			const preview = await this.viewer.snapshot(w, h, 0, 'shape');
			const up = await uploadWithProgress(new File([depth], 'body-depth.png', { type: 'image/png' }), () => {});
			chars.setShape(up.id, URL.createObjectURL(preview));
			if (nav.stack.at(-1) === 'characters') goBack(); else openPage('characters');
		} catch (err) { alert(`The body could not be prepared: ${err.message}`); }
		finally { button.disabled = false; button.textContent = 'Use this body for pictures'; }
	}
};

/* ---------- Model picker ---------- */

const picker = { dialog: $('models'), body: $('models-body'), name: $('model-name'), dot: $('model-dot'), data: null, timer: 0 };
const NOT_CHAT_MODELS = /whisper|tts|guard|embed|rerank|moderation|orpheus|playai/i;

/** Refresh the chip in the message box: which model answers the next message. */
async function refreshChip() {
	let b;
	try { b = picker.data = await api('GET', '/api/brains'); } catch { return; }
	clearTimeout(picker.timer);
	const waking = b.chatBrain === 'private' && b.private.state === 'starting';
	$('model-tag').hidden = !((b.using === 'private' || waking) && b.private.uncensored);
	if (b.using === 'private') {
		picker.name.textContent = `${b.private.label} · private`;
		picker.dot.className = 'dot private';
	} else if (waking) {
		const eta = el('span');
		if (b.private.progress) { eta.dataset.etaUntil = String(Date.now() + b.private.progress.etaSeconds * 1000); eta.textContent = etaText(Number(eta.dataset.etaUntil)); }
		picker.name.replaceChildren(`Turning on ${b.private.label} · `, sinceNode(b.private.startedAt || Date.now()), ...(b.private.progress ? [' · ', eta] : []));
		picker.dot.className = 'dot waking';
	} else {
		picker.name.textContent = b.everyday.model || (b.everyday.hasKey ? 'Everyday model' : 'Choose a model');
		picker.dot.className = `dot${b.everyday.hasKey ? ' free' : ''}`;
	}
	// While a brain is waking or awake, keep the chip honest without the user doing anything.
	if (b.private.state !== 'off') picker.timer = setTimeout(async () => { await refreshChip(); if (picker.dialog.open && !picker.busy) renderPicker(); }, b.private.state === 'starting' ? 8000 : 30000);
}

function option({ title, tag, note, side, on, disabled, onClick }) {
	const btn = el('button', { type: 'button', className: `opt${on ? ' on' : ''}`, disabled: Boolean(disabled) },
		el('div', { className: 'opt-main' }, el('div', { className: 'opt-title' }, title, ...(tag ? [el('span', { className: 'tag', textContent: tag })] : [])), ...(note ? [el('div', { className: 'opt-note', textContent: note })] : [])),
		el('div', { className: 'opt-side', textContent: side || '' }));
	if (onClick) btn.addEventListener('click', onClick);
	return btn;
}

const choose = async (patch, close = true) => {
	await api('PUT', '/api/settings', patch);
	await refreshChip();
	if (close) picker.dialog.close(); else renderPicker();
};

async function renderPicker() {
	const b = picker.data;
	if (!b) return;
	const nodes = [];

	// Everyday models: free, always available, served by the endpoint in Settings.
	nodes.push(el('div', { className: 'sect', textContent: `Everyday · free${b.everyday.host ? ` · ${b.everyday.host}` : ''}` }));
	if (!b.everyday.hasKey) {
		nodes.push(option({ title: 'Add an API key', note: 'Paste your key in Settings to use everyday models.', side: 'Settings', onClick: () => { picker.dialog.close(); $('open-settings').click(); } }));
	} else {
		const list = el('div', {}, el('div', { className: 'sect-note', textContent: 'Loading models…' }));
		nodes.push(list);
		api('GET', '/api/models').then(({ models }) => {
			const usable = models.filter((m) => !NOT_CHAT_MODELS.test(m)).sort();
			if (b.everyday.model && !usable.includes(b.everyday.model)) usable.unshift(b.everyday.model);
			list.replaceChildren(...usable.map((m) => {
				const on = b.using === 'everyday' && m === b.everyday.model;
				return option({ title: m, side: on ? 'In use' : '', on, onClick: () => choose({ model: m, chatBrain: 'everyday' }) });
			}));
		}).catch((err) => list.replaceChildren(el('div', { className: 'sect-note', textContent: err.message })));
	}

	// Private brain: a model on a rented GPU, with an on/off switch. Costs money while on.
	const p = b.private;
	const stages = { downloading: `Step 1 of 2: starting the machine and downloading the model (${(p.presets.find((x) => x.id === p.model) || {}).sizeGb || '?'} GB). Usually 3 to 6 minutes.`, loading: 'Step 2 of 2: loading the model into memory. About a minute.' };
	const stateNote = el('div', { className: 'opt-note' });
	if (p.state === 'off') stateNote.textContent = 'Off. Nothing is being charged.';
	else if (p.state === 'ready') stateNote.append(`On for `, sinceNode(p.startedAt), ` · ${p.gpu} at ${money(p.rate)}/h. Chat is using it.`);
	else stateNote.append(progressNode(p.progress), el('div', { className: 'boot-meta', textContent: 'You can close this; the chip in the message box shows progress too.' }));
	const wakeBox = el('div');
	const chosen = p.presets.find((x) => x.id === (p.state === 'off' ? p.selected : p.model)) || p.presets[0];
	const sw = el('button', { type: 'button', className: `switch${p.state === 'starting' ? ' waking' : ''}`, role: 'switch', ariaLabel: 'Private brain' });
	sw.setAttribute('aria-checked', String(p.state !== 'off'));
	sw.addEventListener('click', async () => {
		if (p.state === 'off') return showWake(chosen, wakeBox);
		if (!confirm('Turn the private brain off? Charges stop immediately.')) return;
		sw.disabled = true;
		try { await api('DELETE', `/api/system/pods/${p.podId}`); } catch (err) { alert(err.message); }
		await refreshChip();
		renderPicker();
	});
	const head = [
		el('div', { className: 'sect', textContent: 'Private brain · rented GPU' }),
		el('div', { className: 'switch-row' }, el('div', { className: 'opt-main' }, el('div', { className: 'opt-title' }, chosen.label, ...(chosen.uncensored ? [el('span', { className: 'tag', textContent: 'Uncensored' })] : [])), stateNote), sw),
		wakeBox,
		el('div', { className: 'sect-note', textContent: p.state === 'off' ? 'Choose which model the switch turns on:' : 'To change model, turn it off first.' })
	];
	for (const preset of p.presets) {
		const running = p.state !== 'off' && preset.id === p.model;
		const on = running && b.using === 'private';
		const picked = p.state === 'off' && preset.id === chosen.id;
		head.push(option({
			title: preset.label, tag: preset.uncensored ? 'Uncensored' : '', note: preset.note,
			side: running ? (p.state === 'ready' ? (on ? 'In use' : 'On') : 'Turning on…') : picked ? 'Selected' : `${preset.sizeGb} GB`, on,
			// One brain at a time: while one is on, the others wait until it is turned off.
			disabled: p.state !== 'off' && !running,
			onClick: running
				? () => choose({ chatBrain: 'private' })
				: async () => { await api('PUT', '/api/settings', { brainModel: preset.id }); await refreshChip(); await renderPicker(); picker.body.scrollTop = 0; picker.dialog.scrollTop = 0; }
		}));
		if (picked) head.at(-1).classList.add('picked');
	}
	// The private brain comes first: it is the one with a switch.
	picker.body.replaceChildren(...head, ...nodes);
}

/** Waking a brain costs money, so show the worst-case price and wait for a second tap. */
async function showWake(preset, box) {
	const minutes = 30;
	box.replaceChildren(el('div', { className: 'wake', textContent: 'Checking prices…' }));
	const fail = (message) => box.replaceChildren(el('div', { className: 'wake sys-alert', textContent: message }));
	let q;
	try { q = await api('POST', '/api/system/quote', { minutes, kind: 'brain' }); } catch (err) { return fail(err.message); }
	if (!q.allowed) return fail(q.reason);
	const go = el('button', { type: 'button', className: 'btn-primary', textContent: `Turn on for up to ${money(q.estimate)}` });
	go.addEventListener('click', async () => {
		go.disabled = true;
		go.textContent = 'Starting…';
		// Lock the sheet until RunPod answers: changing model now would not change what was just ordered.
		picker.busy = true;
		for (const node of picker.body.querySelectorAll('.opt, .switch')) node.disabled = true;
		const slow = setTimeout(() => { go.textContent = 'Still asking RunPod…'; }, 12000);
		try {
			// The model named here is the one the price was shown for, whatever is tapped afterwards.
			await api('POST', '/api/system/pods', { minutes, confirmEstimate: q.estimate, kind: 'brain', model: preset.id });
			picker.busy = false;
			await choose({ chatBrain: 'private' }, false);
			picker.body.scrollTop = 0; picker.dialog.scrollTop = 0;
		} catch (err) {
			picker.busy = false;
			await refreshChip();
			await renderPicker();
			picker.body.querySelector('.switch-row')?.after(el('div', { className: 'wake sys-alert', textContent: err.message }));
		} finally { clearTimeout(slow); picker.busy = false; }
	});
	box.replaceChildren(el('div', { className: 'wake' },
		`${q.summary} It takes about five minutes to turn on, and turns itself off after 10 quiet minutes.`,
		el('div', { className: 'row' }, el('span', { className: 'spacer' }), go)));
	box.scrollIntoView({ block: 'nearest' });
}

$('model-chip').addEventListener('click', async () => {
	await refreshChip();
	renderPicker();
	openDialog(picker.dialog);
});
$('models-close').addEventListener('click', () => picker.dialog.close());
picker.dialog.addEventListener('click', (e) => { if (e.target === picker.dialog) picker.dialog.close(); });

/* ---------- Offline page ---------- */

// Lets the browser show a helpful page instead of an error when the engine is not running.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

/* ---------- Start ---------- */

refreshChip();
await refreshConversations();
// Reopen where you left off: the address if it names a place, else the last chat or page used.
const wanted = location.hash.slice(1) || localStorage.getItem('lastView') || '';
if (pages[wanted]) {
	// Rebuild the history entries (and the page underneath a sub-page) so Back works as before.
	state.currentId = null;
	history.replaceState(null, '', location.pathname);
	if (PARENT_PAGE[wanted]) { openPage(PARENT_PAGE[wanted]); openPage(wanted, { sub: true }); } else openPage(wanted);
}
else if (wanted && state.conversations.some((c) => c.id === wanted)) await openConversation(wanted);
else showBlank();
