// Real-touch check of Pose mode in the body editor on a phone screen: the on/off switch, presets,
// joint sliders, dragging a hand and the hips like a puppet, mirror, and a pose sent through the
// API showing up in the open editor. Run: node test/ui/pose.mjs [device] [screenshot dir]
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../../src/server.js';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'pose-ui-')), watchdogMs: 0 });
const { port } = await app.listen(0, '127.0.0.1');
const shots = process.argv[3] || null;
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
const shot = async (name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
async function touchDrag(x0, y0, x1, y1, steps = 14) {
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
	await wait(40);
	for (let i = 1; i <= steps; i++) {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps }] });
		await wait(40);
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await wait(400);
}
async function tap(locator) {
	await locator.scrollIntoViewIfNeeded();
	const b = await locator.boundingBox();
	if (!b) return fail(`cannot tap ${locator}`);
	await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
	await wait(250);
}
const figure = async () => { await wait(300); return createHash('md5').update(await page.evaluate(() => document.querySelector('#body-view canvas').toDataURL())).digest('hex'); };
const values = () => page.evaluate(() => JSON.parse(localStorage.getItem('bodyCurrent') || 'null'));
const handle = (name) => page.evaluate((n) => document.querySelector('#body-view canvas').poseHandle(n), name);

await page.goto(`http://127.0.0.1:${port}/`);
await wait(500);
await tap(page.locator('#menu, #open-drawer, [aria-label="Menu"]').first());
await tap(page.locator('#open-characters'));
await tap(page.locator('#img-shape-open'));
await page.waitForFunction(() => document.querySelector('#body-view canvas'), null, { timeout: 10000 });
await wait(3000);

// ---- off by default: no dots, the old arm buttons show
if (await handle('hand.L')) fail('dots show while Pose mode is off');
if ((await values())?.posing) fail('Pose mode started on');
let before = await figure();

// ---- the switch on the figure turns it on
await tap(page.locator('#body-pose-toggle'));
await wait(600);
if (!(await values()).posing) fail('Pose switch did not turn Pose mode on');
if (!(await handle('hand.L'))) fail('no dots in Pose mode');
if ((await page.locator('#body-pose-toggle').textContent()) !== 'Pose: on') fail('switch label did not change');
await shot('1-pose-on');

// ---- drag her right hand (on the left of the screen) up and out
{
	const h = await handle('hand.R');
	const lift0 = (await values()).pose['upperArm.R']?.lift || 0;
	await touchDrag(h.x, h.y, Math.max(5, h.x - 60), h.y - 220);
	const v = await values();
	const lift = v.pose['upperArm.R']?.lift || 0;
	if (!(lift > lift0 + 40)) fail(`dragging the hand up did not raise the arm (lift ${lift0} → ${lift})`);
	// The arm follows the finger: let go about head height, the hand ends about head height (the
	// view may zoom out once to fit the wider pose, so compare with the head, not the screen).
	const h2 = await handle('hand.R'), head = await handle('head'), chest = await handle('chest');
	if (!(h2.y < chest.y && Math.abs(h2.y - head.y) < 40)) fail(`the hand did not end where it was let go (hand ${Math.round(h2.y)}, head ${Math.round(head.y)}, chest ${Math.round(chest.y)})`);
	await shot('2-hand-dragged');
}

// ---- drag the hips down with feet planted: knees bend, feet stay
{
	const f0 = await handle('foot.L');
	const h = await handle('hips');
	await touchDrag(h.x, h.y, h.x, h.y + 90);
	const v = await values();
	if (!((v.pose['shin.L']?.bend || 0) > 25)) fail(`pulling the hips down did not bend the knees (${JSON.stringify(v.pose['shin.L'])})`);
	const f1 = await handle('foot.L');
	if (Math.abs(f1.x - f0.x) > 25) fail(`planted foot moved sideways ${f1.x - f0.x}px`);
	await shot('3-hips-down');
}

// ---- dragging away from the dots still turns the figure
{
	const box = await page.locator('#body-view').boundingBox();
	before = await figure();
	await touchDrag(box.x + 12, box.y + box.height * 0.3, box.x + 130, box.y + box.height * 0.3);
	if ((await figure()) === before) fail('dragging off the dots did not turn the figure');
	await tap(page.locator('.body-views button', { hasText: /^Front$/ }));
}

// ---- Pose tab: presets, mirror, sliders, off switch
await tap(page.locator('#body-tabs button[data-tab="pose"]'));
await tap(page.locator('#body-pose-presets button', { hasText: /^Waving$/ }));
{
	const v = await values();
	if (Math.round(v.pose['upperArm.R'].lift) !== 96) fail('Waving preset not applied');
	await shot('4-waving');
	await tap(page.locator('#body-pose-mirror'));
	const m = await values();
	if (Math.round(m.pose['upperArm.L']?.lift || 0) !== 96) fail('Mirror did not swap sides');
	const slider = page.locator('#body-pose-sliders input[aria-label="Knee (her left) bend"]');
	await slider.evaluate((i) => { i.value = '70'; i.dispatchEvent(new Event('input', { bubbles: true })); });
	await wait(300);
	if ((await values()).pose['shin.L'].bend !== 70) fail('knee slider did not set the pose');
}
before = await figure();
await tap(page.locator('#body-posing'));
await wait(400);
if ((await values())?.posing) fail('Pose mode checkbox did not turn it off');
if (await handle('hand.L')) fail('dots still showing with Pose mode off');
if ((await figure()) === before) fail('turning Pose mode off did not change the figure');
if (!(await values()).pose['shin.L']) fail('the pose was lost when Pose mode was turned off');

// ---- a pose sent remotely shows up in the open editor
await wait(1200);
const presets = (await (await fetch(`http://127.0.0.1:${port}/api/body/pose/guide`)).json()).presets;
const cur = (await (await fetch(`http://127.0.0.1:${port}/api/body/current`)).json()).values;
before = await figure();
await fetch(`http://127.0.0.1:${port}/api/body/current`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: { ...cur, posing: true, pose: presets['Sitting (chair)'] }, source: 'test' }) });
await wait(3000);
{
	const v = await values();
	if (!v.posing || Math.round(v.pose['thigh.L'].forward) !== 88) fail('a pose sent through the API did not reach the editor');
	if ((await figure()) === before) fail('the editor did not redraw the pose sent through the API');
	await shot('5-remote-sitting');
}

await browser.close();
await app.close?.();
console.log(problems.length ? `${problems.length} problem(s)` : 'Pose mode: all checks passed');
process.exit(problems.length ? 1 : 0);
