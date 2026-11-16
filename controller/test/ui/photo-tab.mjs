// Checks the body editor's Photo tab on a phone: the consent tick-box gates it, a photo loads,
// Find body returns 33 points and an outline, a point can be dragged, Save returns an id, no errors.
// The sample "photo" is the app's own rendered mannequin (no real person is used).
// Run: node test/ui/photo-tab.mjs
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server.js';
import { renderBody } from '../../src/body-depth.js';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const dir = mkdtempSync(join(tmpdir(), 'photo-tab-'));
const sample = join(dir, 'mannequin.png');
writeFileSync(sample, (await renderBody({}, { width: 640, height: 960 })).preview);
const app = createApp({ dataDir: dir, watchdogMs: 0 });
const { port } = await app.listen(0, '127.0.0.1');
const browser = await chromium.launch();
const page = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
const problems = [];
const fail = (what) => { problems.push(what); console.log('PROBLEM', what); };
page.on('pageerror', (e) => fail(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') fail(`console error: ${m.text()}`); });
const wait = (ms) => page.waitForTimeout(ms);
async function tap(locator) {
	await locator.scrollIntoViewIfNeeded();
	const b = await locator.boundingBox();
	await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
	await wait(300);
}

await page.goto(`http://127.0.0.1:${port}/`);
await tap(page.locator('#menu'));
await tap(page.locator('#open-characters'));
await tap(page.locator('#img-shape-open'));
await page.waitForFunction(() => document.querySelector('#body-view canvas'), null, { timeout: 15000 });
await tap(page.locator('#body-tabs [data-tab=photo]'));
if (await page.locator('#body .creator-pane[data-pane=photo]').isHidden()) fail('Photo tab did not open');
if (!(await page.locator('#photo-file').isDisabled())) fail('photo can be picked before the consent box is ticked');
await tap(page.locator('#photo-consent'));
if (await page.locator('#photo-file').isDisabled()) fail('ticking consent did not enable the photo picker');
await page.locator('#photo-file').setInputFiles(sample);
await page.waitForFunction(() => !document.querySelector('#photo-canvas').hidden, null, { timeout: 5000 }).catch(() => fail('photo did not load'));
await tap(page.locator('#photo-detect'));
await page.waitForFunction(() => /Found the body|No body|could not run/.test(document.querySelector('#photo-status').textContent), null, { timeout: 60000 }).catch(() => fail('Find body never finished'));
const status = await page.locator('#photo-status').textContent();
console.log('status:', status);
if (!/Found the body/.test(status)) fail(`Find body: ${status}`);
const regions = await page.locator('#photo-regions .photo-region').count();
if (regions < 5) fail(`only ${regions} region lines shown`);

// Save, read the points back, drag the left hip point (23) and save again: it must have moved.
const saveAndRead = async () => {
	await tap(page.locator('#photo-ev-save'));
	await page.waitForFunction(() => /Saved|Could not save/.test(document.querySelector('#photo-status').textContent), null, { timeout: 5000 }).catch(() => {});
	const st = await page.locator('#photo-status').textContent();
	if (!/Saved/.test(st)) { fail(`Save: ${st}`); return null; }
	const id = await page.evaluate(() => localStorage.getItem('photoEvidence'));
	return page.evaluate(async (id) => (await fetch(`/api/uploads/${id}`)).json(), id);
};
const first = await saveAndRead();
if (first) {
	if (first.landmarks.length !== 33) fail(`${first.landmarks.length} landmarks, expected 33`);
	if (!first.mask?.rle?.length) fail('no outline mask saved');
	if (first.consent !== 'own-or-consenting-adult') fail('consent not recorded');
	// The photo sits in the scrolling control panel: bring the hip point into view first.
	await page.evaluate((y) => { const c = document.querySelector('#photo-canvas'), sc = document.querySelector('#body-scroll'); sc.scrollTop += c.getBoundingClientRect().top + y * c.getBoundingClientRect().height - sc.getBoundingClientRect().top - sc.clientHeight / 2; }, first.landmarks[23].y);
	await wait(300);
	const box = await page.locator('#photo-canvas').boundingBox();
	const hip = first.landmarks[23];
	const x = box.x + hip.x * box.width, y = box.y + hip.y * box.height;
	await page.mouse.move(x, y); await page.mouse.down();
	for (let i = 1; i <= 6; i++) { await page.mouse.move(x + 5 * i, y); await wait(16); }
	await page.mouse.up(); await wait(200);
	const second = await saveAndRead();
	if (second) {
		const moved = (second.landmarks[23].x - hip.x) * box.width;
		console.log(`hip moved ${moved.toFixed(1)} px, edited: ${second.landmarks[23].edited}`);
		if (!(moved > 20 && second.landmarks[23].edited)) fail('dragging the hip point did not move it');
	}
}
await page.screenshot({ path: join(dir, 'photo-tab.png'), fullPage: false });
console.log('screenshot', join(dir, 'photo-tab.png'));
await browser.close(); await app.close();
console.log(problems.length ? `${problems.length} problem(s)` : 'Photo tab OK');
process.exit(problems.length ? 1 : 0);
