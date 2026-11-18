// "From a picture…" in the Characters Pose section: the pose in an uploaded picture is put on the
// body and drawn as a strict guide. The picture is the app's own mannequin in a known pose (Hands on
// hips, turned 30 degrees), so the right answer is known. Checks the pose that reaches the depth
// drawing, the thumbnail, strict on, and what Generate sends. Run: node test/ui/pose-from-picture.mjs
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server.js';
import { renderBody } from '../../src/body-depth.js';
import * as body from '../../public/body.js';
import { POSE_PRESETS, rigFrames, effectorAt } from '../../public/pose.js';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const dir = mkdtempSync(join(tmpdir(), 'pose-pic-'));
const TARGET = { ...POSE_PRESETS['Hands on hips'], hips: { turn: 30 } };
const picture = join(dir, 'pose.png');
writeFileSync(picture, (await renderBody({ posing: true, pose: TARGET }, { width: 640, height: 960 })).preview);
const app = createApp({ dataDir: dir, watchdogMs: 0 });
const { port } = await app.listen(0, '127.0.0.1');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
const problems = [];
const fail = (w) => { problems.push(w); console.log('PROBLEM', w); };
page.on('pageerror', (e) => fail(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|GPU|delegate|WebGL/i.test(m.text())) fail(`console: ${m.text()}`); });
await page.route('**/api/images', async (route) => { const r = await route.fetch(); const d = await r.json(); d.session = { ...d.session, state: 'ready', podId: 'pod1' }; await route.fulfill({ json: d }); });
const drawn = [], sent = [];
await page.route('**/api/body/depth', async (route) => { drawn.push(JSON.parse(route.request().postData())); await route.continue(); });
await page.route('**/api/images/generate', async (route) => { sent.push(JSON.parse(route.request().postData())); await route.fulfill({ json: { id: 'g1' } }); });
const tap = async (l) => { await l.scrollIntoViewIfNeeded(); const b = await l.boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(400); };

await page.goto(`http://127.0.0.1:${port}/`);
await tap(page.locator('#menu')); await tap(page.locator('#open-characters'));
await page.waitForSelector('#img-pose-chips button', { timeout: 10000 });
if (!(await page.locator('#img-pose-chips button', { hasText: 'From a picture…' }).count())) fail('no "From a picture…" chip');
const t0 = Date.now();
await page.locator('#img-pose-file').setInputFiles(picture);
await page.waitForFunction(() => document.querySelector('#img-shape-thumb img'), null, { timeout: 90000 }).catch(() => fail('no thumbnail'));
console.log(`picture to guide: ${((Date.now() - t0) / 1000).toFixed(1)} s · note: ${await page.locator('#img-pose-note').innerText()}`);
if (!(await page.locator('#img-pose-chips button.on', { hasText: 'From your picture' }).count())) fail('"From your picture" not chosen');
if (!(await page.locator('#img-pose-strict').isChecked())) fail('strict not on');
if (await page.locator('#img-pose-view').inputValue() !== '0') fail('view not set to front (the picture\'s own camera)');

// How close is the pose that was drawn to the true one? Hands and elbows relative to the hips.
const got = drawn.at(-1)?.values?.pose;
await body.loadHuman(undefined, (u) => readFile(u));
const poser = body.createPoser(body.defaults('female'));
const upc = poser.toUnits([1, 0, 0], 0)[0] - poser.toUnits([0, 0, 0], 0)[0];
const fa = rigFrames(poser.rest, got || {}, upc), fb = rigFrames(poser.rest, TARGET, upc);
const off = ['hand.L', 'hand.R', 'elbow.L', 'elbow.R', 'knee.L', 'knee.R', 'foot.L', 'foot.R', 'head'].map((n) => {
	const a = effectorAt(poser.rest, fa, n), b = effectorAt(poser.rest, fb, n);
	return [n, Math.hypot(...a.map((v, k) => (v - fa.pp[0][k]) - (b[k] - fb.pp[0][k]))) / upc];
});
console.log('drawn pose: turn', got?.hips?.turn?.toFixed(0), '· upper arms lift', got?.['upperArm.L']?.lift?.toFixed(0), got?.['upperArm.R']?.lift?.toFixed(0), '· elbows', got?.['forearm.L']?.bend?.toFixed(0), got?.['forearm.R']?.bend?.toFixed(0), '(true: turn 30, lift 50, elbows 80)');
console.log('distance from the true pose:', off.map(([n, d]) => `${n} ${d.toFixed(0)}`).join(', '), 'cm');
if (Math.max(...off.map((x) => x[1])) > 15) fail('the drawn pose is more than 15 cm from the picture\'s');

await page.locator('#img-prompt').fill('a woman in a park');
await tap(page.locator('#img-go'));
await page.waitForTimeout(800);
const g = sent.at(-1);
console.log('Generate sent:', g && { depth: Boolean(g.depth), depthStrength: g.depthStrength, pose: g.pose });
if (!g?.depth || g.depthStrength !== 1 || !/exactly the pose/.test(g.pose || '')) fail('Generate did not send the strict pose guide');
await page.locator('#img-pose-chips').scrollIntoViewIfNeeded();
await page.screenshot({ path: join(dir, 'pose-from-picture.png') });
await browser.close(); await app.close();
console.log(`screenshot ${join(dir, 'pose-from-picture.png')}`);
console.log(problems.length ? `${problems.length} problem(s)` : 'Pose from picture OK');
process.exit(problems.length ? 1 : 0);
