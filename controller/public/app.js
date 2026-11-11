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

function messageNode(m) {
	if (m.role === 'user') return el('div', { className: 'msg user', textContent: m.content });
	if (m.role === 'error') return el('div', { className: 'msg error', role: 'alert', textContent: m.content });
	return assistantNode(m);
}

function renderThread() {
	const nodes = state.messages.map(messageNode);
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
	els.send.disabled = !state.working && !els.input.value.trim();
	els.send.setAttribute('aria-label', state.working ? 'Stop generating' : 'Send');
}

/* ---------- Conversation lifecycle ---------- */

function closeEvents() {
	state.events?.close();
	state.events = null;
}

function showBlank() {
	closeEvents();
	Object.assign(state, { currentId: null, messages: [], working: false, live: null });
	els.title.textContent = 'New chat';
	history.replaceState(null, '', location.pathname);
	renderSidebar();
	renderThread();
}

/** Open a conversation and resolve once its event stream has delivered the first snapshot. */
function openConversation(id) {
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
				for (const m of ev.messages || []) if (!state.messages.some((x) => x.id === m.id)) state.messages.push(m);
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
	if (!text || state.working) return;
	els.input.value = '';
	autoGrow();
	try {
		if (!state.currentId) {
			const conv = await api('POST', '/api/conversations');
			state.conversations.unshift(conv);
			await openConversation(conv.id);
		}
		await api('POST', `/api/conversations/${state.currentId}/messages`, { text });
	} catch (err) {
		els.input.value = text;
		autoGrow();
		state.messages.push({ id: `local-${Date.now()}`, role: 'error', content: `Message not sent: ${err.message}` });
		renderThread();
	}
}

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
	} catch (err) {
		setStatus(err.message, 'bad');
	}
});

/* ---------- Start ---------- */

await refreshConversations();
const wanted = location.hash.slice(1);
if (wanted && state.conversations.some((c) => c.id === wanted)) await openConversation(wanted);
else showBlank();
