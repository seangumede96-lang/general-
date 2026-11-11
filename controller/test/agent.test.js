import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { validateArgs } from '../src/tools.js';
import { startMockModel } from './mock-model.js';

let app, base, mock, root, shared, secret;

const api = async (method, path, body) => {
	const res = await fetch(base + path, {
		method,
		headers: body ? { 'Content-Type': 'application/json' } : {},
		body: body ? JSON.stringify(body) : undefined
	});
	return { status: res.status, body: await res.json() };
};

/** Send a message and react to events until the turn ends. Returns all events seen. */
async function runTurn(id, text, onEvent = () => {}) {
	const ctrl = new AbortController();
	const res = await fetch(`${base}/api/conversations/${id}/events`, { signal: ctrl.signal });
	const events = [];
	const decoder = new TextDecoder();
	let buf = '';
	let sent = false;
	try {
		for await (const chunk of res.body) {
			buf += decoder.decode(chunk, { stream: true });
			const frames = buf.split('\n\n');
			buf = frames.pop();
			for (const f of frames) {
				if (!f.startsWith('data: ')) continue;
				const ev = JSON.parse(f.slice(6));
				events.push(ev);
				if (!sent) { sent = true; await api('POST', `/api/conversations/${id}/messages`, { text }); }
				await onEvent(ev);
				if (ev.t === 'turn' && ev.phase === 'end') { ctrl.abort(); return events; }
			}
		}
	} catch (err) {
		if (err.name !== 'AbortError') throw err;
	}
	return events;
}

const newConversation = async () => (await api('POST', '/api/conversations')).body.id;
const saved = async (id) => (await api('GET', `/api/conversations/${id}`)).body.messages;
const toolResults = (messages) => messages.filter((m) => m.role === 'tool');
const decide = (id, decision) => (ev) => ev.t === 'approval' && ev.waiting && api('POST', `/api/conversations/${id}/approvals/${ev.id}`, { decision });

before(async () => {
	mock = await startMockModel();
	root = mkdtempSync(join(tmpdir(), 'controller-agent-'));
	shared = join(root, 'shared');
	secret = join(root, 'secret');
	mkdirSync(shared);
	mkdirSync(secret);
	writeFileSync(join(shared, 'notes.txt'), 'buy film stock');
	writeFileSync(join(secret, 'keys.txt'), 'do-not-read');
	symlinkSync(secret, join(shared, 'link-out'));
	app = createApp({ dataDir: join(root, 'data') });
	base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
});

after(async () => {
	await app.close();
	await mock.close();
	rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
	Object.assign(mock.state, { requests: [], replies: [], delayMs: 0 });
	await api('PUT', '/api/settings', { baseUrl: mock.baseUrl, model: 'mock-model', allowedDirs: shared });
});

test('runs a read tool and feeds the result back to the model', async () => {
	mock.state.replies = [
		{ toolCalls: [{ name: 'read_file', arguments: { path: 'notes.txt' } }] },
		{ chunks: ['Your note says to buy film stock.'] }
	];
	const id = await newConversation();
	const events = await runTurn(id, 'what is in my notes?');
	assert.equal(events.at(-1).status, 'ok');
	assert.ok(!events.some((e) => e.t === 'approval'), 'reading needs no approval');

	const messages = await saved(id);
	assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
	assert.equal(messages[2].content, 'buy film stock');
	assert.equal(messages[2].status, 'ok');

	const second = mock.state.requests[1].messages;
	assert.equal(second.at(-1).role, 'tool');
	assert.equal(second.at(-1).content, 'buy film stock');
	assert.equal(second.at(-2).tool_calls[0].function.name, 'read_file');
	assert.ok(mock.state.requests[0].tools.some((t) => t.function.name === 'write_file'));
});

test('a write waits for approval and happens only when allowed', async () => {
	mock.state.replies = [
		{ toolCalls: [{ name: 'write_file', arguments: { path: 'plan.txt', content: 'shot list' } }] },
		{ chunks: ['Saved.'] }
	];
	const id = await newConversation();
	let fileExistedWhileWaiting;
	await runTurn(id, 'save a plan', async (ev) => {
		if (ev.t === 'approval' && ev.waiting) {
			fileExistedWhileWaiting = existsSync(join(shared, 'plan.txt'));
			const snap = (await api('GET', `/api/conversations/${id}`)).body;
			assert.equal(snap.working, true);
			await api('POST', `/api/conversations/${id}/approvals/${ev.id}`, { decision: 'allow' });
		}
	});
	assert.equal(fileExistedWhileWaiting, false);
	assert.equal(readFileSync(join(shared, 'plan.txt'), 'utf8'), 'shot list');
	assert.equal(toolResults(await saved(id))[0].status, 'ok');
});

test('a declined write does nothing and the model is told', async () => {
	mock.state.replies = [
		{ toolCalls: [{ name: 'write_file', arguments: { path: 'nope.txt', content: 'x' } }] },
		{ chunks: ['Understood, I left it alone.'] }
	];
	const id = await newConversation();
	await runTurn(id, 'write it', decide(id, 'deny'));
	assert.equal(existsSync(join(shared, 'nope.txt')), false);
	const result = toolResults(await saved(id))[0];
	assert.equal(result.status, 'denied');
	assert.match(mock.state.requests[1].messages.at(-1).content, /declined/);
});

test('file tools cannot leave the shared folders, by path or by symlink', async () => {
	const attempts = [
		{ name: 'read_file', arguments: { path: '../secret/keys.txt' } },
		{ name: 'read_file', arguments: { path: join(secret, 'keys.txt') } },
		{ name: 'read_file', arguments: { path: 'link-out/keys.txt' } },
		{ name: 'list_files', arguments: { path: '/' } }
	];
	mock.state.replies = [{ toolCalls: attempts }, { chunks: ['I cannot reach that.'] }];
	const id = await newConversation();
	await runTurn(id, 'read the secret');
	const results = toolResults(await saved(id));
	assert.equal(results.length, attempts.length);
	for (const r of results) {
		assert.equal(r.status, 'error');
		assert.match(r.content, /outside the folders shared/);
		assert.ok(!r.content.includes('do-not-read'));
	}
});

test('an approved write still cannot escape through a symlink', async () => {
	mock.state.replies = [
		{ toolCalls: [{ name: 'write_file', arguments: { path: 'link-out/planted.txt', content: 'x' } }] },
		{ chunks: ['Could not.'] }
	];
	const id = await newConversation();
	await runTurn(id, 'plant it', decide(id, 'allow'));
	assert.equal(existsSync(join(secret, 'planted.txt')), false);
	assert.equal(toolResults(await saved(id))[0].status, 'error');
});

test('with no shared folders the file tools refuse', async () => {
	await api('PUT', '/api/settings', { allowedDirs: '' });
	mock.state.replies = [{ toolCalls: [{ name: 'read_file', arguments: { path: join(shared, 'notes.txt') } }] }, { chunks: ['ok'] }];
	const id = await newConversation();
	await runTurn(id, 'read');
	assert.match(toolResults(await saved(id))[0].content, /No folders are shared/);
});

test('malformed and unknown calls come back as errors the model can act on', async () => {
	mock.state.replies = [
		{ toolCalls: [
			{ name: 'read_file', arguments: '{"path": ' },
			{ name: 'read_file', arguments: { file: 'notes.txt' } },
			{ name: 'launch_rocket', arguments: {} }
		] },
		{ toolCalls: [{ name: 'read_file', arguments: { path: 'notes.txt' } }] },
		{ chunks: ['Got it on the second try.'] }
	];
	const id = await newConversation();
	const events = await runTurn(id, 'read notes');
	assert.equal(events.at(-1).status, 'ok');
	const results = toolResults(await saved(id));
	assert.match(results[0].content, /not valid JSON/);
	assert.match(results[1].content, /missing required argument "path"/);
	assert.match(results[2].content, /no tool called "launch_rocket"/);
	assert.equal(results[3].content, 'buy film stock');
	// The broken arguments must not be replayed verbatim into the next request.
	for (const c of mock.state.requests[1].messages.at(-4).tool_calls) JSON.parse(c.function.arguments);
});

test('memory persists across conversations', async () => {
	mock.state.replies = [{ toolCalls: [{ name: 'remember', arguments: { text: 'Prefers 9:16 vertical video.' } }] }, { chunks: ['Noted.'] }];
	await runTurn(await newConversation(), 'remember my format');
	mock.state.replies = [{ toolCalls: [{ name: 'recall', arguments: { query: 'vertical' } }] }, { chunks: ['You prefer vertical.'] }];
	const id = await newConversation();
	await runTurn(id, 'what format do I like?');
	assert.match(toolResults(await saved(id))[0].content, /Prefers 9:16 vertical video\./);
});

test('a model that never stops calling tools is cut off', async () => {
	mock.state.replies = Array.from({ length: 30 }, () => ({ toolCalls: [{ name: 'recall', arguments: {} }] }));
	const id = await newConversation();
	const events = await runTurn(id, 'loop');
	assert.equal(events.at(-1).status, 'error');
	assert.equal(mock.state.requests.length, 12);
	assert.match((await saved(id)).at(-1).content, /Stopped after 12 tool steps/);
});

test('stopping while an approval is open cancels the action and keeps history valid', async () => {
	mock.state.replies = [{ toolCalls: [{ name: 'write_file', arguments: { path: 'stopped.txt', content: 'x' } }] }];
	const id = await newConversation();
	const events = await runTurn(id, 'write then stop', (ev) => ev.t === 'approval' && ev.waiting && api('POST', `/api/conversations/${id}/stop`));
	assert.equal(events.at(-1).status, 'stopped');
	assert.equal(existsSync(join(shared, 'stopped.txt')), false);

	mock.state.replies = [{ chunks: ['Carrying on.'] }];
	await runTurn(id, 'continue');
	const sent = mock.state.requests.at(-1).messages;
	const callIndex = sent.findIndex((m) => m.tool_calls);
	assert.equal(sent[callIndex + 1].role, 'tool', 'the stopped call has a result before the next user turn');
});

test('an approval that is not waiting is rejected', async () => {
	const id = await newConversation();
	assert.equal((await api('POST', `/api/conversations/${id}/approvals/call_x`, { decision: 'allow' })).status, 404);
});

test('argument validation', () => {
	const schema = { type: 'object', properties: { path: { type: 'string' }, n: { type: 'integer' } }, required: ['path'] };
	assert.equal(validateArgs(schema, { path: 'a' }), null);
	assert.equal(validateArgs(schema, { path: 'a', n: 3 }), null);
	assert.match(validateArgs(schema, {}), /missing/);
	assert.match(validateArgs(schema, { path: 5 }), /must be of type string/);
	assert.match(validateArgs(schema, { path: 'a', n: 1.5 }), /must be of type integer/);
	assert.match(validateArgs(schema, { path: 'a', extra: 1 }), /unknown argument/);
	assert.match(validateArgs(schema, []), /JSON object/);
});
