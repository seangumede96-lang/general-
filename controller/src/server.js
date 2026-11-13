// HTTP server: static UI, JSON API, and one Server-Sent Events stream per open conversation.
// A turn runs detached from any browser request, so it keeps going (and is saved) when the
// phone sleeps; a reconnecting client gets a snapshot of the reply so far, then live deltas.
import { createServer } from 'node:http';
import { readFile, mkdir, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, SECRET_SETTINGS } from './db.js';
import { streamChat, listModels } from './model.js';
import { createTools } from './tools.js';
import { createVideoStudio, VideoError } from './video.js';
import { createImageStudio, ImageError } from './images.js';
import { B2Error } from './b2.js';
import { createGpuManager, GpuError, TEST_POD, MIN_VRAM, BRAIN_PRESETS, brainLabel, isUncensored } from './gpu.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const MAX_BODY = 1024 * 1024;
const MAX_STEPS = 12;
const MAX_ATTACHMENTS = 10;
const DAY_MS = 24 * 3600 * 1000;
// Types the browser may display in place. Everything else is offered as a download.
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif)|video\/|audio\/)/;
const fmtSize = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

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

function publicSettings(s) {
	const out = { ...s };
	for (const key of SECRET_SETTINGS) {
		delete out[key];
		out[`has${key[0].toUpperCase()}${key.slice(1)}`] = Boolean(s[key]);
	}
	return out;
}
const titleFrom = (text) => {
	const one = text.replace(/\s+/g, ' ').trim();
	return one.length > 48 ? `${one.slice(0, 47)}…` : one;
};

export function createApp({ dataDir, clock = Date.now, watchdogMs = 30000, maxUploadBytes = 2 * 1024 ** 3, videoPollMs = 5000, imagePollMs = 3000 }) {
	const db = openDb(dataDir);
	const uploadsDir = join(dataDir, 'uploads');
	const gpu = createGpuManager({ db, clock });
	const tools = createTools({ db, gpu, uploadsDir });
	const studio = createVideoStudio({ db, gpu, uploadsDir, clock, pollMs: videoPollMs });
	studio.recover().catch((err) => console.error('[video]', err.message));
	// A plain question-and-answer call to the brain in use, for helpers such as the prompt writer.
	const llm = async (messages) => (await complete({ messages, temperature: 0.7, signal: AbortSignal.timeout(60000) })).content.trim();
	const images = createImageStudio({ db, gpu, uploadsDir, clock, pollMs: imagePollMs, llm });
	images.recover();
	const studioCall = async (fn) => {
		try { return await fn(); }
		catch (err) {
			if (err instanceof VideoError || err instanceof ImageError) throw new HttpError(409, err.message);
			if (err instanceof B2Error) throw new HttpError(502, err.message);
			if (err instanceof GpuError) throw new HttpError(err.code === 'not_configured' ? 400 : 502, err.message);
			throw err;
		}
	};

	const removeUpload = async (u) => {
		await rm(dirname(u.path), { recursive: true, force: true });
		db.deleteUpload(u.id);
	};
	// Files that were uploaded but never sent in a message are cleared after a day.
	for (const u of db.staleUploads(Date.now() - DAY_MS)) removeUpload(u).catch(() => {});

	/** Save an uploaded file straight to disk; nothing is held in memory, so videos are fine. */
	async function receiveUpload(req, url) {
		const name = (url.searchParams.get('name') || 'file').replace(/[\\/\0]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
		const declared = Number(req.headers['content-length']);
		if (declared > maxUploadBytes) throw new HttpError(413, `That file is too large. The limit is ${fmtSize(maxUploadBytes)}.`);
		const id = randomUUID();
		const dir = join(uploadsDir, id);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const path = join(dir, name);
		let size = 0;
		try {
			await pipeline(req, async function* (source) {
				for await (const chunk of source) {
					size += chunk.length;
					if (size > maxUploadBytes) throw new HttpError(413, `That file is too large. The limit is ${fmtSize(maxUploadBytes)}.`);
					yield chunk;
				}
			}, createWriteStream(path, { mode: 0o600 }));
		} catch (err) {
			await rm(dir, { recursive: true, force: true });
			throw err instanceof HttpError ? err : new HttpError(400, 'The upload was interrupted.');
		}
		if (!size) { await rm(dir, { recursive: true, force: true }); throw new HttpError(400, 'That file is empty.'); }
		const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().slice(0, 100);
		db.insertUpload({ id, name, type, size, path, created_at: Date.now() });
		return { id, name, type, size };
	}

	/** Send an uploaded file back, with byte ranges so videos can seek. */
	async function serveUpload(req, res, id) {
		const u = db.getUpload(id);
		const info = u && await stat(u.path).catch(() => null);
		if (!info) throw new HttpError(404, 'File not found');
		const inline = INLINE_TYPES.test(u.type);
		const headers = {
			'Content-Type': inline ? u.type : 'application/octet-stream',
			'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(u.name)}`,
			// Uploaded content must never run as a page of this app.
			'Content-Security-Policy': "sandbox; default-src 'none'; media-src 'self'; img-src 'self'",
			'X-Content-Type-Options': 'nosniff',
			'Accept-Ranges': 'bytes',
			'Cache-Control': 'private, max-age=3600'
		};
		const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
		if (range && (range[1] || range[2])) {
			const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
			const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
			if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
			res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
			return pipeline(createReadStream(u.path, { start, end }), res).catch(() => {});
		}
		res.writeHead(200, { ...headers, 'Content-Length': info.size });
		return pipeline(createReadStream(u.path), res).catch(() => {});
	}
	// The watchdog stops idle and expired pods. unref: it must not keep the process alive.
	const watchdog = watchdogMs ? setInterval(() => gpu.tick().catch((err) => console.error('[gpu]', err.message)), watchdogMs) : null;
	watchdog?.unref();
	const gpuCall = async (fn) => {
		try { return await fn(); }
		catch (err) {
			if (err instanceof GpuError) throw new HttpError(err.code === 'refused' || err.code === 'invalid' ? 409 : err.code === 'not_configured' ? 400 : 502, err.message);
			throw err;
		}
	};
	/** conversationId -> { text, thinking, controller, awaiting } for a turn in flight */
	const live = new Map();
	/** conversationId -> Set<ServerResponse> of attached SSE clients */
	const subscribers = new Map();

	function broadcast(id, ev) {
		const frame = `data: ${JSON.stringify(ev)}\n\n`;
		for (const res of subscribers.get(id) || []) res.write(frame);
	}

	const NOT_CHAT = /whisper|tts|guard|embed|rerank|moderation|orpheus|playai|safeguard|compound/i;
	/** From an endpoint's model list, the one most likely to be a capable chat model. */
	function pickChatModel(models) {
		const usable = models.filter((m) => !NOT_CHAT.test(m));
		const prefer = [/70b|120b/i, /qwen|kimi|gpt-oss|llama-4|maverick/i, /llama/i];
		for (const re of prefer) { const hit = usable.find((m) => re.test(m)); if (hit) return hit; }
		return usable[0] || null;
	}

	async function resolveModel(settings, signal) {
		if (settings.model) return settings.model;
		const model = pickChatModel(await listModels({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, signal }));
		if (!model) throw new Error('The model endpoint lists no chat models. Set a model name in Settings.');
		return model;
	}

	/**
	 * One model call, sent to whichever brain is in use. While the private brain is up, chat
	 * goes there (and counts as activity, so it is not shut down for idling). Otherwise the
	 * everyday endpoint is used; if its saved model name no longer exists, a working one is
	 * chosen from the endpoint's list, saved, and the call is retried once.
	 */
	async function complete(request) {
		const settings = db.getSettings();
		const brain = settings.chatBrain === 'everyday' ? null : gpu.brainEndpoint();
		if (brain) gpu.touch(brain.podId);
		const call = (target) => streamChat({ ...request, baseUrl: target.baseUrl, apiKey: target.apiKey, model: target.model, temperature: request.temperature ?? Number.parseFloat(settings.temperature) });
		if (brain) return call(brain);
		const everyday = { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: await resolveModel(settings, request.signal) };
		try { return await call(everyday); }
		catch (err) {
			if (!settings.model || !/HTTP 404|model_not_found|does not exist|decommissioned/i.test(err.message)) throw err;
			const replacement = pickChatModel(await listModels({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, signal: request.signal }).catch(() => []));
			if (!replacement || replacement === settings.model) throw err;
			db.setSettings({ model: replacement });
			return call({ ...everyday, model: replacement });
		}
	}

	/** Stop a turn: abort the model request and answer any open approval prompt with "deny". */
	function cancelTurn(turn) {
		turn.controller.abort();
		for (const resolve of turn.awaiting.values()) resolve('deny');
	}

	/**
	 * Rebuild the chat-completions history from saved rows. Every tool call must be followed
	 * by a result or the endpoint rejects the request, so calls left unanswered by a crash or
	 * a stop get a synthetic "interrupted" result here.
	 */
	function buildHistory(id, settings) {
		const out = [];
		const system = [settings.systemPrompt, `Today is ${new Date().toISOString().slice(0, 10)}. You can call tools; use one when it helps and answer directly when it does not. If a tool reports an error, read it and correct the call.`].filter(Boolean).join('\n\n');
		out.push({ role: 'system', content: system });
		let open = [];
		const closeOpen = () => {
			for (const callId of open) out.push({ role: 'tool', tool_call_id: callId, content: 'No result: the action was interrupted.' });
			open = [];
		};
		for (const m of db.listMessages(id)) {
			if (m.role === 'tool') {
				if (!open.includes(m.tool_call_id)) continue;
				open = open.filter((c) => c !== m.tool_call_id);
				out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
				continue;
			}
			closeOpen();
			if (m.role === 'user') {
				// The model cannot see the files themselves; it is told what they are and where
				// they are saved, so tools can work with them.
				const files = m.attachments ? JSON.parse(m.attachments) : [];
				const note = files.map((f) => `- ${f.name} (${f.type}, ${fmtSize(f.size)}) saved at ${db.getUpload(f.id)?.path || 'a file that has since been removed'}`).join('\n');
				out.push({ role: 'user', content: [m.content, note && `[The user attached ${files.length === 1 ? 'a file' : `${files.length} files`}]\n${note}`].filter(Boolean).join('\n\n') });
			}
			if (m.role !== 'assistant') continue;
			const calls = m.tool_calls ? JSON.parse(m.tool_calls) : [];
			if (!m.content && !calls.length) continue;
			const msg = { role: 'assistant', content: m.content || null };
			if (calls.length) {
				msg.tool_calls = calls.map((c) => {
					let args = c.arguments || '{}';
					try { JSON.parse(args); } catch { args = '{}'; }
					return { id: c.id, type: 'function', function: { name: c.name, arguments: args } };
				});
				open = calls.map((c) => c.id);
			}
			out.push(msg);
		}
		closeOpen();
		return out;
	}

	/** Validate one proposed tool call, ask for approval if it is risky, then run it. */
	async function executeCall(id, turn, call) {
		const cancelled = { status: 'error', output: 'Cancelled by the user.' };
		const prep = tools.prepare(call.name, call.arguments);
		if (prep.error) return { status: 'error', output: prep.error };
		if (turn.controller.signal.aborted) return cancelled;
		if (prep.tool.risk === 'danger') {
			// A tool may refuse outright or add a note (such as a price) before the user is asked.
			let note = '';
			if (prep.tool.preview) {
				const preview = await prep.tool.preview(prep.args).catch((err) => ({ refuse: err.message }));
				if (preview.refuse) return { status: 'error', output: preview.refuse };
				note = preview.note || '';
			}
			if (turn.controller.signal.aborted) return cancelled;
			const decision = await new Promise((resolve) => {
				turn.awaiting.set(call.id, resolve);
				turn.notes.set(call.id, note);
				broadcast(id, { t: 'approval', id: call.id, waiting: true, note });
			});
			turn.awaiting.delete(call.id);
			turn.notes.delete(call.id);
			broadcast(id, { t: 'approval', id: call.id, waiting: false });
			if (turn.controller.signal.aborted) return cancelled;
			if (decision !== 'allow') return { status: 'denied', output: 'The user declined this action. Do not try it again unless they ask.' };
		}
		const result = await tools.run(prep.tool, prep.args);
		return { status: result.ok ? 'ok' : 'error', output: result.output };
	}

	async function runTurn(id) {
		const turn = { text: '', thinking: '', controller: new AbortController(), awaiting: new Map(), notes: new Map() };
		const { signal } = turn.controller;
		live.set(id, turn);
		broadcast(id, { t: 'turn', phase: 'start' });
		const settings = db.getSettings();
		// Save a message and show it to attached clients, unless the conversation was deleted.
		const save = (m) => {
			if (!db.getConversation(id)) return;
			turn.text = '';
			turn.thinking = '';
			broadcast(id, { t: 'message', message: db.addMessage(id, m) });
		};
		let status = 'ok';
		try {
			for (let step = 0; ; step++) {
				if (step >= MAX_STEPS) throw new Error(`Stopped after ${MAX_STEPS} tool steps without finishing. Ask me to continue if the task needs more.`);
				const result = await complete({
					messages: buildHistory(id, settings),
					tools: tools.definitions(),
					signal,
					onText: (s) => { turn.text += s; broadcast(id, { t: 'text', text: s }); },
					onThinking: (s) => { turn.thinking += s; broadcast(id, { t: 'thinking', text: s }); }
				});
				if (result.content || result.reasoning || result.toolCalls.length) {
					save({ role: 'assistant', content: result.content, reasoning: result.reasoning, toolCalls: result.toolCalls });
				}
				if (!result.toolCalls.length) break;
				for (const call of result.toolCalls) {
					const outcome = await executeCall(id, turn, call);
					save({ role: 'tool', content: outcome.output, status: outcome.status, toolCallId: call.id, toolName: call.name });
				}
				signal.throwIfAborted();
			}
		} catch (err) {
			status = signal.aborted ? 'stopped' : 'error';
			if (status === 'error') turn.error = describeError(err, gpu.brainEndpoint() || settings);
		}
		// Persist whatever arrived, even on stop/failure, so nothing the user saw is lost.
		if (turn.text || turn.thinking) save({ role: 'assistant', content: turn.text, reasoning: turn.thinking, status });
		if (turn.error) save({ role: 'error', content: turn.error, status: 'error' });
		live.delete(id);
		broadcast(id, { t: 'turn', phase: 'end', status });
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
			if (live.has(id)) cancelTurn(live.get(id));
			for (const u of db.uploadsOf(id)) removeUpload(u).catch(() => {});
			db.deleteConversation(id);
			return { ok: true };
		}],
		['POST', /^\/api\/conversations\/([\w-]+)\/messages$/, async (req, id) => {
			const conversation = mustGet(id);
			const { text = '', attachments = [] } = await readJson(req);
			if (typeof text !== 'string' || !Array.isArray(attachments)) throw new HttpError(400, 'text must be a string and attachments a list');
			if (!text.trim() && !attachments.length) throw new HttpError(400, 'Write a message or attach a file');
			if (attachments.length > MAX_ATTACHMENTS) throw new HttpError(400, `At most ${MAX_ATTACHMENTS} files per message`);
			if (live.has(id)) throw new HttpError(409, 'A reply is already being generated');
			const files = attachments.map((uploadId) => {
				const u = typeof uploadId === 'string' && db.getUpload(uploadId);
				// Each upload belongs to exactly one message; an id cannot be reused elsewhere.
				if (!u || !db.claimUpload(u.id, id)) throw new HttpError(400, 'An attached file is missing or was already sent');
				return { id: u.id, name: u.name, type: u.type, size: u.size };
			});
			const message = db.addMessage(id, { role: 'user', content: text, attachments: files });
			broadcast(id, { t: 'user', message });
			if (!conversation.title) {
				const title = titleFrom(text.trim() || files.map((f) => f.name).join(', '));
				db.setTitle(id, title);
				broadcast(id, { t: 'title', title });
			}
			runTurn(id).catch((err) => console.error('[turn]', err));
			return { message };
		}],
		['POST', /^\/api\/conversations\/([\w-]+)\/stop$/, (_req, id) => {
			mustGet(id);
			if (live.has(id)) cancelTurn(live.get(id));
			return { ok: true };
		}],
		['POST', /^\/api\/conversations\/([\w-]+)\/approvals\/([\w.:-]+)$/, async (req, id, callId) => {
			mustGet(id);
			const { decision } = await readJson(req);
			if (decision !== 'allow' && decision !== 'deny') throw new HttpError(400, 'decision must be "allow" or "deny"');
			const resolve = live.get(id)?.awaiting.get(callId);
			if (!resolve) throw new HttpError(404, 'That request is no longer waiting for approval');
			resolve(decision);
			return { ok: true };
		}],
		['GET', /^\/api\/settings$/, () => publicSettings(db.getSettings())],
		['PUT', /^\/api\/settings$/, async (req) => {
			const patch = await readJson(req);
			// An empty secret means "leave the saved one alone"; clear<Name> removes it.
			for (const key of SECRET_SETTINGS) {
				if (patch[key] === '') delete patch[key];
				if (patch[`clear${key[0].toUpperCase()}${key.slice(1)}`]) patch[key] = '';
			}
			db.setSettings(patch);
			return publicSettings(db.getSettings());
		}],
		['GET', /^\/api\/images$/, () => images.status()],
		['POST', /^\/api\/images\/quote$/, async (req) => studioCall(async () => images.quote((await readJson(req)).minutes))],
		['POST', /^\/api\/images\/session$/, async (req) => studioCall(async () => ({ podId: await images.start(await readJson(req)) }))],
		['DELETE', /^\/api\/images\/session$/, async () => { await gpuCall(() => images.stop()); return { ok: true }; }],
		['POST', /^\/api\/images\/generate$/, async (req) => studioCall(async () => images.generate(await readJson(req)))],
		['DELETE', /^\/api\/images\/([\w-]+)$/, async (_req, genId) => {
			if (!await images.remove(genId)) throw new HttpError(404, 'Not found, or still being made');
			return { ok: true };
		}],
		['GET', /^\/api\/video$/, () => ({ jobs: studio.list(), limits: studio.limits() })],
		['POST', /^\/api\/video\/quote$/, async (req) => studioCall(async () => studio.quote(await readJson(req)))],
		['POST', /^\/api\/video\/jobs$/, async (req) => studioCall(async () => studio.create(await readJson(req)))],
		['POST', /^\/api\/video\/jobs\/([\w-]+)\/cancel$/, (_req, jobId) => {
			const job = studio.cancel(jobId);
			if (!job) throw new HttpError(404, 'Job not found');
			return job;
		}],
		// Everything the chat's model picker needs: what is in use, and what can be chosen.
		['GET', /^\/api\/brains$/, async () => {
			await gpu.probeBrain().catch(() => {});
			const s = db.getSettings();
			const pod = gpu.brainPod();
			const state = !pod ? 'off' : pod.ready_at ? 'ready' : 'starting';
			let host = '';
			try { host = new URL(s.baseUrl).hostname; } catch { /* not a URL yet */ }
			return {
				chatBrain: s.chatBrain === 'everyday' ? 'everyday' : 'private',
				using: s.chatBrain !== 'everyday' && state === 'ready' ? 'private' : 'everyday',
				everyday: { model: s.model, host, hasKey: Boolean(s.apiKey) },
				private: {
					state, podId: pod?.id || null,
					// For the progress display while it turns on.
					startedAt: pod?.created_at || null, stage: state === 'starting' ? gpu.brainStage() : state, gpu: pod?.gpu || '', rate: pod?.rate || 0,
					// While a brain is up, "model" is the one it was started with, whatever is selected now.
					model: pod?.model || s.brainModel, label: brainLabel(pod?.model || s.brainModel),
					uncensored: isUncensored(pod?.model || s.brainModel),
					selected: s.brainModel, presets: BRAIN_PRESETS
				}
			};
		}],
		['GET', /^\/api\/system$/, () => gpu.status()],
		['POST', /^\/api\/system\/quote$/, async (req) => {
			const { minutes, kind = 'test' } = await readJson(req);
			if (!(kind in MIN_VRAM)) throw new HttpError(400, 'kind must be "test" or "brain"');
			return gpuCall(() => gpu.quote({ minutes, minVram: MIN_VRAM[kind] }));
		}],
		// Starting a pod spends money, so the caller must echo back the estimate it was shown.
		['POST', /^\/api\/system\/pods$/, async (req) => {
			const { minutes, confirmEstimate, kind = 'test', model } = await readJson(req);
			// A brain is started with the model the caller names, so the pod matches the price that was confirmed.
			if (kind === 'brain' && typeof model === 'string' && model) db.setSettings({ brainModel: model });
			if (!(kind in MIN_VRAM)) throw new HttpError(400, 'kind must be "test" or "brain"');
			const minVram = MIN_VRAM[kind];
			return gpuCall(async () => {
				const spec = kind === 'brain' ? gpu.brainSpec() : TEST_POD;
				const q = await gpu.quote({ minutes, minVram });
				if (!q.allowed) throw new GpuError(q.reason, 'refused');
				if (confirmEstimate !== q.estimate) throw new GpuError(`The price changed to ${q.estimate.toFixed(2)} USD. Review the new quote and confirm again.`, 'refused');
				const { secret, ...pod } = await gpu.start({ minutes, minVram, purpose: kind === 'brain' ? `Private brain · ${brainLabel(spec.model)}${isUncensored(spec.model) ? ' (uncensored)' : ''}` : 'Test pod', spec });
				return pod;
			});
		}],
		['DELETE', /^\/api\/system\/pods\/([\w-]+)$/, async (_req, podId) => {
			await gpuCall(() => gpu.stop(podId, 'stopped by you'));
			return { ok: true };
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
		res.write(`data: ${JSON.stringify({ t: 'snapshot', working: Boolean(turn), text: turn?.text || '', thinking: turn?.thinking || '', awaiting: [...(turn?.awaiting.keys() || [])].map((callId) => ({ id: callId, note: turn.notes.get(callId) || '' })), messages: db.listMessages(id) })}\n\n`);
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
		res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...(rel.endsWith('sw.js') ? { 'Service-Worker-Allowed': '/' } : {}) });
		res.end(body);
	}

	async function handle(req, res) {
		const url = new URL(req.url, 'http://local');
		// Block cross-site requests: a page on another origin must not drive this API.
		const origin = req.headers.origin;
		if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused');

		const ev = url.pathname.match(/^\/api\/conversations\/([\w-]+)\/events$/);
		if (ev && req.method === 'GET') return attachEvents(req, res, ev[1]);

		if (url.pathname === '/api/uploads' && req.method === 'POST') {
			const out = await receiveUpload(req, url);
			res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			return res.end(JSON.stringify(out));
		}
		const up = url.pathname.match(/^\/api\/uploads\/([\w-]+)$/);
		if (up && req.method === 'GET') return serveUpload(req, res, up[1]);

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
		gpu, studio, images,
		async close() {
			clearInterval(watchdog);
			await studio.shutdown();
			for (const turn of live.values()) cancelTurn(turn);
			for (const set of subscribers.values()) for (const res of set) res.end();
			server.closeAllConnections?.();
			await new Promise((r) => server.close(r));
			// Let aborted turns finish their final write before the database goes away.
			for (let i = 0; i < 50 && live.size; i++) await new Promise((r) => setTimeout(r, 10));
			db.close();
		}
	};
}
