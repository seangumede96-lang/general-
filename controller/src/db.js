// Persistent storage: conversations, messages and settings in one SQLite file.
// Uses Node's built-in node:sqlite so there is nothing native to compile on Termux.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const SETTING_DEFAULTS = {
	baseUrl: 'http://127.0.0.1:8000/v1',
	apiKey: '',
	model: '',
	systemPrompt: 'You are a capable, direct assistant. Format answers in Markdown.',
	temperature: '0.7',
	// One absolute folder per line. The assistant's file tools cannot leave these.
	allowedDirs: '',
	runpodApiKey: '',
	runpodBaseUrl: '',
	podCloud: 'ANY',   // ANY = cheapest of Community and Secure; or COMMUNITY / SECURE
	runpodGraphqlUrl: '',
	// Optional cap on what this app may spend in total. Empty = limited only by the real RunPod balance.
	budgetTotal: '',
	maxPodMinutes: '60',
	idleMinutes: '10',
	// The private brain: a GGUF model on Hugging Face, served by llama.cpp on a rented pod.
	brainModel: 'unsloth/Qwen3.6-35B-A3B-GGUF:Q4_K_M',
	brainContext: '16384',
	podProxyTemplate: 'https://{id}-{port}.proxy.runpod.net',
	// Which brain chat should use: 'private' (the rented GPU, whenever it is awake) or 'everyday'.
	chatBrain: 'private'
};

/** Settings that hold credentials: stored, used, never sent to the browser. */
export const SECRET_SETTINGS = ['apiKey', 'runpodApiKey'];

export function openDb(dataDir) {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const file = join(dataDir, 'controller.db');
	const db = new DatabaseSync(file);
	try { chmodSync(file, 0o600); } catch { /* best effort: the file holds the API key */ }
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;
		CREATE TABLE IF NOT EXISTS conversations (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
			role TEXT NOT NULL,            -- user | assistant | tool | error
			content TEXT NOT NULL DEFAULT '',
			reasoning TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'ok',  -- ok | stopped | error
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, id);
		CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS uploads (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			type TEXT NOT NULL,
			size INTEGER NOT NULL,
			path TEXT NOT NULL,
			conversation_id TEXT,          -- null until the file is sent in a message
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS pods (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			gpu TEXT NOT NULL,
			rate REAL NOT NULL,          -- USD per hour, as reported by RunPod at creation
			purpose TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL,
			last_used_at INTEGER NOT NULL,
			deadline_at INTEGER NOT NULL,
			ended_at INTEGER,
			end_reason TEXT,
			actual_cost REAL             -- from RunPod billing once available; else estimated from rate
		);
		CREATE TABLE IF NOT EXISTS facts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			text TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
	`);
	// Columns added after the first release; older databases are upgraded in place.
	const have = new Set(db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name));
	for (const [name, ddl] of [
		['tool_calls', "TEXT NOT NULL DEFAULT ''"],    // assistant: JSON [{id,name,arguments}]
		['tool_call_id', "TEXT NOT NULL DEFAULT ''"],  // tool: which call this answers
		['tool_name', "TEXT NOT NULL DEFAULT ''"],
		['attachments', "TEXT NOT NULL DEFAULT ''"]   // user: JSON [{id,name,type,size}]
	]) if (!have.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${ddl}`);
	const podCols = new Set(db.prepare('PRAGMA table_info(pods)').all().map((c) => c.name));
	for (const [name, ddl] of [
		['kind', "TEXT NOT NULL DEFAULT 'test'"],  // test | brain
		['secret', "TEXT NOT NULL DEFAULT ''"],    // key protecting the service on the pod; never sent to the browser
		['ready_at', 'INTEGER'],                   // when the service on the pod first answered
		['model', "TEXT NOT NULL DEFAULT ''"]      // brain pods: the model this pod was started with
	]) if (!podCols.has(name)) db.exec(`ALTER TABLE pods ADD COLUMN ${name} ${ddl}`);

	const q = {
		listConversations: db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC'),
		getConversation: db.prepare('SELECT * FROM conversations WHERE id = ?'),
		insertConversation: db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'),
		setTitle: db.prepare('UPDATE conversations SET title = ? WHERE id = ?'),
		touch: db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?'),
		deleteConversation: db.prepare('DELETE FROM conversations WHERE id = ?'),
		listMessages: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id'),
		insertMessage: db.prepare('INSERT INTO messages (conversation_id, role, content, reasoning, status, created_at, tool_calls, tool_call_id, tool_name, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
		insertUpload: db.prepare('INSERT INTO uploads (id, name, type, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
		getUpload: db.prepare('SELECT * FROM uploads WHERE id = ?'),
		claimUpload: db.prepare('UPDATE uploads SET conversation_id = ? WHERE id = ? AND conversation_id IS NULL'),
		uploadsOf: db.prepare('SELECT * FROM uploads WHERE conversation_id = ?'),
		staleUploads: db.prepare('SELECT * FROM uploads WHERE conversation_id IS NULL AND created_at < ?'),
		deleteUpload: db.prepare('DELETE FROM uploads WHERE id = ?'),
		insertFact: db.prepare('INSERT INTO facts (text, created_at) VALUES (?, ?)'),
		allFacts: db.prepare('SELECT id, text, created_at FROM facts ORDER BY id DESC LIMIT 2000'),
		listPods: db.prepare('SELECT * FROM pods ORDER BY created_at DESC'),
		getPod: db.prepare('SELECT * FROM pods WHERE id = ?'),
		insertPod: db.prepare('INSERT INTO pods (id, name, gpu, rate, purpose, created_at, last_used_at, deadline_at, kind, secret, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
		setPodReady: db.prepare('UPDATE pods SET ready_at = ? WHERE id = ? AND ready_at IS NULL'),
		endPod: db.prepare('UPDATE pods SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL'),
		touchPod: db.prepare('UPDATE pods SET last_used_at = ? WHERE id = ?'),
		setPodActualCost: db.prepare('UPDATE pods SET actual_cost = ? WHERE id = ?'),
		allSettings: db.prepare('SELECT key, value FROM settings'),
		setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
	};

	return {
		close: () => db.close(),
		listConversations: () => q.listConversations.all(),
		getConversation: (id) => q.getConversation.get(id),
		createConversation(title = '') {
			const now = Date.now();
			const id = randomUUID();
			q.insertConversation.run(id, title, now, now);
			return q.getConversation.get(id);
		},
		setTitle: (id, title) => { q.setTitle.run(title, id); },
		deleteConversation: (id) => { q.deleteConversation.run(id); },
		listMessages: (id) => q.listMessages.all(id),
		addMessage(conversationId, { role, content = '', reasoning = '', status = 'ok', toolCalls = null, toolCallId = '', toolName = '', attachments = null }) {
			const now = Date.now();
			const tool_calls = toolCalls?.length ? JSON.stringify(toolCalls) : '';
			const att = attachments?.length ? JSON.stringify(attachments) : '';
			const r = q.insertMessage.run(conversationId, role, content, reasoning, status, now, tool_calls, toolCallId, toolName, att);
			q.touch.run(now, conversationId);
			return { id: Number(r.lastInsertRowid), conversation_id: conversationId, role, content, reasoning, status, created_at: now, tool_calls, tool_call_id: toolCallId, tool_name: toolName, attachments: att };
		},
		insertUpload: (u) => { q.insertUpload.run(u.id, u.name, u.type, u.size, u.path, u.created_at); },
		getUpload: (id) => q.getUpload.get(id),
		claimUpload: (id, conversationId) => q.claimUpload.run(conversationId, id).changes === 1,
		uploadsOf: (conversationId) => q.uploadsOf.all(conversationId),
		staleUploads: (before) => q.staleUploads.all(before),
		deleteUpload: (id) => { q.deleteUpload.run(id); },
		addFact(text) {
			const r = q.insertFact.run(text, Date.now());
			return Number(r.lastInsertRowid);
		},
		/**
		 * Memories that share words with the query, best match first. Matching is per word, so
		 * "video format" finds "my videos are 9:16 vertical". With no query, the most recent.
		 */
		searchFacts(query) {
			const words = [...new Set(String(query || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])];
			const all = q.allFacts.all();
			if (!words.length) return all.slice(0, 20);
			// Compare on a crude stem (drop a trailing "s") so plural and singular meet.
			const stem = (w) => w.replace(/s$/, '');
			return all
				.map((f) => {
					const text = f.text.toLowerCase();
					return { ...f, score: words.filter((w) => text.includes(stem(w))).length };
				})
				.filter((f) => f.score > 0)
				.sort((x, y) => y.score - x.score || y.id - x.id)
				.slice(0, 20)
				.map(({ score, ...f }) => f);
		},
		recentFacts: () => q.allFacts.all().slice(0, 20),
		listPods: () => q.listPods.all(),
		getPod: (id) => q.getPod.get(id),
		insertPod: (p) => { q.insertPod.run(p.id, p.name, p.gpu, p.rate, p.purpose, p.created_at, p.last_used_at, p.deadline_at, p.kind || 'test', p.secret || '', p.model || ''); },
		setPodReady: (id, at) => { q.setPodReady.run(at, id); },
		endPod: (id, at, reason) => { q.endPod.run(at, reason, id); },
		touchPod: (id, at) => { q.touchPod.run(at, id); },
		setPodActualCost: (id, cost) => { q.setPodActualCost.run(cost, id); },
		getSettings() {
			const out = { ...SETTING_DEFAULTS };
			for (const row of q.allSettings.all()) if (row.key in out) out[row.key] = row.value;
			return out;
		},
		setSettings(patch) {
			for (const [k, v] of Object.entries(patch)) {
				if (k in SETTING_DEFAULTS && typeof v === 'string') q.setSetting.run(k, v);
			}
		}
	};
}
