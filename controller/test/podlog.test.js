import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describeSystemLine, followPodLog } from '../src/podlog.js';

test('RunPod system lines are put in plain words; pull progress is read as bytes', () => {
	const p = describeSystemLine('a1b2c3d4e5f6: Downloading [=====>   ] 1.2GB/4.8GB');
	assert.equal(p.kind, 'pull');
	assert.equal(p.layer, 'a1b2c3d4e5f6');
	assert.equal(Math.round(p.done / 1e8), 12);
	assert.equal(Math.round(p.total / 1e8), 48);
	assert.match(describeSystemLine('create container runpod/pytorch:1.0.3').text, /Creating the container/);
	assert.match(describeSystemLine('start container for runpod/pytorch: begin').text, /Container started/);
	assert.equal(describeSystemLine('error pulling image: no space left on device').kind, 'error');
});

test('following a pod log merges layer progress, skips replayed lines and reopens the stream', async () => {
	const spawned = [];
	const spawnImpl = (bin, args, opts) => {
		const c = new EventEmitter(); c.stdout = new PassThrough(); c.kill = () => c.emit('close');
		spawned.push({ args, key: opts.env.RUNPOD_API_KEY, c });
		return c;
	};
	const events = [];
	let now = 0;
	const stop = followPodLog('pod1', { key: () => 'k', spawnImpl, clock: () => now, reopenMs: 5, onEvent: (e) => events.push(e) });
	const line = (l, ts = '2026-11-17T07:00:00Z') => JSON.stringify({ source: 'system', line: l, ts }) + '\n';
	spawned[0].c.stdout.write(line('aaaaaaaaaaaa: Downloading 1GB/2GB') + line('bbbbbbbbbbbb: Downloading 1GB/3GB'));
	now = 20000;
	spawned[0].c.stdout.write(line('bbbbbbbbbbbb: Downloading 2GB/3GB', '2026-11-17T07:00:20Z') + line('create container x'));
	await new Promise((r) => setImmediate(r));
	assert.equal(spawned[0].key, 'k');
	assert.deepEqual(spawned[0].args.slice(0, 4), ['pod', 'logs', 'pod1', '--follow']);
	assert.deepEqual(events.map((e) => e.text), ['Downloading the engine software: 1.0 / 2.0 GB', 'Downloading the engine software: 3.0 / 5.0 GB', 'Creating the container']);
	// The stream drops: it is reopened, and the replayed line is not shown twice.
	spawned[0].c.emit('close');
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(spawned.length, 2);
	spawned[1].c.stdout.write(line('create container x') + line('start container x'));
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(events.slice(3).map((e) => e.text), ['Container started: the engine\'s own setup begins']);
	stop();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(spawned.length, 2, 'not reopened after stop');
});
