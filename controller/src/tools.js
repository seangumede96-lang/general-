// Tool registry. Every tool declares a JSON-schema for its arguments and a risk class:
//   read   - looks at things; runs without asking
//   write  - changes the assistant's own records; runs without asking, always logged
//   danger - changes or removes the user's files, or (later) spends money; needs approval
// The model only ever proposes a call. Validation, folder limits and approval are enforced
// here in code, so a confused or manipulated model cannot step outside them.
import { readdir, readFile, writeFile, stat, realpath, mkdir } from 'node:fs/promises';
import { resolve, dirname, sep, basename, join } from 'node:path';
import { TEST_POD } from './gpu.js';

const MAX_READ_BYTES = 64 * 1024;
const MAX_OUTPUT_CHARS = 16 * 1024;

export class ToolError extends Error {}
const FILE_TOOLS = new Set(['list_files', 'read_file', 'write_file']);

const clip = (s) => (s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated ${s.length - MAX_OUTPUT_CHARS} characters]` : s);

/** Minimal schema check: required keys present, declared keys of the declared primitive type. */
export function validateArgs(schema, args) {
	if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be a JSON object';
	for (const key of schema.required || []) {
		if (args[key] === undefined || args[key] === null) return `missing required argument "${key}"`;
	}
	for (const [key, value] of Object.entries(args)) {
		const spec = schema.properties?.[key];
		if (!spec) return `unknown argument "${key}"`;
		const actual = Number.isInteger(value) && spec.type === 'integer' ? 'integer' : typeof value;
		if (spec.type && actual !== spec.type) return `argument "${key}" must be of type ${spec.type}`;
	}
	return null;
}

export function parseAllowedDirs(text) {
	return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => resolve(l));
}

const inside = (root, target) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Resolve a path the model asked for and prove it sits inside an allowed folder. Symlinks
 * are resolved first, so a link inside an allowed folder cannot point the tool elsewhere.
 * For a file that does not exist yet, its nearest existing parent is checked instead.
 */
async function resolveAllowed(path, allowedDirs) {
	if (!allowedDirs.length) throw new ToolError('No folders are shared with the assistant yet. The user can add them in Settings.');
	const roots = [];
	for (const dir of allowedDirs) {
		try { roots.push(await realpath(dir)); } catch { /* a listed folder that does not exist grants nothing */ }
	}
	const wanted = resolve(allowedDirs[0], path);
	let probe = wanted;
	let tail = '';
	for (;;) {
		try {
			const real = await realpath(probe);
			const full = tail ? join(real, tail) : real;
			if (roots.some((r) => inside(r, full))) return full;
			break;
		} catch (err) {
			if (err.code !== 'ENOENT' || dirname(probe) === probe) break;
			tail = tail ? join(basename(probe), tail) : basename(probe);
			probe = dirname(probe);
		}
	}
	throw new ToolError(`"${path}" is outside the folders shared with the assistant (${allowedDirs.join(', ')}).`);
}

export function createTools({ db, gpu, uploadsDir }) {
	const dirs = () => parseAllowedDirs(db.getSettings().allowedDirs);
	// Files the user attached in chat can be read (never written) wherever they were saved.
	const readable = () => [...dirs(), ...(uploadsDir ? [uploadsDir] : [])];
	/** Resolve a path for reading. Errors describe only the folders the user chose to share. */
	async function resolveReadable(path) {
		try { return await resolveAllowed(path, readable()); }
		catch (err) {
			if (!(err instanceof ToolError)) throw err;
			return resolveAllowed(path, dirs());
		}
	}

	const tools = [
		{
			name: 'list_files',
			risk: 'read',
			description: 'List the files and folders inside a shared folder. Call with no path to see the shared folders themselves.',
			parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder path. Omit to list the shared folders.' } } },
			async run({ path }) {
				if (!path) {
					const shared = dirs();
					return shared.length ? `Shared folders:\n${shared.join('\n')}` : 'No folders are shared with the assistant yet. The user can add them in Settings.';
				}
				const dir = await resolveReadable(path);
				const entries = await readdir(dir, { withFileTypes: true });
				if (!entries.length) return '(empty folder)';
				const lines = [];
				for (const e of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 500)) {
					if (e.isDirectory()) { lines.push(`${e.name}/`); continue; }
					const info = await stat(join(dir, e.name)).catch(() => null);
					lines.push(info ? `${e.name}\t${info.size} bytes\t${info.mtime.toISOString().slice(0, 10)}` : e.name);
				}
				if (entries.length > 500) lines.push(`…and ${entries.length - 500} more`);
				return lines.join('\n');
			}
		},
		{
			name: 'read_file',
			risk: 'read',
			description: `Read a text file from a shared folder (first ${MAX_READ_BYTES / 1024} KB).`,
			parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
			async run({ path }) {
				const file = await resolveReadable(path);
				const info = await stat(file);
				if (info.isDirectory()) throw new ToolError(`"${path}" is a folder. Use list_files.`);
				const buf = (await readFile(file)).subarray(0, MAX_READ_BYTES);
				if (buf.includes(0)) throw new ToolError(`"${path}" is not a text file (${info.size} bytes). Pictures, videos and other binary files cannot be opened or viewed with this tool; tell the user you cannot look inside it.`);
				const more = info.size > MAX_READ_BYTES ? `\n…[file is ${info.size} bytes; only the first ${MAX_READ_BYTES} shown]` : '';
				return buf.toString('utf8') + more;
			}
		},
		{
			name: 'write_file',
			risk: 'danger',
			description: 'Create or overwrite a text file in a shared folder. The user is asked to approve each write.',
			parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
			describe: ({ path, content }) => `Write ${Buffer.byteLength(String(content ?? ''))} bytes to ${path}`,
			async run({ path, content }) {
				const file = await resolveAllowed(path, dirs());
				await mkdir(dirname(file), { recursive: true });
				await writeFile(file, content, 'utf8');
				return `Wrote ${Buffer.byteLength(content)} bytes to ${file}`;
			}
		},
		{
			name: 'remember',
			risk: 'write',
			description: 'Save a fact or preference to long-term memory so it is available in future conversations.',
			parameters: { type: 'object', properties: { text: { type: 'string', description: 'One self-contained sentence.' } }, required: ['text'] },
			async run({ text }) {
				if (!text.trim()) throw new ToolError('Nothing to remember: text is empty.');
				return `Saved as memory #${db.addFact(text.trim())}.`;
			}
		},
		{
			name: 'recall',
			risk: 'read',
			description: 'Search long-term memory by keywords. Call with no query to see the most recent memories.',
			parameters: { type: 'object', properties: { query: { type: 'string', description: 'A word or phrase to look for.' } } },
			async run({ query }) {
				const line = (r) => `#${r.id} (${new Date(r.created_at).toISOString().slice(0, 10)}): ${r.text}`;
				const rows = db.searchFacts(query);
				if (rows.length) return rows.map(line).join('\n');
				// A miss on the wording should not hide what is stored: show the latest instead.
				const recent = db.recentFacts();
				return recent.length ? `Nothing matched "${query}". Most recent memories:\n${recent.map(line).join('\n')}` : 'Memory is empty.';
			}
		},
		{
			name: 'gpu_status',
			risk: 'read',
			description: 'Show the GPU budget (spent and remaining) and any pod that is running now.',
			parameters: { type: 'object', properties: {} },
			async run() {
				const b = gpu.budget();
				const pod = gpu.activePod();
				const line = b.known
					? `GPU money: $${b.remaining.toFixed(2)} left${b.balance !== null ? ` (RunPod balance $${b.balance.toFixed(2)})` : ''}; $${b.spent.toFixed(2)} spent through this app.`
					: 'GPU money: the RunPod balance has not been read yet.';
				return pod ? `${line}\nRunning: ${pod.gpu} at $${pod.rate}/h (${pod.purpose || 'no purpose given'}), pod ${pod.id}.` : `${line}\nNo pod is running.`;
			}
		},
		{
			name: 'start_gpu',
			risk: 'danger',
			description: 'Rent a GPU pod for a fixed number of minutes. Costs money: the user sees the price and must approve. The pod is deleted automatically when the time is up or it sits idle.',
			parameters: { type: 'object', properties: { minutes: { type: 'integer', description: 'Maximum lifetime in minutes.' }, purpose: { type: 'string', description: 'What the pod is for.' } }, required: ['minutes', 'purpose'] },
			async preview({ minutes }) {
				const q = await gpu.quote({ minutes, minVram: 24 });
				return q.allowed ? { note: q.summary } : { refuse: `Cannot start a GPU: ${q.reason}` };
			},
			async run({ minutes, purpose }) {
				try {
					const pod = await gpu.start({ minutes, minVram: 24, purpose, spec: TEST_POD });
					return `Started pod ${pod.id}: ${pod.gpu} at $${pod.rate}/h, deleted automatically within ${minutes} minutes.`;
				} catch (err) { throw new ToolError(err.message); }
			}
		},
		{
			name: 'stop_gpu',
			risk: 'write',
			description: 'Delete the running GPU pod now to stop charges.',
			parameters: { type: 'object', properties: {} },
			async run() {
				const pod = gpu.activePod();
				if (!pod) return 'No pod is running.';
				try { await gpu.stop(pod.id, 'stopped by the assistant'); } catch (err) { throw new ToolError(err.message); }
				return `Pod ${pod.id} deleted.`;
			}
		}
	];
	const byName = new Map(tools.map((t) => [t.name, t]));

	return {
		/** Definitions in the shape the chat-completions API expects. */
		definitions() {
			// Tell the model the real shared paths up front, so its first call does not guess one.
			const shared = dirs();
			const where = shared.length ? ` Shared folders: ${shared.join(', ')}. Use these full paths.` : ' No folders are shared yet.';
			return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description + (FILE_TOOLS.has(t.name) ? where : ''), parameters: t.parameters } }));
		},
		get: (name) => byName.get(name),
		/**
		 * Check a proposed call without running it. Returns { tool, args } or { error } where
		 * error is a message written for the model, so it can correct itself and retry.
		 */
		prepare(name, rawArguments) {
			const tool = byName.get(name);
			if (!tool) return { error: `There is no tool called "${name}". Available tools: ${[...byName.keys()].join(', ')}.` };
			let args;
			try { args = JSON.parse(rawArguments || '{}'); }
			catch { return { tool, error: 'The arguments were not valid JSON. Call the tool again with a valid JSON object.' }; }
			const problem = validateArgs(tool.parameters, args);
			if (problem) return { tool, error: `Invalid arguments: ${problem}. Call the tool again with corrected arguments.` };
			return { tool, args };
		},
		async run(tool, args) {
			try { return { ok: true, output: clip(String(await tool.run(args))) }; }
			catch (err) {
				if (err instanceof ToolError) return { ok: false, output: err.message };
				if (err?.code === 'ENOENT') return { ok: false, output: 'That file or folder does not exist.' };
				if (err?.code === 'EACCES' || err?.code === 'EPERM') return { ok: false, output: 'Android denied access to that location.' };
				return { ok: false, output: `The tool failed: ${err?.message || err}` };
			}
		}
	};
}
