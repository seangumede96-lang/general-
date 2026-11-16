// Phone-screen check of the private brain panel against a fake RunPod and a fake machine:
// names of the two Qwen rows, turning one on, the progress card (no extra copies of the name),
// real download numbers, the collapsed backend log with times, ready, the session chip in the
// chat's top-right corner (yellow at 5 minutes), its menu with the hourly cost, and extending.
// Run: node test/ui/brain-panel.mjs   (screenshots go to the folder printed at the end)
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server.js';
import { startMockRunpod } from '../mock-runpod.js';
import { startMockModel } from '../mock-model.js';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const dir = mkdtempSync(join(tmpdir(), 'brain-ui-'));
const rp = await startMockRunpod();
const machine = await startMockModel({ chunks: ['from the private brain'] });
const everyday = await startMockModel({ chunks: ['from the everyday endpoint'] });
let stage = null;
machine.state.events = [];
machine.state.status = () => (stage ? `${stage.s} ${stage.done} 21166758784 ${stage.speed} ${Math.floor(Date.now() / 1000)}\n` : '');
const say = (s, done = 0, speed = 0) => { stage = { s, done, speed }; };
const ev = (text) => machine.state.events.push(`${Math.floor(Date.now() / 1000)} ${text}`);

const app = createApp({ dataDir: dir, watchdogMs: 60000, brainPollMs: 300, brainOptions: { resolveFile: async () => ({ file: 'M.Q4_K_M.gguf', url: 'https://example.invalid/M.gguf', bytes: 21166758784 }) } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
	baseUrl: everyday.baseUrl, model: 'everyday-model', apiKey: 'k', runpodApiKey: rp.state.key, runpodBaseUrl: rp.baseUrl, runpodGraphqlUrl: rp.graphqlUrl,
	podProxyTemplate: machine.baseUrl.replace(/\/v1$/, ''), idleMinutes: '5'
}) });

const browser = await chromium.launch();
const page = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
const problems = [];
const fail = (what) => { problems.push(what); console.log('PROBLEM', what); };
page.on('pageerror', (e) => fail(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail(`console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());
const wait = (ms) => page.waitForTimeout(ms);
async function tap(locator) {
	await locator.scrollIntoViewIfNeeded();
	const b = await locator.boundingBox();
	if (!b) return fail(`cannot tap ${locator}`);
	await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
	await wait(300);
}
const shot = (name) => page.screenshot({ path: join(dir, `${name}.png`) });
const text = (sel) => page.locator(sel).innerText();

await page.goto(`${base}/`);
await tap(page.locator('#model-chip'));
const rows = await page.locator('#models-body .opt .opt-title').allInnerTexts();
console.log('rows:', rows.slice(0, 2));
if (rows[0].trim() !== 'Qwen 3.6 35B' || rows[1].trim() !== 'Qwen 3.6 35B Uncensored') fail(`row names: ${rows.slice(0, 2)}`);

// Turn on the uncensored one.
await tap(page.locator('#models-body .opt', { hasText: 'Qwen 3.6 35B Uncensored' }));
await tap(page.locator('#models-body .switch'));
await page.waitForSelector('.wake .btn-primary', { timeout: 10000 });
console.log('price:', (await text('.wake')).split('\n')[0]);
await tap(page.locator('.wake .btn-primary'));
await page.waitForSelector('#models-body .boot', { timeout: 10000 });
await shot('1-starting');
const names = (await text('#models-body')).match(/Qwen 3\.6 35B Uncensored/g) || [];
if (names.length !== 1) fail(`while loading the name appears ${names.length} times (want 1, in the progress card)`);
if (await page.locator('#models-body .opt', { hasText: /Qwen|Gemma|Mistral/ }).count()) fail('private model rows still listed while loading');

// The machine reports: up, downloading with real numbers.
say('downloading', 0, 0); ev('Machine is up: NVIDIA GeForce RTX 3090, 24576 MiB'); ev('Downloading 21.2 GB to your storage (only needed once)');
await wait(1500);
say('downloading', 4e9, 9.5e7); await wait(2000);
say('downloading', 8.2e9, 9.5e7); ev('Downloading 8.2/21.2 GB at 95 MB/s'); await wait(3500);
const card = await text('#models-body .boot');
if ((card.match(/Qwen 3\.6 35B Uncensored/g) || []).length !== 1) fail('the name shows more than once in the progress card');
console.log('card:', card.replace(/\n/g, ' | '));
if (!/Downloading the model/.test(card)) fail('download step not shown');
if (!/8\.2 GB of 21\.2 GB/.test(card)) fail('GB done / total not shown');
if (!/MB\/s/.test(card)) fail('speed not shown');
if (!/left/.test(card)) fail('no time left from the real speed');

// Backend log: collapsed by default, opens on tap, times on every line.
const log = page.locator('#models-body details.brain-log');
if (await log.evaluate((d) => d.open)) fail('log open by default');
await tap(log.locator('summary'));
await wait(300);
const lines = await log.locator('.brain-log-line').allInnerTexts();
console.log('log:\n  ' + lines.join('\n  '));
if (!lines.every((l) => /^\d\d:\d\d:\d\d /.test(l))) fail('a log line without a time');
if (!lines.some((l) => /GPU found: RTX 3090/.test(l))) fail('no "GPU found" in the log');
if (!lines.some((l) => /Downloading 8\.2\/21\.2 GB at 95 MB\/s/.test(l))) fail("machine's download event missing");
await shot('2-downloading-log');

// Loading, then ready.
say('loading', 21166758784); ev('Download finished: 21.2 GB'); ev('Loading the model into the GPU'); await wait(2500);
if (!/Loading the model into the GPU/.test(await text('#models-body .boot'))) fail('loading step not shown');
say('ready', 21166758784); ev('Ready: loaded in 41 s');
await page.waitForFunction(() => !document.querySelector('#models-body .boot'), null, { timeout: 15000 }).catch(() => fail('never showed ready'));
await shot('3-ready');
await tap(page.locator('#models-close'));

// The session chip, top-right.
const chip = page.locator('#session-chip');
await chip.waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail('session chip not shown'));
const box = await chip.boundingBox();
const vw = page.viewportSize().width;
console.log('chip:', await chip.innerText(), `at x=${Math.round(box.x)}..${Math.round(box.x + box.width)} of ${vw}, y=${Math.round(box.y)}`);
if (!/^Qwen · \d+:\d\d left$/.test(await chip.innerText())) fail(`chip text: ${await chip.innerText()}`);
if (box.y > 80 || box.x < vw / 2) fail('chip is not in the top-right corner');
// The idle rule is set to 5 minutes for this test, so it starts at 5:00: yellow.
if (!(await chip.evaluate((c) => c.classList.contains('warn')))) fail('chip not yellow at 5 minutes');
await shot('4-chip-yellow');

// Tap: menu with the hourly cost, extend.
await tap(chip);
const menu = await text('#session-body');
console.log('menu:', menu.replace(/\n/g, ' | '));
if (!/\$0\.\d\d per hour/.test(menu)) fail('hourly cost not in the menu');
await shot('5-menu');
await tap(page.locator('#session-body button', { hasText: 'Add 30 min' }));
await wait(800);
const after = await chip.innerText();
console.log('after extend:', after);
if (!/^Qwen · 3\d:\d\d left$/.test(after)) fail(`extend did not add 30 min: ${after}`);
if (await chip.evaluate((c) => c.classList.contains('warn'))) fail('still yellow after extending');
if (!machine.state.extended) fail("the machine's own timer was not extended");

await page.goBack().catch(() => {});
await wait(300);
if (await page.locator('#session').evaluate((d) => d.open)) fail('Back did not close the session menu');
if (!page.url().startsWith(base)) fail('Back left the app');

await browser.close(); await app.close(); await rp.close(); await machine.close(); await everyday.close();
console.log(`screenshots in ${dir}`);
console.log(problems.length ? `${problems.length} problem(s)` : 'Brain panel OK');
process.exit(problems.length ? 1 : 0);
