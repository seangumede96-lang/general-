// A stand-in for a vLLM / llama.cpp server: OpenAI-compatible, streams a scripted reply.
import { createServer } from 'node:http';

/**
 * @param {object} opts
 * @param {string[]} [opts.chunks]  content deltas to stream
 * @param {number} [opts.delayMs]   pause between deltas
 * @param {string} [opts.requireKey] reject requests without this bearer key
 * @param {Array} [opts.replies]    queue of scripted replies, one per request; each is
 *   { chunks: [...] } or { toolCalls: [{ name, arguments }] }. When empty, `chunks` is used.
 */
export async function startMockModel(opts = {}) {
	const state = { chunks: ['Hello', ' from the', ' mock model.'], delayMs: 0, requireKey: null, requests: [], replies: [], ...opts };
	const server = createServer(async (req, res) => {
		// llama.cpp answers /health without a key: 503 while loading, 200 when ready.
		if (req.url === '/health') { res.writeHead(state.loading ? 503 : 200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
		state.lastAuth = req.headers.authorization || '';
		if (state.requireKey && req.headers.authorization !== `Bearer ${state.requireKey}`) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ error: { message: 'bad key' } }));
		}
		if (req.url === '/v1/models') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ data: (state.models || ['mock-model']).map((id) => ({ id })) }));
		}
		if (req.url === '/v1/chat/completions' && req.method === 'POST') {
			let raw = '';
			for await (const c of req) raw += c;
			state.requests.push(JSON.parse(raw));
			// Like a real provider: a model name it does not offer is a 404.
			if (state.models && !state.models.includes(state.requests.at(-1).model)) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				return res.end(JSON.stringify({ error: { message: `The model \`${state.requests.at(-1).model}\` does not exist or you do not have access to it.`, code: 'model_not_found' } }));
			}
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			const reply = state.replies.shift() || { chunks: state.chunks };
			for (const [index, call] of (reply.toolCalls || []).entries()) {
				// Split the arguments in two, as real servers stream them in fragments.
				const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments);
				const half = Math.ceil(args.length / 2);
				const id = call.id || `call_${state.requests.length}_${index}`;
				res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id, type: 'function', function: { name: call.name, arguments: args.slice(0, half) } }] } }] })}\n\n`);
				res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(half) } }] } }] })}\n\n`);
			}
			for (const content of reply.chunks || []) {
				if (res.destroyed) return;
				res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
				if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
			}
			res.write('data: [DONE]\n\n');
			return res.end();
		}
		res.writeHead(404).end();
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	return {
		state,
		baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
		close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); })
	};
}

// Run directly for manual testing of the UI: node test/mock-model.js
if (import.meta.url === `file://${process.argv[1]}`) {
	const demo = [
		'<think>The user wants a quick demo. ', 'Show some Markdown.</think>',
		'Here is a **streamed** reply with a list:\n\n', '- first point\n', '- second point with `inline code`\n\n',
		'```python\n', 'def greet(name):\n', '    return f"Hello, {name}"\n', '```\n\n', 'That is the whole demo.'
	];
	const mock = await startMockModel({ chunks: demo, delayMs: Number(process.env.DELAY_MS || 120) });
	console.log(`Mock model at ${mock.baseUrl}`);
}
