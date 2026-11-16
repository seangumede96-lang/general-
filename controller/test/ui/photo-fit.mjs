// Photo tab, stage 4: consent -> photo -> Find body -> Save -> Fit the figure. The "photo" is the
// app's own mannequin rendered with known sliders (weight +0.8, hips +1.0, from the front), and the
// editor starts at the standard body, so a good fit moves those two sliders up. No real person.
// Run: node test/ui/photo-fit.mjs
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server.js';
import { renderBody } from '../../src/body-depth.js';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const dir = mkdtempSync(join(tmpdir(), 'photo-fit-'));
const TARGET = { weight: 0.8, hips: 1.0 };
const sample = join(dir, 'target.png');
writeFileSync(sample, (await renderBody({ ...TARGET, armPose: 0.4 }, { width: 640, height: 960 })).preview);
const app = createApp({ dataDir: dir, watchdogMs: 0 });
const { port } = await app.listen(0, '127.0.0.1');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
const problems = [];
const fail = (what) => { problems.push(what); console.log('PROBLEM', what); };
page.on('pageerror', (e) => fail(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/WebGL|GPU|delegate|Failed to load resource/i.test(m.text())) fail(`console error: ${m.text()}`); });
const tap = async (sel) => { const l = typeof sel === 'string' ? page.locator(sel) : sel; await l.scrollIntoViewIfNeeded(); const b = await l.boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(300); };
const values = () => page.evaluate(() => JSON.parse(localStorage.getItem('bodyCurrent') || 'null'));

await page.goto(`http://127.0.0.1:${port}/`);
await tap('#menu'); await tap('#open-characters'); await tap('#img-shape-open');
await page.waitForFunction(() => document.querySelector('#body-view canvas'), null, { timeout: 20000 });
const before = await values();
await tap('#body-tabs [data-tab=photo]');
await tap('#photo-consent');
await page.locator('#photo-file').setInputFiles(sample);
await page.waitForFunction(() => !document.querySelector('#photo-canvas').hidden, null, { timeout: 5000 });
await tap('#photo-detect');
await page.waitForFunction(() => /Found the body|No body|could not run/.test(document.querySelector('#photo-status').textContent), null, { timeout: 60000 });
await tap('#photo-ev-save');
await page.waitForFunction(() => /Saved|Could not save/.test(document.querySelector('#photo-status').textContent), null, { timeout: 5000 });
if (await page.locator('#photo-fit').isDisabled()) fail('Fit button not enabled after Save');
const t0 = Date.now();
await tap('#photo-fit');
await page.waitForFunction(() => /Fitted|Could not fit/.test(document.querySelector('#photo-status').textContent), null, { timeout: 120000 }).catch(() => fail('fit never finished'));
const status = await page.locator('#photo-status').textContent();
console.log(`fit took ${Math.round((Date.now() - t0) / 1000)} s: ${status}`);
if (!/Fitted/.test(status)) fail(`fit: ${status}`);
const list = await page.locator('#photo-regions').innerText();
console.log(list);
if (!/What the fit changed/.test(list)) fail('change list not shown');
await page.waitForTimeout(1500);
const after = await values();
const show = (v) => Object.fromEntries(['weight', 'hips', 'waist', 'thighs', 'shoulders', 'chest', 'legLength'].map((k) => [k, Math.round((v?.[k] ?? 0) * 100) / 100]));
console.log('before', JSON.stringify(show(before)));
console.log('after ', JSON.stringify(show(after)));
console.log('target', JSON.stringify(TARGET));
if (!after || JSON.stringify(show(after)) === JSON.stringify(show(before))) fail('the figure did not change');
else {
	if (!((after.weight ?? 0) > 0.2)) fail(`weight should go up towards 0.8, got ${after.weight}`);
	if (!((after.hips ?? 0) + (after.thighs ?? 0) > 0.3)) fail(`hips/thighs should go up, got hips ${after.hips} thighs ${after.thighs}`);
}
await page.screenshot({ path: join(dir, 'fitted.png') });
await browser.close(); await app.close();
console.log(`screenshot ${join(dir, 'fitted.png')}`);
console.log(problems.length ? `${problems.length} problem(s)` : 'Photo fit OK');
process.exit(problems.length ? 1 : 0);
