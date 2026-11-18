// The Characters page's picture-session card while a session starts, on a phone, with a fake
// RunPod and a fake engine: the live log's rows appear, the card and the page stay put across
// polls (no jumping, no scroll reset), the "No news" warning shows after 60 s of silence, and End
// session still works. Run: node test/ui/image-session-log.mjs  (about 2 min)
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server.js';
import { startMockRunpod } from '../mock-runpod.js';
import { startMockComfy } from '../mock-comfy.js';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const rp = await startMockRunpod();
const comfy = await startMockComfy();
Object.assign(comfy.state, { ready: false, setupLog: 'STEP 1/3 Installing the image engine\n' });
const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'img-log-')), watchdogMs: 0, imagePollMs: 1000 });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
const api = async (method, path, body) => (await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })).json();
await api('PUT', '/api/settings', { maxPodMinutes: '90', runpodApiKey: rp.state.key, runpodBaseUrl: rp.baseUrl, runpodGraphqlUrl: rp.graphqlUrl, podCloud: 'COMMUNITY', podProxyTemplate: comfy.baseUrl });
const q = await api('POST', '/api/images/quote', { minutes: 30 });
const started = await api('POST', '/api/images/session', { minutes: 30, confirmEstimate: q.estimate });
if (!started.podId) { console.log('session did not start', started); process.exit(1); }

const browser = await chromium.launch();
const page = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
const problems = [];
const fail = (w) => { problems.push(w); console.log('PROBLEM', w); };
page.on('pageerror', (e) => fail(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail(`console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());
await page.goto(`${base}/#characters`);
await page.waitForSelector('#img-session .live-log', { timeout: 20000 });

// The engine reports a few steps over the first 25 s, then goes quiet.
const steps = ['STEP 2/3 Downloading models (1 of 3 files, 9 GB)', 'STEP 2/3 Downloading models (2 of 3 files, 18 GB)', 'STEP 2/3 Downloading models (3 of 3 files, 25 GB)', 'STEP 3/3 Starting the image engine'];
const rows = [];
let scrolled = false;
for (let s = 0; s <= 95; s++) {
	if (s > 0 && s % 6 === 0 && steps.length) comfy.state.setupLog += `${steps.shift()}\n`;
	// After 8 s, scroll the page a little and open the log, as a person would, and check both stay.
	if (s === 8) { await page.evaluate(() => { document.querySelector('#img-session .live-log').open = true; document.querySelector('#characters').scrollTop = 40; }); scrolled = true; }
	await page.waitForTimeout(1000);
	rows.push(await page.evaluate(() => {
		const log = document.querySelector('#img-session .live-log'), r = log?.getBoundingClientRect();
		const form = document.querySelector('#img-form').getBoundingClientRect();
		return { rows: log?.querySelectorAll('.live-lines li').length || 0, top: r ? Math.round(r.top) : null, open: log?.open, pageScroll: document.querySelector('#characters').scrollTop, formTop: Math.round(form.top), warn: log && !log.querySelector('.live-warn').hidden ? log.querySelector('.live-warn').textContent : '', meta: log?.querySelector('.live-meta').textContent || '' };
	}));
}
const after = rows.slice(9);
for (let i = 1; i < after.length; i++) {
	const a = after[i - 1], b = after[i];
	if (Math.abs(a.top - b.top) > 1) fail(`the card moved ${a.top} -> ${b.top} at ${i + 9} s`);
	if (a.pageScroll !== b.pageScroll) fail(`page scroll reset ${a.pageScroll} -> ${b.pageScroll} at ${i + 9} s`);
	if (!b.open) fail(`the log closed by itself at ${i + 9} s`);
	if (b.rows < a.rows) fail(`log rows went from ${a.rows} to ${b.rows} at ${i + 9} s`);
}
const firstWarn = rows.findIndex((r) => r.warn);
console.log('rows over time:', rows.filter((_, i) => i % 5 === 0).map((r) => r.rows).join(' '));
console.log('card top over time:', [...new Set(rows.slice(9).map((r) => r.top))].join(', '), '| form top:', [...new Set(rows.slice(9).map((r) => r.formTop))].join(', '));
console.log('last meta:', rows.at(-1).meta);
console.log('warning first shown at', firstWarn, 's:', rows[firstWarn]?.warn);
if (rows.at(-1).rows < 4) fail('log rows did not appear');
if (firstWarn < 0) fail('the "No news" warning never appeared');
await page.screenshot({ path: join(tmpdir(), 'img-log.png') });

// End session.
await page.locator('#img-session button', { hasText: 'End session' }).click();
await page.waitForTimeout(1500);
const state = (await api('GET', '/api/images')).session.state;
if (state !== 'off') fail(`End session left the session ${state}`);
if ([...rp.state.pods.values()].some((p) => p.status !== 'TERMINATED')) fail('a pod was left running');
console.log('after End session:', state, '· screenshot', join(tmpdir(), 'img-log.png'));
await browser.close(); await app.close(); await rp.close(); await comfy.close();
console.log(problems.length ? `${problems.length} problem(s)` : 'Session log OK');
process.exit(problems.length ? 1 : 0);
