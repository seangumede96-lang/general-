// RunPod's own account of a machine starting: "pulling the image, 1.2 / 4.8 GB", "container created",
// "container started"... This is the part of a start-up the app could not see before (the machine's
// own log server only answers once the container runs). Read with `runpodctl pod logs --follow
// --source system`, which prints one JSON object per line: { source, line, ts }.
// The RunPod key is passed to runpodctl through its environment, on this phone only.
import { spawn } from 'node:child_process';

const SIZE = { b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: 1048576, gb: 1e9, gib: 1073741824 };
const toBytes = (n, unit) => Number(n) * (SIZE[String(unit).toLowerCase().replace(/s$/, '')] || 1);
const gb = (b) => (b / 1e9).toFixed(1);

/**
 * Plain words for one RunPod system line (the raw line is kept as well).
 * Pull progress of the image's layers is summed across layers to one "x / y GB" figure by the caller.
 */
export function describeSystemLine(line) {
	const l = String(line || '').trim();
	let m;
	if ((m = /([\d.]+)\s*([kMG]i?B)\s*\/\s*([\d.]+)\s*([kMG]i?B)/i.exec(l)) && /pull|download|extract/i.test(l)) {
		const layer = (/^([0-9a-f]{6,64})\b/i.exec(l) || /layer[ :]+([0-9a-f]{6,64})/i.exec(l) || [])[1] || '';
		return { kind: /extract/i.test(l) ? 'extract' : 'pull', layer, done: toBytes(m[1], m[2]), total: toBytes(m[3], m[4]) };
	}
	if (/no space|out of (disk|memory)|error|fail|denied|unauthori[sz]ed|not found|timeout|timed out/i.test(l)) return { kind: 'error', text: l };
	if (/^digest: sha256/i.test(l)) return { kind: 'skip' };
	if (/already exists|image is up to date|is cached|found locally/i.test(l)) return { kind: 'text', text: 'Engine software already on this machine (no download needed)' };
	if (/download(ed)? newer image|pull complete|status: downloaded/i.test(l)) return { kind: 'text', text: 'Engine software downloaded' };
	if (/pulling (from|fs layer)|pulling image|start(ing)? (image )?pull/i.test(l)) return { kind: 'text', text: 'Checking the engine software on the machine (downloads it if missing)' };
	if (/network volume .* mounted/i.test(l)) return { kind: 'text', text: 'Your storage is connected' };
	if (/creat(e|ing|ed) container|container (is )?created/i.test(l)) return { kind: 'text', text: 'Creating the container' };
	if (/start(ed|ing)? container|container (is )?(started|running)/i.test(l)) return { kind: 'text', text: 'Container started: the engine\'s own setup begins' };
	return { kind: 'text', text: l };
}

/**
 * Follow the system log of a pod. onEvent receives { at, text, raw, kind }. Pull progress is merged:
 * at most one "Downloading the engine software: x / y GB" event every 10 seconds.
 * Returns stop(). The stream is reopened after 5 s if runpodctl exits while still wanted.
 */
export function followPodLog(podId, { key, onEvent, bin = 'runpodctl', spawnImpl = spawn, clock = Date.now, reopenMs = 5000 }) {
	let child = null, stopped = false, buf = '', lastPullAt = -Infinity, reopen = null;
	const layers = new Map(); // layer -> { done, total }
	const seen = new Set();
	const open = () => {
		if (stopped) return;
		const k = key();
		if (!k) return;
		try {
			child = spawnImpl(bin, ['pod', 'logs', podId, '--follow', '--tail', '500', '--source', 'system'], { env: { ...process.env, RUNPOD_API_KEY: k }, stdio: ['ignore', 'pipe', 'ignore'] });
		} catch { child = null; reopen = setTimeout(open, reopenMs); return; }
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk) => {
			buf += chunk;
			let i;
			while ((i = buf.indexOf('\n')) >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 1); handle(raw); }
		});
		child.on('error', () => {});
		child.on('close', () => { child = null; if (!stopped) reopen = setTimeout(open, reopenMs); });
	};
	const handle = (raw) => {
		let rec;
		try { rec = JSON.parse(raw); } catch { rec = { line: raw }; }
		const line = String(rec.line ?? rec.message ?? '').trim();
		if (!line || (rec.source && rec.source !== 'system')) return;
		// A reopened stream replays recent lines: skip the ones already shown.
		const id = `${rec.ts || ''}|${line}`;
		if (seen.has(id)) return;
		seen.add(id);
		const at = Number.isFinite(Date.parse(rec.ts)) ? Date.parse(rec.ts) : clock();
		const d = describeSystemLine(line);
		if (d.kind === 'pull' || d.kind === 'extract') {
			layers.set(d.layer || 'all', { done: d.done, total: d.total, kind: d.kind });
			const now = clock();
			if (now - lastPullAt < 10000) return;
			lastPullAt = now;
			let done = 0, total = 0; for (const v of layers.values()) { done += v.done; total += v.total; }
			onEvent({ at, kind: 'pull', raw: line, text: `${d.kind === 'extract' ? 'Unpacking' : 'Downloading'} the engine software: ${gb(done)} / ${gb(total)} GB` });
			return;
		}
		if (d.kind !== 'skip') onEvent({ at, kind: d.kind, raw: line, text: d.text });
	};
	open();
	return () => { stopped = true; clearTimeout(reopen); try { child?.kill(); } catch { /* gone */ } };
}
