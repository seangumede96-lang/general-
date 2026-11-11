// A stand-in for RunPod REST API v2, shaped after the published reference:
// catalog, create, get, list (paginated wrapper), delete (204), pod billing, problem+json errors.
import { createServer } from 'node:http';

export async function startMockRunpod(opts = {}) {
	const state = {
		key: 'rp-test-key',
		gpus: [
			{ id: 'NVIDIA GeForce RTX 3090', name: 'RTX 3090', memory: 24, secure: true, community: true, price: { secure: 0.43, community: 0.22 }, availability: 'HIGH' },
			{ id: 'NVIDIA GeForce RTX 4090', name: 'RTX 4090', memory: 24, secure: true, community: true, price: { secure: 0.69, community: 0.34 }, availability: 'MEDIUM' },
			{ id: 'NVIDIA RTX A4000', name: 'RTX A4000', memory: 16, secure: true, community: true, price: { secure: 0.25, community: 0.17 }, availability: 'HIGH' },
			{ id: 'NVIDIA RTX A6000', name: 'RTX A6000', memory: 48, secure: true, community: true, price: { secure: 0.49, community: 0.33 }, availability: 'NONE' }
		],
		noCapacity: new Set(),   // gpu ids whose create fails with 400
		insufficientBalance: false,
		pods: new Map(),
		billing: new Map(),      // podId -> totalAmount
		created: [],             // request bodies, in order
		deleted: [],
		seq: 0,                  // pod ids are pod1, pod2, ...
		...opts
	};
	const problem = (res, status, detail) => {
		res.writeHead(status, { 'Content-Type': 'application/problem+json' });
		res.end(JSON.stringify({ title: 'Error', status, detail }));
	};
	const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

	const server = createServer(async (req, res) => {
		const url = new URL(req.url, 'http://x');
		if (req.headers.authorization !== `Bearer ${state.key}`) return problem(res, 401, 'missing bearer token');
		const path = url.pathname.replace(/^\/v2/, '');
		let raw = '';
		for await (const c of req) raw += c;

		if (req.method === 'GET' && path === '/catalog/gpus') return json(res, 200, { gpus: state.gpus });
		if (req.method === 'POST' && path === '/pods') {
			const body = JSON.parse(raw);
			state.created.push(body);
			if (state.insufficientBalance) return problem(res, 402, 'insufficient balance');
			if (state.noCapacity.has(body.gpu.id)) return problem(res, 400, 'pod could not be placed');
			const gpu = state.gpus.find((g) => g.id === body.gpu.id);
			const pod = { id: `pod${++state.seq}`, name: body.name, image: body.image, status: 'RUNNING', cloud: body.cloud, gpu: { id: gpu.id, count: 1 }, cost: gpu.price[body.cloud.toLowerCase()] };
			state.pods.set(pod.id, pod);
			return json(res, 201, pod);
		}
		if (req.method === 'GET' && path === '/pods') return json(res, 200, { pods: [...state.pods.values()], pagination: { nextCursor: null, hasNextPage: false } });
		if (req.method === 'GET' && path === '/billing/pods') {
			const total = state.billing.get(url.searchParams.get('podId')) ?? 0;
			return json(res, 200, { records: [], metadata: { totals: { totalAmount: total } } });
		}
		const one = path.match(/^\/pods\/([\w-]+)$/);
		if (one) {
			const pod = state.pods.get(one[1]);
			if (!pod || pod.status === 'TERMINATED') return problem(res, 404, 'pod not found');
			if (req.method === 'GET') return json(res, 200, pod);
			if (req.method === 'DELETE') { pod.status = 'TERMINATED'; state.deleted.push(pod.id); res.writeHead(204); return res.end(); }
		}
		return problem(res, 404, 'not found');
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	return {
		state,
		baseUrl: `http://127.0.0.1:${server.address().port}/v2`,
		close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); })
	};
}
