// The Characters page's Pose section on a phone: the pose chips render; picking one draws a brown
// thumbnail of that pose on the body; changing the view redraws it; "strict" locks the shape
// slider; Generate sends the pose's depth guide at strength 1.0 with the pose in words; None clears
// it; and "Use this body" from the editor afterwards replaces the pose guide. The session and
// Generate are faked (no GPU). Run: node test/ui/pose-section.mjs
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server.js';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'pose-sec-')), watchdogMs: 0 });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
const problems = [];
const fail = (w) => { problems.push(w); console.log('PROBLEM', w); };
page.on('pageerror', (e) => fail(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail(`console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());
// A ready picture session, and Generate captured instead of sent to a GPU.
await page.route('**/api/images', async (route) => { const r = await route.fetch(); const d = await r.json(); d.session = { ...d.session, state: 'ready', podId: 'pod1', gpu: 'A40', rate: 0.59 }; await route.fulfill({ json: d }); });
const sent = [];
await page.route('**/api/images/generate', async (route) => { sent.push(JSON.parse(route.request().postData())); await route.fulfill({ json: { id: 'g1' } }); });
const tap = async (l) => { await l.scrollIntoViewIfNeeded(); const b = await l.boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(400); };
const thumb = () => page.locator('#img-shape-thumb img').getAttribute('src').catch(() => null);
const waitThumb = async (not) => { for (let i = 0; i < 60; i++) { const s = await thumb(); if (s && s !== not) return s; await page.waitForTimeout(250); } return null; };
const brown = async (src) => page.evaluate(async (src) => {
	const img = new Image(); img.src = src; await img.decode();
	const c = document.createElement('canvas'); c.width = 60; c.height = 90; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 60, 90);
	const d = g.getImageData(0, 0, 60, 90).data; let r = 0, gg = 0, b = 0, n = 0;
	for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 700) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
	return n ? [Math.round(r / n), Math.round(gg / n), Math.round(b / n), n] : null;
}, src);

await page.goto(`${base}/`);
await tap(page.locator('#menu')); await tap(page.locator('#open-characters'));
await page.waitForSelector('#img-pose-chips button', { timeout: 10000 });
const chips = await page.locator('#img-pose-chips button').allInnerTexts();
console.log(`${chips.length} chips: ${chips.join(' | ')}`);
if (chips.length < 10 || chips[0] !== 'None') fail('pose chips missing');

await tap(page.locator('#img-pose-chips button', { hasText: /^Waving$/ }));
const s1 = await waitThumb(null);
if (!s1) fail('no thumbnail after picking Waving');
else { const c = await brown(s1); console.log('thumbnail colour', c); if (!c || !(c[0] > c[1] && c[1] > c[2])) fail(`thumbnail is not brown: ${c}`); }
if (!(await page.locator('#img-pose-chips button.on', { hasText: 'Waving' }).count())) fail('Waving not shown as chosen');

await page.locator('#img-pose-view').selectOption('90');
const s2 = await waitThumb(s1);
if (!s2) fail('changing the view did not redraw the thumbnail');

if (!(await page.locator('#img-shape-strength').isDisabled())) fail('strict did not lock the shape slider');
console.log('strict text:', await page.locator('#img-shape-strength-text').innerText());
await tap(page.locator('#img-pose-strict'));
if (await page.locator('#img-shape-strength').isDisabled()) fail('unticking strict did not unlock the slider');
await tap(page.locator('#img-pose-strict'));

await page.locator('#img-prompt').fill('a dancer on a stage');
await tap(page.locator('#img-go'));
await page.waitForTimeout(800);
const g = sent.at(-1);
console.log('Generate sent:', g && { depth: Boolean(g.depth), depthStrength: g.depthStrength, pose: g.pose });
if (!g) fail('Generate sent nothing');
else {
	if (!g.depth) fail('no depth guide sent');
	if (g.depthStrength !== 1) fail(`strict should send depth strength 1, sent ${g.depthStrength}`);
	if (!/wav/i.test(g.pose) || !/left side/i.test(g.pose)) fail(`pose words wrong: ${g.pose}`);
}

await tap(page.locator('#img-pose-chips button', { hasText: /^None$/ }));
await page.waitForTimeout(500);
if (await page.locator('#img-shape-thumb img').count()) fail('None did not clear the pose guide');
if (!(await page.locator('#img-pose-chips button.on', { hasText: /^None$/ }).count())) fail('None not shown as chosen');

// A pose, then "Use this body" from the editor: the body replaces the pose guide.
await tap(page.locator('#img-pose-chips button', { hasText: /^Arms up$/ }));
const s3 = await waitThumb(null);
await tap(page.locator('#img-shape-open'));
await page.waitForFunction(() => document.querySelector('#body-view canvas'), null, { timeout: 30000 });
await page.waitForTimeout(1500);
await tap(page.locator('#body-use'));
await page.waitForFunction(() => !document.querySelector('#characters').hidden, null, { timeout: 20000 }).catch(() => fail('Use this body did not return to Characters'));
const s4 = await waitThumb(s3);
await page.waitForTimeout(500);
const onChip = await page.locator('#img-pose-chips button.on').allInnerTexts();
console.log('after Use this body: thumbnail changed', Boolean(s4 && s4 !== s3), '· chosen chip', onChip);
if (!s4 || s4 === s3) fail('Use this body did not replace the pose guide');
if (onChip[0] !== 'None') fail(`after Use this body the pose should be None, it is ${onChip}`);
await page.locator('#img-pose-chips').scrollIntoViewIfNeeded();
await page.screenshot({ path: join(tmpdir(), 'pose-section.png') });
await browser.close(); await app.close();
console.log(problems.length ? `${problems.length} problem(s)` : 'Pose section OK');
process.exit(problems.length ? 1 : 0);
