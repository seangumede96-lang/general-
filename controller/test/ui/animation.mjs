// Phone-screen check of the Animation page: choose a video and everything else is automatic.
// The sample clip is the app's own grey mannequin (made with the server's renderer), so no real
// person is used. Checks: the steps run by themselves, the person is found and fitted, the result
// plays on the figure next to the clip with its skeleton, confidence and a description are shown,
// BVH and FBX download, the library lists it, and the same clip is not analysed twice.
// Run: node test/ui/animation.mjs <path to mannequin.mp4>
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server.js';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const clip = process.argv[2];
const dir = mkdtempSync(join(tmpdir(), 'anim-ui-'));
const app = createApp({ dataDir: dir, watchdogMs: 0 });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
if (existsSync('/opt/blender/blender')) await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blenderPath: '/opt/blender/blender' }) });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true });
const page = await context.newPage();
const problems = [];
const fail = (what) => { problems.push(what); console.log('PROBLEM', what); };
page.on('pageerror', (e) => fail(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|WebGL|GPU|delegate/i.test(m.text())) fail(`console: ${m.text()}`); });
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

await page.goto(`${base}/`);
await tap(page.locator('#menu'));
await tap(page.locator('#open-animate'));
if (await page.locator('#animate').isHidden()) fail('Animation page did not open');
await shot('1-empty');

const t0 = Date.now();
await page.locator('#anim-file').setInputFiles(clip);
await page.waitForSelector('.anim-step.now', { timeout: 10000 }).catch(() => fail('no progress steps'));
await shot('2-running');
await page.waitForSelector('.anim-result', { timeout: 180000 }).catch(async () => fail(`no result: ${await page.locator('#anim-run').innerText()}`));
console.log(`automatic run: ${Math.round((Date.now() - t0) / 1000)} s; ${await page.locator('#anim-run').innerText()}`);
await wait(2500);
await shot('3-result');

const result = await page.locator('.anim-result').innerText();
console.log(result.split('\n').slice(0, 30).join('\n'));
if (!(await page.locator('.anim-result video').count())) fail('the clip is not shown');
if (!(await page.locator('.anim-figure canvas').count())) fail('the figure is not shown');
if ((await page.locator('.anim-conf-row').count()) < 4) fail('confidence rows missing');
if (!/Torso inclination/.test(result)) fail('no movement description');
const overlay = await page.locator('.anim-overlay').evaluate((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
if (overlay < 50) fail('no skeleton drawn over the clip');
const f1 = await page.locator('.anim-scrub').inputValue(); await wait(800);
const f2 = await page.locator('.anim-scrub').inputValue();
if (f1 === f2) fail('not playing');

// The motion itself: arms go overhead in the second half (the clip's "Arms up").
const lib = await (await fetch(`${base}/api/motions`)).json();
const m = await (await fetch(`${base}/api/motions/${lib.motions[0].id}`)).json();
const lifts = m.frames.map((f) => Math.round(f.pose['upperArm.L']?.lift || 0));
console.log('left arm lift over time:', lifts.join(' '));
if (Math.max(...lifts.slice(25)) < 120) fail('arms up was not found');
if (Math.max(...lifts.slice(0, 8)) > 40) fail('arms not down at the start');

// Downloads.
const [bvh] = await Promise.all([page.waitForEvent('download'), page.locator('.anim-export a', { hasText: 'BVH' }).click()]);
console.log('BVH download:', bvh.suggestedFilename());
if (existsSync('/opt/blender/blender')) {
	const [fbx] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.locator('.anim-export button', { hasText: 'FBX' }).click()]);
	console.log('FBX download:', fbx.suggestedFilename());
}

// Library, and the same clip again: found, not analysed again.
await tap(page.locator('#anim-tabs button', { hasText: 'Library' }));
await page.waitForSelector('.anim-item', { timeout: 5000 }).catch(() => fail('library empty'));
await shot('4-library');
await tap(page.locator('#anim-tabs button', { hasText: 'From video' }));
await page.locator('#anim-file').setInputFiles(clip);
await page.waitForFunction(() => /analysed before/.test(document.querySelector('#anim-run').textContent), null, { timeout: 15000 }).catch(() => fail('the same clip was analysed again'));

// Back leaves the page for the chat, not the app.
await page.goBack(); await wait(500);
if (!page.url().startsWith(base)) fail('Back left the app');

await browser.close(); await app.close();
console.log(`screenshots in ${dir}`);
console.log(problems.length ? `${problems.length} problem(s)` : 'Animation page OK');
process.exit(problems.length ? 1 : 0);
