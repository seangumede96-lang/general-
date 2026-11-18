// Runs the real download part of a pod's setup script under bash, exactly as the pod does:
// inside the same shell as the self-delete timer. The first real image and video runs hung
// here because the script waited for that timer too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadLines } from '../src/video-recipe.js';
import { withDeadman } from '../src/gpu.js';

test('setup moves on after downloads even with the self-delete timer running in the same shell', async () => {
	const server = createServer((req, res) => {
		if (req.url === '/missing') { res.writeHead(404); return res.end(); }
		res.writeHead(200, { 'Content-Length': 2000 }); res.end(Buffer.alloc(2000, 1));
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const base = `http://127.0.0.1:${server.address().port}`;
	const dir = mkdtempSync(join(tmpdir(), 'setup-'));
	try {
		const run = (files) => {
			const lines = downloadLines(files, `${dir}/models`, '2/3')
				.filter((l) => !l.includes('apt-get'))
				.map((l) => l.replaceAll('/srv/log', `${dir}/log`).replace('sleep 5', 'sleep 0.2'));
			const script = [`mkdir -p ${dir}/log`, 'trap \'echo "SETUP FAILED"\' ERR', 'set -eE', ...lines, 'echo "STEP 3/3 Starting the image engine"'].join('\n');
			// The pod's real start command: a 60-second timer in the background, then the script.
			const { cmd } = JSON.parse(withDeadman(script, 60)).cmd ? { cmd: JSON.parse(withDeadman(script, 60)).cmd[0].replace(/curl -s -X DELETE[^)]*runpodctl pod delete \$RUNPOD_POD_ID/, 'true') } : {};
			writeFileSync(`${dir}/run.sh`, cmd);
			// Watch the script's own exit: the background timer keeps the output pipe open after it.
			return new Promise((resolve) => {
				const started = Date.now();
				const child = spawn('bash', [`${dir}/run.sh`], { detached: true });
				let out = '';
				child.stdout.on('data', (d) => { out += d; });
				child.stderr.on('data', (d) => { out += d; });
				const limit = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} resolve({ out, killed: true }); }, 20000);
				child.on('exit', () => {
					clearTimeout(limit);
					setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} resolve({ out, seconds: (Date.now() - started) / 1000, killed: false }); }, 100);
				});
			});
		};
		const ok = await run([[`${base}/a.bin`, 'x/a.bin'], [`${base}/b.bin`, 'y/b.bin']]);
		assert.equal(ok.killed, false, 'the script must not wait for the 60-second timer');
		assert.match(ok.out, /Downloads finished: 2 of 2 files[\s\S]*STEP 3\/3 Starting the image engine/);
		assert.deepEqual(readFileSync(`${dir}/log/files.txt`, 'utf8').trim().split('\n'), ['a.bin 2000 2000', 'b.bin 2000 2000']);

		const bad = await run([[`${base}/a.bin`, 'x/c.bin'], [`${base}/missing`, 'y/d.bin']]);
		assert.equal(bad.killed, false, 'a failed download must not hang either');
		assert.match(bad.out, /MISSING y\/d\.bin[\s\S]*SETUP FAILED/);
		assert.doesNotMatch(bad.out, /STEP 3\/3/);
	} finally {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
