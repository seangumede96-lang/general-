import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createComfyClient } from '../src/comfy.js';

test('a dropped connection to the engine is retried instead of failing the job', async () => {
	let drops = 2, calls = 0;
	const server = createServer((req, res) => {
		calls++;
		if (drops > 0) { drops--; return req.socket.destroy(); }
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ prompt_id: 'p1' }));
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const comfy = createComfyClient(`http://127.0.0.1:${server.address().port}`, { retryDelaysMs: [5, 5, 5] });
	try {
		assert.equal(await comfy.queue({ 1: {} }, 'c'), 'p1');
		assert.equal(calls, 3, 'two drops, then success');
		drops = 10;
		await assert.rejects(comfy.queue({ 1: {} }, 'c'), /after 4 tries/);
		// the readiness check does not retry: it is asked again on the next poll anyway
		drops = 1; calls = 0;
		assert.equal(await comfy.ready(), false);
		assert.equal(calls, 1);
	} finally { server.close(); }
});
