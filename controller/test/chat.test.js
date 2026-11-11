import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { createThinkSplitter } from '../src/model.js';
import { startMockModel } from './mock-model.js';

let app, base, mock, dataDir;

const api = async (method, path, body, headers = {}) => {
	const res = await fetch(base + path, {
		method,
		headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
		body: body ? JSON.stringify(body) : undefined
	});
	return { status: res.status, body: await res.json() };
};

/** Collect SSE events from a conversation until `until(ev)` is true. */
async function collectEvents(id, until, trigger) {
	const ctrl = new AbortController();
	const res = await fetch(`${base}/api/conversations/${id}/events`, { signal: ctrl.signal });
	const events = [];
	const decoder = new TextDecoder();
	let buf = '';
	let triggered = false;
	try {
		for await (const chunk of res.body) {
			buf += decoder.decode(chunk, { stream: true });
			const frames = buf.split('\n\n');
			buf = frames.pop();
			for (const f of frames) {
				if (!f.startsWith('data: ')) continue;
				const ev = JSON.parse(f.slice(6));
				events.push(ev);
				if (!triggered && trigger) { triggered = true; await trigger(); }
				if (until(ev)) { ctrl.abort(); return events; }
			}
		}
	} catch (err) {
		if (err.name !== 'AbortError') throw err;
	}
	return events;
}

const turnEnded = (ev) => ev.t === 'turn' && ev.phase === 'end';

async function sendAndWait(id, text) {
	return collectEvents(id, turnEnded, async () => {
		const r = await api('POST', `/api/conversations/${id}/messages`, { text });
		assert.equal(r.status, 200);
	});
}

before(async () => {
	mock = await startMockModel();
	dataDir = mkdtempSync(join(tmpdir(), 'controller-test-'));
	app = createApp({ dataDir });
	const addr = await app.listen(0, '127.0.0.1');
	base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
	await app.close();
	await mock.close();
	rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
	Object.assign(mock.state, { chunks: ['Hello', ' from the', ' mock model.'], delayMs: 0, requireKey: null, requests: [], replies: [] });
	await api('PUT', '/api/settings', { baseUrl: mock.baseUrl, model: '', clearApiKey: true, allowedDirs: '' });
});

test('streams a reply, saves it, and titles the conversation', async () => {
	const conv = (await api('POST', '/api/conversations')).body;
	const events = await sendAndWait(conv.id, 'What is the capital of France?');

	assert.equal(events[0].t, 'snapshot');
	assert.equal(events.filter((e) => e.t === 'text').map((e) => e.text).join(''), 'Hello from the mock model.');
	assert.equal(events.at(-1).status, 'ok');

	const saved = (await api('GET', `/api/conversations/${conv.id}`)).body;
	assert.equal(saved.conversation.title, 'What is the capital of France?');
	assert.deepEqual(saved.messages.map((m) => [m.role, m.content]), [
		['user', 'What is the capital of France?'],
		['assistant', 'Hello from the mock model.']
	]);
	assert.equal(saved.working, false);
	assert.equal(mock.state.requests[0].model, 'mock-model', 'falls back to the endpoint\'s first model');
});

test('sends the system prompt and full history on later turns', async () => {
	const conv = (await api('POST', '/api/conversations')).body;
	await sendAndWait(conv.id, 'first');
	await sendAndWait(conv.id, 'second');
	const sent = mock.state.requests.at(-1).messages;
	assert.deepEqual(sent.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
	assert.equal(sent[3].content, 'second');
});

test('separates <think> reasoning from the answer, even when tags are split across chunks', async () => {
	mock.state.chunks = ['<thi', 'nk>pondering', ' deeply</th', 'ink>The answer', ' is 4.'];
	const conv = (await api('POST', '/api/conversations')).body;
	await sendAndWait(conv.id, '2+2?');
	const { messages } = (await api('GET', `/api/conversations/${conv.id}`)).body;
	assert.equal(messages[1].reasoning, 'pondering deeply');
	assert.equal(messages[1].content, 'The answer is 4.');
});

test('think splitter passes through text that only looks like the start of a tag', () => {
	let text = '', thinking = '';
	const s = createThinkSplitter((t) => { text += t; }, (t) => { thinking += t; });
	for (const d of ['a <', 'b> c <th', 'ree', '<think>x', '</think>', 'y <']) s.push(d);
	s.flush();
	assert.equal(text, 'a <b> c <threey <');
	assert.equal(thinking, 'x');
});

test('stop keeps the partial reply and marks it stopped', async () => {
	mock.state.chunks = ['one ', 'two ', 'three ', 'four ', 'five ', 'six'];
	mock.state.delayMs = 150;
	const conv = (await api('POST', '/api/conversations')).body;
	let stopped = false;
	const events = await collectEvents(conv.id, (ev) => {
		if (ev.t === 'text' && !stopped) { stopped = true; api('POST', `/api/conversations/${conv.id}/stop`); }
		return turnEnded(ev);
	}, () => api('POST', `/api/conversations/${conv.id}/messages`, { text: 'count' }));

	assert.equal(events.at(-1).status, 'stopped');
	const { messages } = (await api('GET', `/api/conversations/${conv.id}`)).body;
	assert.equal(messages[1].status, 'stopped');
	assert.ok(messages[1].content.startsWith('one '));
	assert.ok(!messages[1].content.includes('six'));
});

test('a client that attaches mid-reply gets the text so far in its snapshot', async () => {
	mock.state.chunks = ['alpha ', 'beta ', 'gamma ', 'delta'];
	mock.state.delayMs = 120;
	const conv = (await api('POST', '/api/conversations')).body;
	await api('POST', `/api/conversations/${conv.id}/messages`, { text: 'go' });
	await new Promise((r) => setTimeout(r, 200));
	const events = await collectEvents(conv.id, turnEnded);
	assert.equal(events[0].t, 'snapshot');
	assert.equal(events[0].working, true);
	assert.ok(events[0].text.startsWith('alpha '));
	const rest = events.filter((e) => e.t === 'text').map((e) => e.text).join('');
	assert.equal(events[0].text + rest, 'alpha beta gamma delta');
});

test('refuses a second message while a reply is in flight', async () => {
	mock.state.delayMs = 100;
	const conv = (await api('POST', '/api/conversations')).body;
	await api('POST', `/api/conversations/${conv.id}/messages`, { text: 'one' });
	const second = await api('POST', `/api/conversations/${conv.id}/messages`, { text: 'two' });
	assert.equal(second.status, 409);
	await collectEvents(conv.id, (ev) => turnEnded(ev) || (ev.t === 'snapshot' && !ev.working));
});

test('an unreachable endpoint becomes a saved, readable error', async () => {
	await api('PUT', '/api/settings', { baseUrl: 'http://127.0.0.1:1/v1', model: 'x' });
	const conv = (await api('POST', '/api/conversations')).body;
	const events = await sendAndWait(conv.id, 'hello');
	assert.equal(events.at(-1).status, 'error');
	const { messages } = (await api('GET', `/api/conversations/${conv.id}`)).body;
	assert.equal(messages[1].role, 'error');
	assert.match(messages[1].content, /Could not reach the model endpoint/);
});

test('the API key is used for requests but never returned', async () => {
	mock.state.requireKey = 'sk-secret-123';
	await api('PUT', '/api/settings', { apiKey: 'sk-secret-123' });
	const settings = (await api('GET', '/api/settings')).body;
	assert.equal(settings.hasApiKey, true);
	assert.ok(!JSON.stringify(settings).includes('sk-secret-123'));

	// A blank key in a later save must not wipe the stored one.
	await api('PUT', '/api/settings', { apiKey: '', temperature: '0.5' });
	const conv = (await api('POST', '/api/conversations')).body;
	const events = await sendAndWait(conv.id, 'hi');
	assert.equal(events.at(-1).status, 'ok');
});

test('history survives a restart', async () => {
	const conv = (await api('POST', '/api/conversations')).body;
	await sendAndWait(conv.id, 'remember me');
	await app.close();
	app = createApp({ dataDir });
	const addr = await app.listen(0, '127.0.0.1');
	base = `http://127.0.0.1:${addr.port}`;
	const { messages } = (await api('GET', `/api/conversations/${conv.id}`)).body;
	assert.equal(messages.length, 2);
	const list = (await api('GET', '/api/conversations')).body.conversations;
	assert.ok(list.some((c) => c.id === conv.id));
});

test('deleting a conversation removes its messages', async () => {
	const conv = (await api('POST', '/api/conversations')).body;
	await sendAndWait(conv.id, 'bye');
	assert.equal((await api('DELETE', `/api/conversations/${conv.id}`)).status, 200);
	assert.equal((await api('GET', `/api/conversations/${conv.id}`)).status, 404);
});

test('cross-origin requests and path traversal are refused', async () => {
	const xo = await api('POST', '/api/conversations', null, { Origin: 'https://evil.example' });
	assert.equal(xo.status, 403);
	const res = await fetch(`${base}/..%2fsrc%2fserver.js`);
	assert.notEqual(res.status, 200);
});
