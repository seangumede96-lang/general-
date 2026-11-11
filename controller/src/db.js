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
	temperature: '0.7'
};

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
			role TEXT NOT NULL,            -- user | assistant | error
			content TEXT NOT NULL DEFAULT '',
			reasoning TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'ok',  -- ok | stopped | error
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, id);
		CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	`);

	const q = {
		listConversations: db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC'),
		getConversation: db.prepare('SELECT * FROM conversations WHERE id = ?'),
		insertConversation: db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'),
		setTitle: db.prepare('UPDATE conversations SET title = ? WHERE id = ?'),
		touch: db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?'),
		deleteConversation: db.prepare('DELETE FROM conversations WHERE id = ?'),
		listMessages: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id'),
		insertMessage: db.prepare('INSERT INTO messages (conversation_id, role, content, reasoning, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
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
		addMessage(conversationId, { role, content = '', reasoning = '', status = 'ok' }) {
			const now = Date.now();
			const r = q.insertMessage.run(conversationId, role, content, reasoning, status, now);
			q.touch.run(now, conversationId);
			return { id: Number(r.lastInsertRowid), conversation_id: conversationId, role, content, reasoning, status, created_at: now };
		},
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
