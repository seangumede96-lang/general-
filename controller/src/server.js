// HTTP server: static UI, JSON API, and one Server-Sent Events stream per open conversation.
// A turn runs detached from any browser request, so it keeps going (and is saved) when the
// phone sleeps; a reconnecting client gets a snapshot of the reply so far, then live deltas.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { streamChat, listModels } from './model.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_BODY = 1024 * 1024;

class HttpError extends Error {
	constructor(status, message) { super(message); this.status = status; }
}

async function readJson(req) {
	if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Expected application/json');
	let size = 0;
	const chunks = [];
	for await (const c of req) {
		size += c.length;
		if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
		chunks.push(c);
	}
	try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
	catch { throw new HttpError(400, 'Invalid JSON'); }
}

const publicSettings = (s) => ({ ...s, apiKey: undefined, hasApiKey: Boolean(s.apiKey) });
const titleFrom = (text) => {
	const one = text.replace(/\s+/g, ' ').trim();
	return one.length > 48 ? `${one.slice(0, 47)}…` : one;
};

export function createApp({ dataDir }) {
	const db = openDb(dataDir);
	/** conversationId -> { text, thinking, controller } for a turn in flight */
	const live = new Map();
	/** conversationId -> Set<ServerResponse> of attached SSE clients */
	const subscribers = new Map();

	function broadcast(id, ev) {
		const frame = `data: ${JSON.stringify(ev)}\n\n`;
		for (const res of subscribers.get(id) || []) res.write(frame);
	}

	async function resolveModel(settings, signal) {
		if (settings.model) return settings.model;
		const models = await listModels({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, signal });
		if (!models.length) throw new Error('The model endpoint lists no models. Set a model name in Settings.');
		return models[0];
	}

	async function runTurn(id) {
		const turn = { text: '', thinking: '', controller: new AbortController() };
		live.set(id, turn);
		broadcast(id, { t: 'turn', phase: 'start' });
		const settings = db.getSettings();
		let status = 'ok';
		try {
			const history = db.listMessages(id)
				.filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
				.map((m) => ({ role: m.role, content: m.content }));
			const messages = settings.systemPrompt
				? [{ role: 'system', content: settings.systemPrompt }, ...history]
				: history;
			await streamChat({
				baseUrl: settings.baseUrl,
				apiKey: settings.apiKey,
				model: await resolveModel(settings, turn.controller.signal),
				messages,
				temperature: Number.parseFloat(settings.temperature),
				signal: turn.controller.signal,
				onText: (s) => { turn.text += s; broadcast(id, { t: 'text', text: s }); },
				onThinking: (s) => { turn.thinking += s; broadcast(id, { t: 'thinking', text: s }); }
			});
		} catch (err) {
			status = turn.controller.signal.aborted ? 'stopped' : 'error';
			if (status === 'error') turn.error = describeError(err, settings);
		}
		// Persist whatever arrived, even on stop/failure, so nothing the user saw is lost.
		const saved = [];
		if (db.getConversation(id)) {
			if (turn.text || turn.thinking) {
				saved.push(db.addMessage(id, { role: 'assistant', content: turn.text, reasoning: turn.thinking, status }));
			}
			if (turn.error) saved.push(db.addMessage(id, { role: 'error', content: turn.error, status: 'error' }));
		}
		live.delete(id);
		broadcast(id, { t: 'turn', phase: 'end', status, messages: saved });
	}

	function describeError(err, settings) {
		const cause = err?.cause?.code || err?.cause?.message;
		if (err?.message === 'fetch failed') {
			return `Could not reach the model endpoint at ${settings.baseUrl}${cause ? ` (${cause})` : ''}. Check that it is running and the address in Settings is right.`;
		}
		return err?.message || 'The model request failed.';
	}

	const routes = [
		['GET', /^\/api\/conversations$/, () => ({ conversations: db.listConversations() })],
		['POST', /^\/api\/conversations$/, () => db.createConversation()],
		['GET', /^\/api\/conversations\/([\w-]+)$/, (_req, id) => {
			const conversation = mustGet(id);
			return { conversation, messages: db.listMessages(id), working: live.has(id) };
		}],
		['PATCH', /^\/api\/conversations\/([\w-]+)$/, async (req, id) => {
			mustGet(id);
			const { title } = await readJson(req);
			if (typeof title !== 'string' || !title.trim()) throw new HttpError(400, 'title is required');
			db.setTitle(id, title.trim().slice(0, 200));
			return db.getConversation(id);
		}],
		['DELETE', /^\/api\/conversations\/([\w-]+)$/, (_req, id) => {
			mustGet(id);
			live.get(id)?.controller.abort();
			db.deleteConversation(id);
			return { ok: true };
		}],
		['POST', /^\/api\/conversations\/([\w-]+)\/messages$/, async (req, id) => {
			const conversation = mustGet(id);
			const { text } = await readJson(req);
			if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'text is required');
			if (live.has(id)) throw new HttpError(409, 'A reply is already being generated');
			const message = db.addMessage(id, { role: 'user', content: text });
			broadcast(id, { t: 'user', message });
			if (!conversation.title) {
				const title = titleFrom(text);
				db.setTitle(id, title);
				broadcast(id, { t: 'title', title });
			}
			runTurn(id).catch((err) => console.error('[turn]', err));
			return { message };
		}],
		['POST', /^\/api\/conversations\/([\w-]+)\/stop$/, (_req, id) => {
			mustGet(id);
			live.get(id)?.controller.abort();
			return { ok: true };
		}],
		['GET', /^\/api\/settings$/, () => publicSettings(db.getSettings())],
		['PUT', /^\/api\/settings$/, async (req) => {
			const patch = await readJson(req);
			// An empty apiKey means "leave the saved key alone"; clearApiKey removes it.
			if (patch.apiKey === '') delete patch.apiKey;
			if (patch.clearApiKey) patch.apiKey = '';
			db.setSettings(patch);
			return publicSettings(db.getSettings());
		}],
		['GET', /^\/api\/models$/, async () => {
			const s = db.getSettings();
			try { return { models: await listModels({ baseUrl: s.baseUrl, apiKey: s.apiKey, signal: AbortSignal.timeout(8000) }) }; }
			catch (err) { throw new HttpError(502, describeError(err, s)); }
		}]
	];

	function mustGet(id) {
		const c = db.getConversation(id);
		if (!c) throw new HttpError(404, 'Conversation not found');
		return c;
	}

	function attachEvents(req, res, id) {
		mustGet(id);
		res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
		const turn = live.get(id);
		res.write(`data: ${JSON.stringify({ t: 'snapshot', working: Boolean(turn), text: turn?.text || '', thinking: turn?.thinking || '', messages: db.listMessages(id) })}\n\n`);
		if (!subscribers.has(id)) subscribers.set(id, new Set());
		subscribers.get(id).add(res);
		const ping = setInterval(() => res.write(': ping\n\n'), 20000);
		req.on('close', () => {
			clearInterval(ping);
			subscribers.get(id)?.delete(res);
			if (!subscribers.get(id)?.size) subscribers.delete(id);
		});
	}

	async function serveStatic(pathname, res) {
		const rel = normalize(pathname === '/' ? '/index.html' : pathname);
		const file = join(PUBLIC_DIR, rel);
		if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(403, 'Forbidden');
		let body;
		try { body = await readFile(file); } catch { throw new HttpError(404, 'Not found'); }
		res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
		res.end(body);
	}

	async function handle(req, res) {
		const url = new URL(req.url, 'http://local');
		// Block cross-site requests: a page on another origin must not drive this API.
		const origin = req.headers.origin;
		if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused');

		const ev = url.pathname.match(/^\/api\/conversations\/([\w-]+)\/events$/);
		if (ev && req.method === 'GET') return attachEvents(req, res, ev[1]);

		if (url.pathname.startsWith('/api/')) {
			for (const [method, pattern, fn] of routes) {
				const m = req.method === method && url.pathname.match(pattern);
				if (!m) continue;
				const out = await fn(req, ...m.slice(1));
				res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
				return res.end(JSON.stringify(out));
			}
			throw new HttpError(404, 'Not found');
		}
		if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
		return serveStatic(url.pathname, res);
	}

	const server = createServer((req, res) => {
		handle(req, res).catch((err) => {
			const status = err instanceof HttpError ? err.status : 500;
			if (status === 500) console.error('[http]', err);
			if (res.headersSent) return res.end();
			res.writeHead(status, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: status === 500 ? 'Internal error' : err.message }));
		});
	});

	return {
		server,
		listen: (port, host) => new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, host, () => resolve(server.address()));
		}),
		async close() {
			for (const turn of live.values()) turn.controller.abort();
			for (const set of subscribers.values()) for (const res of set) res.end();
			server.closeAllConnections?.();
			await new Promise((r) => server.close(r));
			// Let aborted turns finish their final write before the database goes away.
			for (let i = 0; i < 50 && live.size; i++) await new Promise((r) => setTimeout(r, 10));
			db.close();
		}
	};
}
