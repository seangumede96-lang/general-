// Does the Model panel's progress card stay still while a brain starts? A fake RunPod and a fake
// machine walk through: starting (no news) -> downloading -> loading -> silence (the "no news"
// line appears). Once a second the card's top and height, the panel's scroll position and the
// chat composer's top and height are measured. Pass: nothing moves more than 1 px after the
// first 2 s, apart from the card's own height when a step's content legitimately changes, which
// is reported separately. Run: node test/ui/brain-steady.mjs
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server.js';
import { startMockRunpod } from '../mock-runpod.js';
import { startMockModel } from '../mock-model.js';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const dir = mkdtempSync(join(tmpdir(), 'brain-steady-'));
const rp = await startMockRunpod();
const machine = await startMockModel({ chunks: ['ok'] });
const everyday = await startMockModel({ chunks: ['ok'] });
const t0 = Date.now();
let stage = null, beat = Date.now();
machine.state.events = [];
machine.state.status = () => (stage ? `${stage.s} ${stage.done} 21166758784 ${stage.speed} ${Math.floor(beat / 1000)}\n` : '');
machine.state.loading = true;
const app = createApp({ dataDir: dir, watchdogMs: 60000, brainPollMs: 500, brainOptions: { silenceMs: 600000, resolveFile: async () => ({ file: 'M.gguf', url: 'https://example.invalid/M.gguf', bytes: 21166758784 }) } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: everyday.baseUrl, model: 'everyday-model', apiKey: 'k', runpodApiKey: rp.state.key, runpodBaseUrl: rp.baseUrl, runpodGraphqlUrl: rp.graphqlUrl, podProxyTemplate: machine.baseUrl.replace(/\/v1$/, '') }) });

const browser = await chromium.launch();
const page = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/`);
await page.locator('#model-chip').click();
await page.locator('#models-body .opt', { hasText: 'Qwen 3.6 35B Uncensored' }).click();
await page.locator('#models-body .switch').click();
await page.waitForSelector('.wake .btn-primary');
await page.locator('.wake .btn-primary').click();
await page.waitForSelector('.brain-progress-slot .boot', { timeout: 10000 });
const start = Date.now();

// The machine's story, by seconds since the start.
const script = (s) => {
	if (s < 4) { stage = null; return 'starting'; }
	if (s < 18) { stage = { s: 'downloading', done: Math.round((s - 4) * 1.4e9), speed: 1.2e8 }; beat = Date.now(); return 'downloading'; }
	if (s < 24) { stage = { s: 'loading', done: 21166758784, speed: 0 }; beat = Date.now(); return 'loading'; }
	stage = { s: 'loading', done: 21166758784, speed: 0 }; return 'loading (silent)'; // heartbeat frozen: "no news" appears after 45 s
};
const rows = [];
for (let s = 0; s <= 75; s++) {
	const phase = script(s);
	await page.waitForTimeout(Math.max(0, start + s * 1000 - Date.now()));
	const m = await page.evaluate(() => {
		const card = document.querySelector('.brain-progress-slot') || document.querySelector('#models-body .boot');
		const r = card?.getBoundingClientRect();
		const c = document.querySelector('#composer').getBoundingClientRect();
		return { top: r ? Math.round(r.top * 10) / 10 : null, h: r ? Math.round(r.height * 10) / 10 : null, scroll: document.querySelector('#models-body').scrollTop + document.querySelector('#models').scrollTop, ct: Math.round(c.top * 10) / 10, ch: Math.round(c.height * 10) / 10, quiet: Boolean(document.querySelector('.boot-quiet') && getComputedStyle(document.querySelector('.boot-quiet')).visibility !== 'hidden'), step: document.querySelector('.boot-meta')?.textContent.split('·')[1]?.trim() || '' };
	});
	rows.push({ s, phase, ...m });
}
const after = rows.filter((r) => r.s >= 2);
const span = (k) => { const v = after.map((r) => r[k]).filter((x) => x != null); return Math.max(...v) - Math.min(...v); };
const moves = [];
for (let i = 1; i < after.length; i++) for (const k of ['top', 'h', 'scroll', 'ct', 'ch']) if (after[i][k] != null && after[i - 1][k] != null && Math.abs(after[i][k] - after[i - 1][k]) > 1) moves.push(`${after[i].s}s ${k} ${after[i - 1][k]}→${after[i][k]} (${after[i].phase})`);
console.log('s  phase              top    height scroll composerTop composerH quiet step');
for (const r of rows) if (r.s % 5 === 0 || moves.some((x) => x.startsWith(`${r.s}s `))) console.log(`${String(r.s).padEnd(3)}${r.phase.padEnd(19)}${String(r.top).padEnd(7)}${String(r.h).padEnd(7)}${String(r.scroll).padEnd(7)}${String(r.ct).padEnd(12)}${String(r.ch).padEnd(10)}${r.quiet ? 'yes' : 'no '}   ${r.step}`);
console.log(`range after 2 s: top ${span('top')} px, height ${span('h')} px, scroll ${span('scroll')} px, composer top ${span('ct')} px, composer height ${span('ch')} px`);
console.log('quiet line seen:', rows.some((r) => r.quiet) ? `from ${rows.find((r) => r.quiet).s} s` : 'no');
console.log(moves.length ? `MOVES (>1 px):\n  ${moves.join('\n  ')}` : 'no moves over 1 px after the first 2 s');
if (errors.length) console.log('page errors:', errors);
await browser.close(); await app.close(); await rp.close(); await machine.close(); await everyday.close();
process.exit(moves.length || errors.length ? 1 : 0);
