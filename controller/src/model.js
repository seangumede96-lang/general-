// Streaming client for any OpenAI-compatible /chat/completions endpoint (vLLM, llama.cpp,
// Ollama, OpenRouter, ...). Approach adapted from CodeOut's openrouter-chat.js (MIT, C9RE):
// native reasoning deltas and inline <think>...</think> are both surfaced as "thinking".

const OPEN = '<think>';
const CLOSE = '</think>';

/**
 * Splits a stream of content deltas into text and thinking, tolerating a tag that is cut
 * in half across two deltas (the tail that could still become a tag is held back).
 */
export function createThinkSplitter(onText, onThinking) {
	let buf = '';
	let thinking = false;
	const emit = (s) => { if (s) (thinking ? onThinking : onText)(s); };
	return {
		push(delta) {
			buf += delta;
			for (;;) {
				const tag = thinking ? CLOSE : OPEN;
				const at = buf.indexOf(tag);
				if (at !== -1) {
					emit(buf.slice(0, at));
					buf = buf.slice(at + tag.length);
					thinking = !thinking;
					continue;
				}
				let hold = 0;
				for (let n = Math.min(tag.length - 1, buf.length); n > 0; n--) {
					if (tag.startsWith(buf.slice(-n))) { hold = n; break; }
				}
				emit(buf.slice(0, buf.length - hold));
				buf = buf.slice(buf.length - hold);
				return;
			}
		},
		flush() { emit(buf); buf = ''; }
	};
}

const trimUrl = (u) => String(u || '').replace(/\/+$/, '');
const authHeaders = (apiKey) => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

export async function listModels({ baseUrl, apiKey, signal }) {
	const res = await fetch(`${trimUrl(baseUrl)}/models`, { headers: authHeaders(apiKey), signal });
	if (!res.ok) throw new Error(`Model list failed: HTTP ${res.status}`);
	const body = await res.json();
	return (body.data || []).map((m) => m.id).filter(Boolean);
}

/**
 * Run one streamed completion. Calls onText / onThinking with deltas as they arrive and
 * resolves with the full { content, reasoning, toolCalls }; toolCalls is a list of
 * { id, name, arguments } with arguments still a raw JSON string (the caller validates it). Rejects on HTTP or network failure; an
 * abort rejects with the AbortError from fetch.
 */
export async function streamChat({ baseUrl, apiKey, model, messages, tools, temperature, signal, onText, onThinking }) {
	const body = { model, messages, stream: true };
	if (tools?.length) body.tools = tools;
	if (Number.isFinite(temperature)) body.temperature = temperature;

	const res = await fetch(`${trimUrl(baseUrl)}/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
		body: JSON.stringify(body),
		signal
	});
	if (!res.ok) {
		const detail = (await res.text().catch(() => '')).slice(0, 300);
		throw new Error(`Model endpoint returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
	}

	let content = '';
	let reasoning = '';
	const splitter = createThinkSplitter(
		(s) => { content += s; onText?.(s); },
		(s) => { reasoning += s; onThinking?.(s); }
	);

	const calls = new Map(); // stream index -> { id, name, arguments }
	const decoder = new TextDecoder();
	let pending = '';
	let done = false;
	for await (const chunk of res.body) {
		pending += decoder.decode(chunk, { stream: true });
		const lines = pending.split('\n');
		pending = lines.pop();
		for (const line of lines) {
			const t = line.trim();
			if (!t.startsWith('data:')) continue;
			const raw = t.slice(5).trim();
			if (raw === '[DONE]') { done = true; break; }
			let json;
			try { json = JSON.parse(raw); } catch { continue; }
			if (json.error) throw new Error(json.error.message || 'Model endpoint reported an error');
			const delta = json.choices?.[0]?.delta;
			if (!delta) continue;
			const r = delta.reasoning_content || delta.reasoning;
			if (typeof r === 'string' && r) { reasoning += r; onThinking?.(r); }
			if (typeof delta.content === 'string' && delta.content) splitter.push(delta.content);
			for (const tc of delta.tool_calls || []) {
				const idx = tc.index ?? 0;
				const cur = calls.get(idx) || { id: '', name: '', arguments: '' };
				if (tc.id) cur.id = tc.id;
				if (tc.function?.name) cur.name = tc.function.name;
				if (tc.function?.arguments) cur.arguments += tc.function.arguments;
				calls.set(idx, cur);
			}
		}
		if (done) break;
	}
	splitter.flush();
	const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c], i) => ({
		id: c.id || `call_${Date.now().toString(36)}_${i}`,
		name: c.name,
		arguments: c.arguments
	}));
	return { content, reasoning, toolCalls };
}
