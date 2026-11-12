import { renderMarkdown } from './markdown.js';

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

function renderThread() {
	const results = new Map(state.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m]));
	const nodes = state.messages.filter((m) => m.role !== 'tool').map((m) => messageNode(m, results));
	if (state.working) nodes.push(Object.assign(assistantNode(state.live || {}, true), { id: 'live' }));
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

$('attach').addEventListener('click', () => $('file-input').click());
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
	els.settings.showModal();
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
	characters: { title: 'Characters', show: () => chars.show(), hide: () => chars.hide() }
};
const nav = { page: null, returnTo: null, pushed: false };

function setView(view) {
	const page = pages[view] ? view : null;
	if (nav.page && nav.page !== page) pages[nav.page].hide();
	// "view-system" is the historical class name for "a page other than chat is showing".
	document.body.classList.toggle('view-system', Boolean(page));
	for (const name of Object.keys(pages)) $(name).hidden = name !== page;
	$('back').hidden = !page;
	const changed = nav.page !== page;
	nav.page = page;
	if (page && changed) {
		closeEvents();
		els.title.textContent = pages[page].title;
		renderSidebar();
		pages[page].show();
	}
}

/** Open a page, remembering which chat was open so Back returns to it. */
function openPage(name) {
	if (nav.page === name) return;
	if (!nav.page) {
		nav.returnTo = state.currentId;
		state.currentId = null;
		// A history entry of its own, so the phone's back button or gesture leaves the page too.
		history.pushState({ page: name }, '', `#${name}`);
		nav.pushed = true;
	} else {
		history.replaceState({ page: name }, '', `#${name}`);
	}
	setView(name);
}

/** Leave a page for the chat that was open before, or a blank chat. */
function leavePage() {
	if (!nav.page) return;
	const id = nav.returnTo;
	nav.returnTo = null;
	nav.pushed = false;
	if (id && state.conversations.some((c) => c.id === id)) openConversation(id);
	else showBlank();
}

$('back').addEventListener('click', () => { if (nav.pushed) history.back(); else leavePage(); });
window.addEventListener('popstate', leavePage);

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
		const mins = Math.max(0, Math.floor((Date.now() - job.created_at) / 60000));
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
			el('div', { className: 'row' },
				el('span', { className: 'muted small', textContent: `${mins} min so far. Reserved up to ${job.params.minutes} min, at most ${money(job.params.estimate)}. You can leave this page.` }),
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
			seconds: this.clip.meta.seconds, width: this.clip.meta.width, height: this.clip.meta.height
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
			el('div', { className: 'small', textContent: `${q.seconds} seconds of video. A GPU is reserved for up to ${q.minutes} minutes: about ${Math.round(q.minutes - q.seconds * 2 - 4)} to set up, the rest to generate. ${q.summary}` }),
			el('div', { className: 'row', style: 'margin-top:10px' }, el('span', { className: 'muted small', textContent: 'You pay only for the minutes used.' }), el('span', { className: 'spacer' }), go));
	}
};

$('vid-pick-video').addEventListener('click', () => $('vid-video-input').click());
$('vid-pick-image').addEventListener('click', () => $('vid-image-input').click());
$('vid-video-input').addEventListener('change', (e) => { if (e.target.files[0]) video.choose('clip', e.target.files[0]); e.target.value = ''; });
$('vid-image-input').addEventListener('change', (e) => { if (e.target.files[0]) video.choose('picture', e.target.files[0]); e.target.value = ''; });
$('vid-form').addEventListener('submit', (e) => { e.preventDefault(); video.quote(); });

/* ---------- Characters ---------- */

const KNOWN_TRIGGERS = [[/GTA_VI_3D_Style/i, 'gta6game_']];
const loraLabel = (name) => name.split('/').pop().replace(/\.safetensors$/, '');

const chars = {
	timer: 0, data: null, refs: {}, sig: '', loraSig: null,

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
	},

	renderSession() {
		const { session, loras, b2 } = this.data;
		const text = { off: 'Off. Nothing is being charged.', starting: `Starting up${session.detail ? `: ${session.detail}` : ''}. About 6 minutes.`, ready: `Ready. ${clock(session.secondsLeft)} left; it also stops after 10 quiet minutes.` };
		Object.assign($('img-state'), { className: `brain-state ${session.state}`, textContent: text[session.state] });
		const box = $('img-session');
		if (session.state === 'off') {
			if (!box.querySelector('#img-minutes')) {
				const minutes = el('input', { id: 'img-minutes', type: 'number', min: 5, value: 30, inputMode: 'numeric' });
				const get = el('button', { type: 'button', className: 'btn-ghost', textContent: 'Get price' });
				const out = el('div', { className: 'quote-out' });
				get.addEventListener('click', () => this.quote(Number(minutes.value), out));
				box.replaceChildren(
					...(session.lastEnd ? [el('p', { className: 'sys-alert', textContent: `Last time: ${session.lastEnd}` })] : []),
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
				const box = el('input', { type: 'checkbox', checked: i === 0 });
				box.dataset.lora = name;
				box.addEventListener('change', () => this.loraNote());
				return el('label', { className: 'lora-row' }, box, el('span', { textContent: loraLabel(name) }), el('input', { type: 'number', min: 0, max: 2, step: 0.05, value: 0.9, ariaLabel: `Strength of ${loraLabel(name)}` }));
			}) : [el('div', { className: 'muted small', textContent: session.state === 'off' ? 'Your LoRAs are listed here once a session starts.' : 'No LoRAs were found in the loras/ folder of your Backblaze bucket.' })]));
			this.loraNote();
		}
		$('img-go').disabled = session.state !== 'ready' || this.data.generations.some((g) => g.status === 'running');
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
		$('img-lora-note').textContent = [many ? 'Only the first three ticked LoRAs are used.' : '', t.length ? `Trigger word "${t.join('", "')}" is added to the start of your description for you. For other LoRAs, type their trigger word yourself.` : ''].filter(Boolean).join(' ');
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
		out.replaceChildren(el('div', { className: 'row' }, el('span', { className: 'small', textContent: q.summary }), el('span', { className: 'spacer' }), go));
	},

	/** Fill or clear one reference slot (face, body or look). */
	setRef(role, id, src) {
		if (id) this.refs[role] = id; else delete this.refs[role];
		const button = document.querySelector(`.pick.ref[data-role="${role}"]`);
		button.querySelector('.pick-body').replaceChildren(...(id ? [el('img', { src, alt: `${role} reference` })] : ['Add']));
		button.classList.toggle('filled', Boolean(id));
	},

	async generate() {
		const out = $('img-out');
		let prompt = $('img-prompt').value.trim();
		for (const t of this.triggers()) if (prompt && !prompt.includes(t)) prompt = `${t} ${prompt}`;
		try {
			await api('POST', '/api/images/generate', { prompt, loras: this.chosenLoras(), size: $('img-size').value, count: Number($('img-count').value), refs: this.refs });
			out.replaceChildren();
			this.refresh();
		} catch (err) { out.replaceChildren(el('div', { className: 'sys-alert', textContent: err.message })); }
	},

	renderGallery() {
		$('img-gallery').replaceChildren(...this.data.generations.map((g) => {
			const card = el('div', { className: 'card gen' }, el('div', { className: 'gen-prompt', textContent: g.prompt }));
			if (g.status === 'running') card.append(el('div', { className: 'brain-state starting', textContent: `Making ${g.params.count} picture${g.params.count > 1 ? 's' : ''}… usually under a minute.` }));
			if (g.status === 'failed') card.append(el('p', { className: 'sys-alert', textContent: g.detail }));
			if (g.images.length) card.append(el('div', { className: 'shots' }, ...g.images.map((id) => {
				const src = `/api/uploads/${id}`;
				const useAs = (role, label) => {
					const btn = el('button', { type: 'button', textContent: label });
					btn.addEventListener('click', () => { this.setRef(role, id, src); $('img-form').scrollIntoView({ behavior: 'smooth' }); });
					return btn;
				};
				const toVideo = el('button', { type: 'button', textContent: 'Use in Video' });
				toVideo.addEventListener('click', () => { openPage('video'); video.usePicture(id, src); });
				return el('div', { className: 'shot' }, el('a', { href: src, target: '_blank' }, el('img', { src, loading: 'lazy', alt: 'Generated picture' })),
					el('div', { className: 'shot-actions' }, el('a', { href: src, download: '', textContent: 'Save' }), useAs('face', 'Use as face'), useAs('body', 'Use as body'), useAs('look', 'Use as outfit'), toVideo));
			})));
			if (g.status !== 'running') {
				const del = el('button', { type: 'button', className: 'link', textContent: 'Delete' });
				del.addEventListener('click', async () => { if (confirm('Delete these pictures from the phone?')) { await api('DELETE', `/api/images/${g.id}`).catch(() => {}); this.sig = ''; this.refresh(); } });
				const again = el('button', { type: 'button', className: 'link', textContent: 'Reuse description' });
				again.addEventListener('click', () => { $('img-prompt').value = g.prompt; $('img-form').scrollIntoView({ behavior: 'smooth' }); });
				card.append(el('div', { className: 'row small', style: 'margin-top:10px' }, again, el('span', { className: 'spacer' }), del));
			}
			return card;
		}));
	}
};

$('img-form').addEventListener('submit', (e) => { e.preventDefault(); chars.generate(); });
for (const button of document.querySelectorAll('.pick.ref')) {
	button.addEventListener('click', () => {
		const { role } = button.dataset;
		if (chars.refs[role]) return chars.setRef(role, null);
		chars.pickingRole = role;
		$('img-ref-input').click();
	});
}
$('img-ref-input').addEventListener('change', async (e) => {
	const file = e.target.files[0];
	const role = chars.pickingRole;
	e.target.value = '';
	if (!file || !role) return;
	const body = document.querySelector(`.pick.ref[data-role="${role}"] .pick-body`);
	body.textContent = 'Uploading…';
	try { const up = await uploadWithProgress(file, (pct) => { body.textContent = `${pct}%`; }); chars.setRef(role, up.id, URL.createObjectURL(file)); }
	catch (err) { body.textContent = err.message; }
});

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
		picker.name.textContent = `Waking ${b.private.label}…`;
		picker.dot.className = 'dot waking';
	} else {
		picker.name.textContent = b.everyday.model || (b.everyday.hasKey ? 'Everyday model' : 'Choose a model');
		picker.dot.className = `dot${b.everyday.hasKey ? ' free' : ''}`;
	}
	// While a brain is waking or awake, keep the chip honest without the user doing anything.
	if (b.private.state !== 'off') picker.timer = setTimeout(async () => { await refreshChip(); if (picker.dialog.open) renderPicker(); }, b.private.state === 'starting' ? 8000 : 30000);
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

	// Private brain: a model on a rented GPU. Costs money while awake.
	const p = b.private;
	const stateText = { off: 'asleep, nothing is being charged', starting: 'waking up, this takes several minutes', ready: 'awake' }[p.state];
	nodes.push(el('div', { className: 'sect', textContent: `Private · rented GPU · ${stateText}` }));
	const wakeBox = el('div');
	for (const preset of p.presets) {
		const running = p.state !== 'off' && preset.id === p.model;
		const on = running && b.using === 'private';
		const side = running ? (p.state === 'ready' ? (on ? 'In use' : 'Awake') : 'Waking…') : `${preset.sizeGb} GB`;
		nodes.push(option({
			title: preset.label, tag: preset.uncensored ? 'Uncensored' : '', note: preset.note, side, on,
			// One brain at a time: while one is up, the others wait until it is put to sleep.
			disabled: p.state !== 'off' && !running,
			onClick: running
				? () => choose({ chatBrain: 'private' })
				: async () => { await api('PUT', '/api/settings', { brainModel: preset.id }); showWake(preset, wakeBox); }
		}));
	}
	nodes.push(wakeBox);
	if (p.state !== 'off') {
		const sleep = el('button', { type: 'button', className: 'btn-ghost', textContent: 'Put the brain to sleep' });
		sleep.addEventListener('click', async () => {
			sleep.disabled = true;
			try { await api('DELETE', `/api/system/pods/${p.podId}`); } catch (err) { alert(err.message); }
			await refreshChip();
			renderPicker();
		});
		nodes.push(el('div', { className: 'wake' }, 'To switch to a different private model, put this one to sleep first. Charges stop immediately.', el('div', { className: 'row' }, el('span', { className: 'spacer' }), sleep)));
	}
	picker.body.replaceChildren(...nodes);
}

/** Waking a brain costs money, so show the worst-case price and wait for a second tap. */
async function showWake(preset, box) {
	const minutes = 30;
	box.replaceChildren(el('div', { className: 'wake', textContent: 'Checking prices…' }));
	const fail = (message) => box.replaceChildren(el('div', { className: 'wake sys-alert', textContent: message }));
	let q;
	try { q = await api('POST', '/api/system/quote', { minutes, kind: 'brain' }); } catch (err) { return fail(err.message); }
	if (!q.allowed) return fail(q.reason);
	const go = el('button', { type: 'button', className: 'btn-primary', textContent: `Wake for up to ${money(q.estimate)}` });
	go.addEventListener('click', async () => {
		go.disabled = true;
		go.textContent = 'Starting…';
		try {
			await api('POST', '/api/system/pods', { minutes, confirmEstimate: q.estimate, kind: 'brain' });
			await choose({ chatBrain: 'private' });
		} catch (err) { fail(err.message); }
	});
	box.replaceChildren(el('div', { className: 'wake' },
		el('div', { className: 'opt-title' }, `Wake ${preset.label}`, ...(preset.uncensored ? [el('span', { className: 'tag', textContent: 'Uncensored' })] : [])),
		`${q.summary} It takes about five minutes to wake, and goes back to sleep by itself after 10 quiet minutes.`,
		el('div', { className: 'row' }, el('span', { className: 'spacer' }), go)));
	box.scrollIntoView({ block: 'nearest' });
}

$('model-chip').addEventListener('click', async () => {
	await refreshChip();
	renderPicker();
	picker.dialog.showModal();
});
$('models-close').addEventListener('click', () => picker.dialog.close());
picker.dialog.addEventListener('click', (e) => { if (e.target === picker.dialog) picker.dialog.close(); });

/* ---------- Window height ---------- */

// Pin the layout to the area that is actually visible. Normally this equals the CSS height
// already; it corrects phones where the installed app reports a taller page than it shows.
function fitWindow() {
	const vv = window.visualViewport;
	if (!vv || vv.scale !== 1) return;
	document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
}
window.visualViewport?.addEventListener('resize', fitWindow);
window.addEventListener('orientationchange', fitWindow);
fitWindow();

/* ---------- Start ---------- */

refreshChip();
await refreshConversations();
const wanted = location.hash.slice(1);
if (pages[wanted]) { state.currentId = null; setView(wanted); }
else if (wanted && state.conversations.some((c) => c.id === wanted)) await openConversation(wanted);
else showBlank();
