// A stand-in for the pod during a video job: the setup log on one port, ComfyUI's HTTP API
// on another (here both on one server), plus the workflow file the controller downloads.
import { createServer } from 'node:http';

export const TEMPLATE = {
	'27': { class_type: 'WanVideoSampler', inputs: { steps: 4, cfg: 1, seed: 42 } },
	'30': { class_type: 'VHS_VideoCombine', inputs: { frame_rate: 16, save_output: false, filename_prefix: 'Wanimate' } },
	'57': { class_type: 'LoadImage', inputs: { image: 'example.jpg' } },
	'63': { class_type: 'VHS_LoadVideo', inputs: { video: 'example.mp4', force_rate: 16, frame_load_cap: 0 } },
	'65': { class_type: 'WanVideoTextEncodeCached', inputs: { positive_prompt: 'example', negative_prompt: 'bad' } },
	'150': { class_type: 'INTConstant', inputs: { value: 1280 } },
	'151': { class_type: 'INTConstant', inputs: { value: 720 } }
};

export async function startMockComfy(opts = {}) {
	const state = {
		ready: true,
		setupLog: 'STEP 1/4 Installing the video engine\nSTEP 3/4 Downloading models\n',
		pollsUntilDone: 2,     // how many /history checks return "still running"
		outcome: 'ok',         // ok | reject (workflow refused) | error (fails while generating) | empty (no output)
		template: TEMPLATE,
		uploads: [], prompts: [], historyChecks: 0,
		...opts
	};
	const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
	const server = createServer(async (req, res) => {
		const url = new URL(req.url, 'http://x');
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = Buffer.concat(chunks);

		if (url.pathname === '/workflow.json') return json(res, 200, state.template);
		if (url.pathname === '/setup.log') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(state.setupLog); }
		if (url.pathname === '/system_stats') return state.ready ? json(res, 200, { system: {} }) : json(res, 502, {});
		if (url.pathname === '/upload/image' && req.method === 'POST') {
			const name = /filename="([^"]+)"/.exec(body.toString('latin1'))?.[1] || 'file';
			state.uploads.push({ name, bytes: body.length });
			return json(res, 200, { name, subfolder: '', type: 'input' });
		}
		if (url.pathname === '/prompt' && req.method === 'POST') {
			const sent = JSON.parse(body.toString());
			state.prompts.push(sent);
			if (state.outcome === 'reject') return json(res, 400, { error: { message: 'invalid prompt' }, node_errors: { '63': { class_type: 'VHS_LoadVideo', errors: [{ message: 'Invalid video file', details: 'in.mp4' }] } } });
			return json(res, 200, { prompt_id: 'p1', number: 1 });
		}
		if (url.pathname === '/history/p1') {
			if (++state.historyChecks <= state.pollsUntilDone) return json(res, 200, {});
			if (state.outcome === 'error') return json(res, 200, { p1: { status: { status_str: 'error', completed: false, messages: [['execution_error', { node_type: 'WanVideoSampler', exception_message: 'CUDA out of memory' }]] }, outputs: {} } });
			const outputs = state.outcome === 'empty' ? {} : { '30': { gifs: [{ filename: 'assistant_00001.mp4', subfolder: '', type: 'output', format: 'video/h264-mp4' }] } };
			return json(res, 200, { p1: { status: { status_str: 'success', completed: true }, outputs } });
		}
		if (url.pathname === '/view') { res.writeHead(200, { 'Content-Type': 'video/mp4' }); return res.end('RESULT-VIDEO-BYTES'); }
		res.writeHead(404).end();
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	return { state, baseUrl, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
