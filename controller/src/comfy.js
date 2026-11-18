// A small client for ComfyUI's HTTP API on a pod: wait for it, upload inputs, queue a
// workflow, wait for the result, download it. Nothing here knows about any particular model.
import { openAsBlob, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export class ComfyError extends Error {}

/** Waits between retries after a dropped connection (phone networks drop briefly). */
const RETRY_DELAYS_MS = [2000, 5000, 10000, 20000];

export function createComfyClient(baseUrl, { retryDelaysMs = RETRY_DELAYS_MS } = {}) {
	const base = baseUrl.replace(/\/+$/, '');

	async function call(path, init = {}, timeoutMs = 30000, retries = retryDelaysMs) {
		for (let attempt = 0; ; attempt++) {
			try { return await fetch(base + path, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
			catch (err) {
				if (attempt < retries.length) { await new Promise((r) => setTimeout(r, retries[attempt])); continue; }
				throw new ComfyError(`Could not reach the video engine (${err?.cause?.code || err.name}), after ${retries.length + 1} tries.`);
			}
		}
	}

	return {
		/** True once ComfyUI answers. While the pod is still downloading models it does not. */
		async ready() {
			try { return (await call('/system_stats', {}, 8000, [])).ok; } catch { return false; }
		},

		/** Upload a file into ComfyUI's input folder; returns the name to use in a workflow. */
		async upload(path, name, type) {
			const form = new FormData();
			form.set('image', new File([await openAsBlob(path)], name, { type }));
			form.set('type', 'input');
			form.set('overwrite', 'true');
			const res = await call('/upload/image', { method: 'POST', body: form }, 10 * 60000);
			if (!res.ok) throw new ComfyError(`The video engine refused the upload of ${name} (HTTP ${res.status}).`);
			const body = await res.json();
			return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
		},

		/** Queue a workflow; returns its id. Validation errors come back in plain words. */
		async queue(prompt, clientId) {
			const res = await call('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, client_id: clientId }) });
			const body = await res.json().catch(() => ({}));
			if (!res.ok || !body.prompt_id) {
				const nodeErrors = Object.values(body.node_errors || {}).flatMap((n) => (n.errors || []).map((e) => `${n.class_type}: ${e.message}${e.details ? ` (${e.details})` : ''}`));
				throw new ComfyError(`The video engine rejected the workflow: ${nodeErrors.slice(0, 3).join('; ') || body.error?.message || `HTTP ${res.status}`}`);
			}
			return body.prompt_id;
		},

		/**
		 * Look up a queued workflow. Returns { done: false } while it runs, or
		 * { done: true, files: [{ filename, subfolder, type }] } / throws if it failed.
		 */
		async result(promptId) {
			const res = await call(`/history/${encodeURIComponent(promptId)}`);
			if (!res.ok) throw new ComfyError(`The video engine stopped answering (HTTP ${res.status}).`);
			const entry = (await res.json())[promptId];
			if (!entry) return { done: false };
			if (entry.status?.status_str === 'error') {
				const msg = (entry.status.messages || []).find((m) => m[0] === 'execution_error')?.[1];
				throw new ComfyError(`Generation failed${msg ? ` in ${msg.node_type}: ${String(msg.exception_message).trim().slice(0, 300)}` : '.'}`);
			}
			if (!entry.status?.completed) return { done: false };
			// Images, videos and animated outputs are reported under different keys by different nodes.
			const files = Object.values(entry.outputs || {}).flatMap((o) => [...(o.videos || []), ...(o.gifs || []), ...(o.images || [])]);
			return { done: true, files };
		},

		/**
		 * Listen to the engine's live messages for one client (which node is running, sampler
		 * steps). Best effort: if the socket cannot open or drops, progress simply stops updating;
		 * the job itself is still followed through the history. Returns a function that stops.
		 */
		watch(clientId, onMessage) {
			let ws;
			let closed = false;
			const open = () => {
				if (closed || typeof WebSocket !== 'function') return;
				try { ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`); } catch { return; }
				ws.onmessage = (e) => { if (typeof e.data !== 'string') return; try { onMessage(JSON.parse(e.data)); } catch { /* not ours */ } };
				ws.onerror = () => {};
				ws.onclose = () => { if (!closed) setTimeout(open, 3000); }; // reconnect through dropouts
			};
			open();
			return () => { closed = true; try { ws?.close(); } catch { /* already closed */ } };
		},

		/** Whether the engine still holds this job: running or waiting in its queue. */
		async inQueue(promptId) {
			const res = await call('/queue');
			if (!res.ok) throw new ComfyError(`The engine stopped answering (HTTP ${res.status}).`);
			const q = await res.json();
			return [...(q.queue_running || []), ...(q.queue_pending || [])].some((item) => item[1] === promptId);
		},

		/** Download an output file to disk. Returns the number of bytes written. */
		async download(file, destination) {
			const qs = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
			const res = await call(`/view?${qs}`, {}, 10 * 60000);
			if (!res.ok || !res.body) throw new ComfyError(`Could not fetch the finished video (HTTP ${res.status}).`);
			let size = 0;
			await pipeline(Readable.fromWeb(res.body), async function* (src) { for await (const c of src) { size += c.length; yield c; } }, createWriteStream(destination, { mode: 0o600 }));
			return { size, type: res.headers.get('content-type') || 'video/mp4' };
		}
	};
}
