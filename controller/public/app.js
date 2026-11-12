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
	if (m.role === 'user') return el('div', { className: 'msg user', textContent: m.content });
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
	els.send.disabled = !state.working && !els.input.value.trim();
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

/* ---------- System page ---------- */

const sys = {
	view: $('system'), error: $('sys-error'), remaining: $('sys-remaining'), meter: $('sys-meter'), spent: $('sys-spent'),
	unknown: $('sys-unknown'), active: $('sys-active'), minutes: $('sys-minutes'), quoteOut: $('sys-quote-out'),
	form: $('sys-form'), formStatus: $('sys-form-status'), history: $('sys-history'), timer: 0
};
const money = (n) => `$${Number(n).toFixed(2)}`;
const clock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

function setView(view) {
	const system = view === 'system';
	document.body.classList.toggle('view-system', system);
	sys.view.hidden = !system;
	$('back').hidden = !system;
	clearInterval(sys.timer);
	if (system) {
		closeEvents();
		els.title.textContent = 'System';
		renderSidebar();
		refreshSystem(true);
		sys.timer = setInterval(() => refreshSystem(false), 5000);
	}
}

/** Open the System page, remembering which chat was open so Back returns to it. */
function openSystem() {
	if (document.body.classList.contains('view-system')) return;
	sys.returnTo = state.currentId;
	state.currentId = null;
	// A history entry of its own, so the phone's back button or gesture leaves the page too.
	history.pushState({ system: true }, '', '#system');
	sys.pushed = true;
	setView('system');
}

/** Leave the System page for the chat that was open before, or a blank chat. */
function leaveSystem() {
	if (!document.body.classList.contains('view-system')) return;
	const id = sys.returnTo;
	sys.returnTo = null;
	sys.pushed = false;
	if (id && state.conversations.some((c) => c.id === id)) openConversation(id);
	else showBlank();
}

$('back').addEventListener('click', () => { if (sys.pushed) history.back(); else leaveSystem(); });
window.addEventListener('popstate', leaveSystem);

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
	if (sys.view.hidden) return;
	sys.error.hidden = !s.error;
	sys.error.textContent = s.error || '';

	const { total, spent, remaining } = s.budget;
	sys.remaining.textContent = money(remaining);
	sys.meter.style.width = `${total > 0 ? Math.min(100, spent / total * 100) : 100}%`;
	sys.meter.parentElement.classList.toggle('low', total > 0 && remaining / total < 0.15);
	sys.spent.textContent = `${money(spent)} spent of ${money(total)}`;

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

$('open-system').addEventListener('click', () => { setDrawer(false); openSystem(); });

/* ---------- Start ---------- */

await refreshConversations();
const wanted = location.hash.slice(1);
if (wanted === 'system') { state.currentId = null; setView('system'); }
else if (wanted && state.conversations.some((c) => c.id === wanted)) await openConversation(wanted);
else showBlank();
