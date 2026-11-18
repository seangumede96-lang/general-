// Two people interacting (the app's own mannequins, composited): they walk towards each other
// from opposite sides, pass close with overlapping arms, and high-five. Checks the automatic run
// keeps them apart (no swapped tracks), and that each one's own movements come out.
// Run: node test/ui/animation-two.mjs <path to two.mp4>
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server.js';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const dir = mkdtempSync(join(tmpdir(), 'anim-two-'));
const app = createApp({ dataDir: dir, watchdogMs: 0 });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
const problems = [];
const fail = (what) => { problems.push(what); console.log('PROBLEM', what); };
page.on('pageerror', (e) => fail(`page error: ${e.message}`));
await page.goto(`${base}/#animate`);
await page.waitForSelector('#anim-file', { state: 'attached' });
const t0 = Date.now();
await page.locator('#anim-file').setInputFiles(process.argv[2]);
await page.waitForSelector('.anim-result', { timeout: 300000 }).catch(async () => fail(`no result: ${await page.locator('#anim-run').innerText()}`));
console.log(`run: ${Math.round((Date.now() - t0) / 1000)} s · ${await page.locator('#anim-run').innerText()}`);
await page.waitForTimeout(2000);
await page.screenshot({ path: join(dir, 'person1.png') });
if (await page.locator('.anim-people button').count() === 2) { await page.locator('.anim-people button').nth(1).click(); await page.waitForTimeout(2000); await page.screenshot({ path: join(dir, 'person2.png') }); }
else fail('no person switcher for two people');

const { motions } = await (await fetch(`${base}/api/motions`)).json();
console.log(`${motions.length} motions saved`);
if (motions.length !== 2) fail(`expected 2 people, got ${motions.length}`);
const full = await Promise.all(motions.map((m) => fetch(`${base}/api/motions/${m.id}`).then((r) => r.json())));
const r = (x) => Math.round(x);
for (const m of full) {
	const f = m.frames, n = f.length;
	const x = f.map((fr) => fr.root[0]);
	const turn = f.slice(0, 30).map((fr) => fr.pose.hips?.turn || 0).reduce((a, b) => a + b, 0) / 30;
	const liftL = Math.max(...f.slice(40).map((fr) => fr.pose['upperArm.L']?.lift || 0)), liftR = Math.max(...f.slice(40).map((fr) => fr.pose['upperArm.R']?.lift || 0));
	// A swap shows up as a jump in the root path.
	let jump = 0; for (let i = 1; i < n; i++) jump = Math.max(jump, Math.abs(x[i] - x[i - 1]));
	console.log(`${m.name}: ${n} frames · root x ${r(x[0])} → ${r(x[33])} → ${r(x.at(-1))} cm (largest step ${r(jump)} cm) · turn ${r(turn)}° · arm lift at the end L ${r(liftL)}° R ${r(liftR)}° · seen ${JSON.stringify(Object.fromEntries(Object.entries(m.quality).filter(([k]) => k !== 'uncertain').map(([k, v]) => [k, v.seen])))}`);
	console.log('   seen per frame (hips):', f.map((fr) => (fr.conf.hips >= 0.5 ? '█' : '·')).join(''));
	m.check = { dx: x[33] - x[0], turn, liftL, liftR, jump };
}
// Person A walks to the camera's right, faces her left (+turn), raises her LEFT arm; B the opposite.
const a = full.find((m) => m.check.dx > 0), b = full.find((m) => m.check.dx < 0);
if (!a || !b) fail('the two did not come out as one walking right and one walking left');
else {
	if (!(a.check.turn > 10)) fail(`A should face her left (turn > 10°), got ${r(a.check.turn)}°`);
	if (!(b.check.turn < -10)) fail(`B should face her right (turn < -10°), got ${r(b.check.turn)}°`);
	if (!(a.check.liftL > 100 && a.check.liftL > a.check.liftR + 40)) fail(`A's high five should be her left arm (L ${r(a.check.liftL)}°, R ${r(a.check.liftR)}°)`);
	if (!(b.check.liftR > 100 && b.check.liftR > b.check.liftL + 40)) fail(`B's high five should be her right arm (L ${r(b.check.liftL)}°, R ${r(b.check.liftR)}°)`);
	for (const m of [a, b]) if (m.check.jump > 40) fail(`${m.name}: a jump of ${r(m.check.jump)} cm between frames (tracks swapped?)`);
	// One shared origin: in the clip they start about 145 cm apart and end about 40 cm apart (hips).
	const gap = (i) => b.frames[i].root[0] - a.frames[i].root[0];
	console.log(`gap between them: start ${r(gap(1))} cm, end ${r(gap(49))} cm; A starts at x ${r(a.frames[1].root[0])}, B at ${r(b.frames[1].root[0])}`);
	if (!(gap(1) > 100 && gap(1) < 200)) fail(`start gap ${r(gap(1))} cm (about 145 expected)`);
	if (!(gap(49) > 15 && gap(49) < 80)) fail(`end gap ${r(gap(49))} cm (about 40 expected)`);
}
await browser.close(); await app.close();
console.log(`screenshots in ${dir}`);
console.log(problems.length ? `${problems.length} problem(s)` : 'Two people OK');
process.exit(problems.length ? 1 : 0);
