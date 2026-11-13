// Real-touch check of the body editor on a phone screen: navigation, every button, every slider,
// turning the figure, scrolling past controls, saved bodies and handing the body to Characters.
// Touches go through Chrome's own touch input (CDP), so scrolling and slider gestures behave as
// on a phone. Run: node test/ui/body-editor.mjs
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../../src/server.js';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'body-ui-')), watchdogMs: 0 });
const { port } = await app.listen(0, '127.0.0.1');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ ...devices[process.argv[2] || 'Pixel 7'] });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const problems = [];
const fail = (what) => { problems.push(what); console.log('PROBLEM', what); };
page.on('pageerror', (e) => fail(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') fail(`console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());
const wait = (ms) => page.waitForTimeout(ms);

async function touchDrag(x0, y0, x1, y1, steps = 12) {
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
	await wait(30);
	for (let i = 1; i <= steps; i++) {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps }] });
		await wait(16);
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await wait(250);
}
async function tap(locator) {
	await locator.scrollIntoViewIfNeeded();
	const b = await locator.boundingBox();
	if (!b) return fail(`cannot tap ${locator}`);
	await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
	await wait(200);
}
async function longPress(locator) {
	await locator.scrollIntoViewIfNeeded();
	const b = await locator.boundingBox();
	const x = b.x + b.width / 2, y = b.y + b.height / 2;
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
	await wait(900);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await wait(300);
}
// The figure's pixels, read in the page (a locator screenshot would scroll it into view).
const figure = async () => { await wait(250); return createHash('md5').update(await page.evaluate(() => document.querySelector('#body-view canvas').toDataURL())).digest('hex'); };
const scrollY = () => page.evaluate(() => [...document.querySelectorAll('*')].reduce((s, e) => s + e.scrollTop, 0));
const values = () => page.evaluate(() => JSON.parse(localStorage.getItem('bodyCurrent') || 'null'));
const visible = (id) => page.locator(`#${id}`).isVisible();

// ---- getting there: menu → Characters → Open body editor
await page.goto(`http://127.0.0.1:${port}/`);
await wait(500);
const menu = page.locator('#menu, #open-drawer, [aria-label="Menu"]').first();
await tap(menu);
await tap(page.locator('#open-characters'));
if (!(await visible('characters'))) fail('Characters page did not open from the menu');
await tap(page.locator('#img-shape-open'));
if (!(await visible('body'))) fail('body editor did not open');
await page.waitForFunction(() => document.querySelector('#body-view canvas'), null, { timeout: 10000 });
await wait(3000);
const blankCheck = await page.locator('#body-view canvas').screenshot();
if (blankCheck.length < 20000) fail('figure looks blank');

// ---- back gesture/button go back to Characters, then the chat
await page.goBack();
await wait(400);
if (!(await visible('characters'))) fail(`back from the body editor did not return to Characters (url ${page.url()})`);
await tap(page.locator('#img-shape-open'));
if (!(await visible('body'))) fail('body editor did not reopen');
await wait(800);
await tap(page.locator('#back'));
await wait(400);
if (!(await visible('characters'))) fail('header back button in the body editor did not return to Characters');
await tap(page.locator('#img-shape-open'));
await wait(800);

// ---- view buttons and turning by drag
let before = await figure();
for (const name of ['Side', 'Back', 'Front']) {
	await tap(page.locator('.body-views button', { hasText: name }));
	const now = await figure();
	if (now === before) fail(`${name} view button did not turn the figure`);
	before = now;
}
const view = await page.locator('#body-view').boundingBox();
let y0 = await scrollY();
await touchDrag(view.x + view.width * 0.3, view.y + view.height / 2, view.x + view.width * 0.75, view.y + view.height / 2);
if ((await figure()) === before) fail('dragging sideways on the figure did not turn it');
if ((await scrollY()) !== y0) fail('dragging sideways on the figure scrolled the page');
await tap(page.locator('.body-views button', { hasText: 'Front' }));
y0 = await scrollY();
await touchDrag(view.x + view.width / 2, view.y + view.height * 0.8, view.x + view.width / 2, view.y + view.height * 0.2);
if ((await scrollY()) === y0) fail('swiping up on the figure did not scroll the page (could get stuck)');

// ---- base, presets, head shapes, reset
for (const base of ['male', 'female']) {
	before = await figure();
	await tap(page.locator(`#body-base button[data-base=${base}]`));
	if ((await values()).base !== base) fail(`${base} button did not switch the base`);
	if (!(await page.locator(`#body-base button[data-base=${base}]`).evaluate((b) => b.classList.contains('on')))) fail(`${base} button not shown as selected`);
	if ((await figure()) === before) fail(`${base} button did not change the figure`);
	const presets = await page.locator('#body-presets button').allTextContents();
	for (const p of presets) {
		before = await figure();
		await tap(page.locator('#body-presets button', { hasText: p }));
		if ((await figure()) === before && p !== 'Tall') fail(`${base} preset ${p} did not change the figure`);
		if ((await values()).base !== base) fail(`preset ${p} changed the base`);
	}
}
for (const shape of await page.locator('#body-heads button').allTextContents()) {
	await tap(page.locator('#body-heads button', { hasText: shape }));
	if ((await values()).headShape !== shape.toLowerCase()) fail(`head shape ${shape} not applied`);
}
await tap(page.locator('#body-reset'));
const reset = await values();
if (Object.entries(reset).some(([k, v]) => typeof v === 'number' && k !== 'height' && k !== 'version' && v !== 0)) fail(`Reset left values: ${JSON.stringify(reset)}`);

// ---- every slider by touch: drag the thumb and check value, label, figure and page scroll
async function dragSlider(input, vertical, forward) {
	await input.scrollIntoViewIfNeeded();
	await wait(150);
	const b = await input.boundingBox();
	const key = await input.getAttribute('data-key');
	const start = await input.evaluate((i) => Number(i.value));
	const min = Number(await input.getAttribute('min')), max = Number(await input.getAttribute('max'));
	const f = (start - min) / (max - min);
	const sy = await scrollY();
	before = await figure();
	const label = await input.evaluate((i) => (i.closest('.vslider, .hslider').querySelector('span').textContent));
	if (vertical) {
		const x = b.x + b.width / 2, y = b.y + b.height * (1 - f);
		await touchDrag(x, y, x, forward ? b.y + 4 : b.y + b.height - 4);
	} else {
		const x = b.x + b.width * f, y = b.y + b.height / 2;
		await touchDrag(x, y, forward ? b.x + b.width - 4 : b.x + 4, y);
	}
	const end = await input.evaluate((i) => Number(i.value));
	const saved = (await values())[key];
	const label2 = await input.evaluate((i) => (i.closest('.vslider, .hslider').querySelector('span').textContent));
	if (forward ? !(end > start) : !(end < start)) fail(`${key}: dragging ${forward ? 'up/right' : 'down/left'} moved it from ${start} to ${end}`);
	if (Math.abs(saved - end) > 1e-9) fail(`${key}: slider shows ${end} but body uses ${saved}`);
	if (label2 === label) fail(`${key}: value text did not update (${label2})`);
	if ((await figure()) === before) fail(`${key}: figure did not change`);
	if (Math.abs((await scrollY()) - sy) > 2) fail(`${key}: dragging the slider scrolled the page by ${(await scrollY()) - sy}px`);
}
for (const input of await page.locator('#body-vsliders input').all()) { await dragSlider(input, true, true); await dragSlider(input, true, false); }
for (const input of await page.locator('#body-hsliders input').all()) { await dragSlider(input, false, true); await dragSlider(input, false, false); }
// a tap on a horizontal slider's track sets the value there
{
	const input = page.locator('#body-hsliders input').first();
	await input.scrollIntoViewIfNeeded();
	const b = await input.boundingBox();
	await page.touchscreen.tap(b.x + b.width * 0.9, b.y + b.height / 2);
	await wait(200);
	const v = await input.evaluate((i) => (Number(i.value) - Number(i.min)) / (Number(i.max) - Number(i.min)));
	if (Math.abs(v - 0.9) > 0.08) fail(`tapping a slider's track at 90% set it to ${Math.round(v * 100)}%`);
}

// ---- scrolling the page with a finger that lands on a horizontal slider must scroll, not change it
const hs = page.locator('#body-hsliders input').nth(3);
await hs.scrollIntoViewIfNeeded();
const hb = await hs.boundingBox();
const hv = await hs.evaluate((i) => i.value);
y0 = await scrollY();
await touchDrag(hb.x + hb.width * 0.3, hb.y + hb.height / 2, hb.x + hb.width * 0.3, hb.y - 250);
if ((await scrollY()) === y0) fail('swiping up over a slider did not scroll the page');
if ((await hs.evaluate((i) => i.value)) !== hv) fail('swiping up over a slider changed its value');

// ---- saved bodies: save, load, delete
await tap(page.locator('#body-presets button').first());
await page.locator('#body-name').fill('Test body');
await tap(page.locator('#body-save'));
if (!(await page.locator('#body-saved button', { hasText: 'Test body' }).count())) fail('saved body did not appear');
const savedValues = await values();
await tap(page.locator('#body-reset'));
await tap(page.locator('#body-saved button', { hasText: 'Test body' }));
const loaded = await values();
if (JSON.stringify(loaded) !== JSON.stringify(savedValues)) fail(`loading the saved body gave ${JSON.stringify(loaded)}`);
await tap(page.locator('#body-saved .chip-x').first());
if (await page.locator('#body-saved button', { hasText: 'Test body' }).count()) fail('the × did not delete the saved body');

// ---- survives a reload with the same body
await page.reload();
await wait(800);
if (!(await visible('body'))) {
	await tap(page.locator('#menu, #open-drawer, [aria-label="Menu"]').first());
	await tap(page.locator('#open-characters'));
	await tap(page.locator('#img-shape-open'));
}
await wait(2500);
if (JSON.stringify(await values()) !== JSON.stringify(loaded)) fail('body changed after reload');

// ---- use for pictures: back on Characters with the shape set, and Back then leaves to the chat
await page.route('**/api/uploads**', (r) => r.fulfill({ json: { id: 'up1', name: 'body-depth.png' } }));
await tap(page.locator('#body-use'));
await page.waitForFunction(() => !document.querySelector('#characters').hidden, null, { timeout: 15000 }).catch(() => fail('Use this body did not return to Characters'));
await wait(500);
if (!(await page.locator('#img-shape-strength-row').isVisible())) fail('shape was not attached on Characters');
await page.goBack();
await wait(400);
if (await visible('characters') || await visible('body')) fail('back from Characters (after using the body) did not leave the pages');

// ---- rapid random tapping does not break anything
await tap(page.locator('#menu, #open-drawer, [aria-label="Menu"]').first());
await tap(page.locator('#open-characters'));
await tap(page.locator('#img-shape-open'));
await wait(1500);
const targets = ['.body-views button', '#body-base button', '#body-presets button', '#body-heads button', '#body-reset'];
let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
for (let i = 0; i < 60; i++) {
	const all = await page.locator(targets[rnd(targets.length)]).all();
	const t = all[rnd(all.length)];
	const b = await t.boundingBox();
	if (b) { await t.scrollIntoViewIfNeeded(); const bb = await t.boundingBox(); await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2); }
	await wait(rnd(3) * 40);
}
await wait(800);
if (!(await visible('body'))) fail('rapid tapping left the body editor');
if ((await page.locator('#body-view canvas').screenshot()).length < 20000) fail('figure blank after rapid tapping');

await browser.close();
await app.close();
console.log(`${process.argv[2] || 'Pixel 7'}: ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
process.exit(problems.length ? 1 : 0);
