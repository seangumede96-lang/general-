import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProgress, createTracker, parseStep } from '../src/progress.js';

test('booting: elapsed counts up, the estimate counts down, and a long silence is flagged', () => {
	const t0 = 1_000_000;
	let p = computeProgress('image', t0, null, t0 + 60_000);
	assert.deepEqual([p.index, p.elapsedSeconds, p.etaSeconds], [0, 60, 90 + 120 + 300 + 45]);
	assert.ok(p.fraction > 0 && p.fraction < 0.2);
	p = computeProgress('image', t0, null, t0 + 400_000);
	assert.ok(p.quietSeconds > p.quietLimitSeconds, 'nothing heard for 400 s while booting');
});

test('steps from the machine move the bar on, and download speed corrects the estimate', () => {
	let now = 1_000_000;
	const tr = createTracker(() => now);
	tr.report('pod', 2, 'STEP 2/3 Downloading models');
	now += 100_000;
	tr.report('pod', 2, 'STEP 2/3 Downloading models (2 of 6 files, 9 GB)');
	const p = computeProgress('image', 1_000_000 - 200_000, tr.get('pod'), now);
	assert.equal(p.index, 2);
	assert.equal(p.detail, '2 of 6 files, 9 GB');
	// 9 of 37 GB in 100 s -> about 311 s more to download, then 45 s to start.
	assert.ok(Math.abs(p.etaSeconds - (100 * (37 - 9) / 9 + 45)) < 2, String(p.etaSeconds));
	assert.equal(p.quietSeconds, 0);
	assert.deepEqual(parseStep('3/4 Downloading models'), { index: 3, detail: 'Downloading models' });
});

test('per-file download rows: size, done, percentage source and speed', () => {
	let now = 0;
	const tr = createTracker(() => now);
	tr.report('pod', 2, 'STEP 2/3 Downloading models');
	tr.files('pod', 'krea2_turbo_fp8_scaled.safetensors 0 13000000000\nqwen_image_vae.safetensors 0 250000000');
	now = 10_000;
	tr.files('pod', 'krea2_turbo_fp8_scaled.safetensors 1000000000 13000000000\nqwen_image_vae.safetensors 250000000 250000000');
	const p = computeProgress('image', -60_000, tr.get('pod'), now);
	assert.deepEqual(p.files.map((f) => [f.name.slice(0, 5), f.done, f.total, f.speed]), [['krea2', 1e9, 13e9, 1e8], ['qwen_', 25e7, 25e7, 25e6]]);
	assert.equal(p.quietSeconds, 0);
	// 1.25 of 13.25 GB done, measured from the files themselves.
	assert.ok(p.fraction > 0.05 && p.fraction < 0.5);
});
