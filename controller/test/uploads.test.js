import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { startMockModel } from './mock-model.js';

let app, base, mock, root;
const api = async (method, path, body) => {
	const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, body: await res.json() };
};
const upload = async (name, bytes, type) => {
	const res = await fetch(`${base}/api/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': type }, body: bytes });
	return { status: res.status, body: await res.json() };
};
async function send(id, body) {
	const r = await api('POST', `/api/conversations/${id}/messages`, body);
	if (r.status !== 200) return r;
	for (let i = 0; i < 300; i++) {
		const c = (await api('GET', `/api/conversations/${id}`)).body;
		if (!c.working) return { status: 200, messages: c.messages };
		await new Promise((res) => setTimeout(res, 10));
	}
	throw new Error('turn did not finish');
}
const newConversation = async () => (await api('POST', '/api/conversations')).body.id;
const uploadsOnDisk = () => (existsSync(join(root, 'data', 'uploads')) ? readdirSync(join(root, 'data', 'uploads')) : []);

before(async () => {
	mock = await startMockModel();
	root = mkdtempSync(join(tmpdir(), 'controller-up-'));
	app = createApp({ dataDir: join(root, 'data'), watchdogMs: 0, maxUploadBytes: 1000 });
	base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
});
after(async () => { await app.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
beforeEach(async () => {
	Object.assign(mock.state, { requests: [], replies: [] });
	await api('PUT', '/api/settings', { baseUrl: mock.baseUrl, model: 'mock-model', allowedDirs: '' });
});

test('an uploaded file can be sent with a message; the model is told what and where it is', async () => {
	const photo = await upload('beach photo.jpg', Buffer.from('JPEGDATA'), 'image/jpeg');
	assert.equal(photo.status, 200);
	assert.deepEqual(Object.keys(photo.body).sort(), ['id', 'name', 'size', 'type'], 'the storage path is not sent to the browser');
	const id = await newConversation();
	const r = await send(id, { text: 'what do you think?', attachments: [photo.body.id] });
	assert.deepEqual(JSON.parse(r.messages[0].attachments), [{ id: photo.body.id, name: 'beach photo.jpg', type: 'image/jpeg', size: 8 }]);
	const sent = mock.state.requests[0].messages.at(-1).content;
	assert.match(sent, /^what do you think\?\n\n\[The user attached a file\]\n- beach photo\.jpg \(image\/jpeg, 1 KB\) saved at .*uploads.*beach photo\.jpg$/);
});

test('a message can be files only, and the chat is titled after them', async () => {
	const a = await upload('clip.mp4', Buffer.from('VIDEO'), 'video/mp4');
	const id = await newConversation();
	const r = await send(id, { text: '', attachments: [a.body.id] });
	assert.equal(r.status, 200);
	assert.equal((await api('GET', `/api/conversations/${id}`)).body.conversation.title, 'clip.mp4');
	assert.equal((await api('POST', `/api/conversations/${id}/messages`, { text: ' ' })).status, 400);
});

test('files are served back with ranges for video and can never run as a page', async () => {
	const v = await upload('clip.mp4', Buffer.from('0123456789'), 'video/mp4');
	let res = await fetch(`${base}/api/uploads/${v.body.id}`);
	assert.equal(res.headers.get('content-type'), 'video/mp4');
	assert.equal(await res.text(), '0123456789');
	res = await fetch(`${base}/api/uploads/${v.body.id}`, { headers: { Range: 'bytes=2-5' } });
	assert.equal(res.status, 206);
	assert.equal(res.headers.get('content-range'), 'bytes 2-5/10');
	assert.equal(await res.text(), '2345');
	res = await fetch(`${base}/api/uploads/${v.body.id}`, { headers: { Range: 'bytes=-3' } });
	assert.equal(await res.text(), '789');

	for (const [name, type] of [['page.html', 'text/html'], ['drawing.svg', 'image/svg+xml']]) {
		const h = await upload(name, Buffer.from('<script>alert(1)</script>'), type);
		res = await fetch(`${base}/api/uploads/${h.body.id}`);
		assert.equal(res.headers.get('content-type'), 'application/octet-stream');
		assert.match(res.headers.get('content-disposition'), /^attachment/);
		assert.match(res.headers.get('content-security-policy'), /sandbox/);
		assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
	}
	assert.equal((await fetch(`${base}/api/uploads/nope`)).status, 404);
});

test('file names cannot escape the upload folder', async () => {
	const u = await upload('../../../etc/evil.txt', Buffer.from('x'), 'text/plain');
	assert.equal(u.status, 200);
	assert.equal(u.body.name, '_.._.._etc_evil.txt');
	assert.ok(!existsSync(join(root, 'etc', 'evil.txt')));
});

test('too-large and empty uploads are refused and leave nothing behind', async () => {
	const before = uploadsOnDisk().length;
	const big = await upload('big.bin', Buffer.alloc(1001), 'application/octet-stream');
	assert.equal(big.status, 413);
	assert.match(big.body.error, /too large/);
	assert.equal((await upload('empty.txt', Buffer.alloc(0), 'text/plain')).status, 400);
	assert.equal(uploadsOnDisk().length, before);
});

test('an upload can be attached once only, and unknown ids are refused', async () => {
	const u = await upload('a.txt', Buffer.from('hello'), 'text/plain');
	const first = await newConversation();
	assert.equal((await send(first, { text: 'one', attachments: [u.body.id] })).status, 200);
	const second = await newConversation();
	assert.equal((await api('POST', `/api/conversations/${second}/messages`, { text: 'two', attachments: [u.body.id] })).status, 400);
	assert.equal((await api('POST', `/api/conversations/${second}/messages`, { text: 'x', attachments: ['missing'] })).status, 400);
	assert.equal((await api('POST', `/api/conversations/${second}/messages`, { text: 'x', attachments: Array(11).fill('a') })).status, 400);
});

test('the assistant can read an attached text file but cannot write into the upload area', async () => {
	const u = await upload('notes.txt', Buffer.from('shoot at golden hour'), 'text/plain');
	const id = await newConversation();
	mock.state.replies = [{ chunks: ['ok'] }];
	await send(id, { text: 'here', attachments: [u.body.id] });
	const path = mock.state.requests[0].messages.at(-1).content.match(/saved at (.*)$/)[1];

	mock.state.replies = [{ toolCalls: [{ name: 'read_file', arguments: { path } }] }, { chunks: ['read it'] }];
	let r = await send(id, { text: 'read it' });
	assert.equal(r.messages.find((m) => m.role === 'tool').content, 'shoot at golden hour');

	// Even with the user's approval, a write into the upload area must be refused.
	mock.state.replies = [{ toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path, content: 'changed' } }] }, { chunks: ['no'] }];
	const approve = (async () => {
		for (let i = 0; i < 300; i++) {
			if ((await api('POST', `/api/conversations/${id}/approvals/w1`, { decision: 'allow' })).status === 200) return;
			await new Promise((res) => setTimeout(res, 10));
		}
	})();
	r = await send(id, { text: 'overwrite it' });
	await approve;
	const result = r.messages.filter((m) => m.role === 'tool').at(-1);
	assert.equal(result.status, 'error');
	assert.match(result.content, /No folders are shared/);
	assert.equal((await (await fetch(`${base}/api/uploads/${u.body.id}`)).text()), 'shoot at golden hour');
});

test('deleting a conversation deletes its files', async () => {
	const u = await upload('gone.txt', Buffer.from('bye'), 'text/plain');
	const id = await newConversation();
	await send(id, { text: 'x', attachments: [u.body.id] });
	assert.ok(uploadsOnDisk().includes(u.body.id));
	await api('DELETE', `/api/conversations/${id}`);
	await new Promise((r) => setTimeout(r, 50));
	assert.ok(!uploadsOnDisk().includes(u.body.id));
	assert.equal((await fetch(`${base}/api/uploads/${u.body.id}`)).status, 404);
});
