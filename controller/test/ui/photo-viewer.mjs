// Checks the full-screen picture viewer on a phone: opening a result, swiping and arrows,
// zoom, Save, and that Back (gesture or button) closes it and stays in the app.
// Run: node test/ui/photo-viewer.mjs
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/server.js';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const pictures = [readFileSync(join(here, '../../public/icon-512.png')), readFileSync(join(here, '../../public/icon-192.png'))];
const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'photo-ui-')), watchdogMs: 0 });
const { port } = await app.listen(0, '127.0.0.1');
const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['Pixel 7'] });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const problems = [];
const fail = (what) => { problems.push(what); console.log('PROBLEM', what); };
page.on('pageerror', (e) => fail(`page error: ${e.message}`));
page.on('popup', () => fail('a new tab or window opened'));
const wait = (ms) => page.waitForTimeout(ms);

// Three finished pictures in two results.
await page.route('**/api/images', async (route) => {
	const res = await route.fetch();
	const d = await res.json();
	d.generations = [
		{ id: 'g2', status: 'done', prompt: 'second', params: { count: 1 }, images: ['p3'] },
		{ id: 'g1', status: 'done', prompt: 'first', params: { count: 2 }, images: ['p1', 'p2'] }
	];
	await route.fulfill({ json: d });
});
await page.route('**/api/uploads/p*', (route) => route.fulfill({ body: pictures[route.request().url().endsWith('p2') ? 1 : 0], contentType: 'image/png' }));

async function tap(locator) {
	await locator.scrollIntoViewIfNeeded();
	const b = await locator.boundingBox();
	await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
	await wait(300);
}
async function swipe(dx) {
	const x = 200, y = 450;
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
	for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 8, y }] }); await wait(16); }
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await wait(300);
}
const open = () => page.locator('#photo').evaluate((d) => d.open);
const shown = () => page.locator('#photo-img').evaluate((i) => new URL(i.src).pathname);
const inApp = async () => page.url().startsWith(`http://127.0.0.1:${port}/`) && (await page.locator('#characters').isVisible());

await page.goto(`http://127.0.0.1:${port}/`);
await tap(page.locator('#menu'));
await tap(page.locator('#open-characters'));
await page.waitForSelector('.shot-open');

// open the second picture of the first result
await tap(page.locator('.shot-open').nth(2));
if (!(await open())) fail('tapping a picture did not open the viewer');
if ((await shown()) !== '/api/uploads/p2') fail(`opened ${await shown()} instead of p2`);
if ((await page.locator('#photo-count').textContent()) !== '3 of 3') fail(`count shows ${await page.locator('#photo-count').textContent()}`);
if (!(await page.locator('#photo-next').isHidden())) fail('next arrow shown on the last picture');
if ((await page.locator('#photo-save').getAttribute('href')) !== '/api/uploads/p2') fail('Save does not point at the shown picture');

// swipe right goes back one, arrows go both ways
await swipe(160);
if ((await shown()) !== '/api/uploads/p1') fail(`swipe right showed ${await shown()}`);
await tap(page.locator('#photo-prev'));
if ((await shown()) !== '/api/uploads/p3') fail(`previous arrow showed ${await shown()}`);
if (!(await page.locator('#photo-prev').isHidden())) fail('previous arrow shown on the first picture');
await swipe(-160);
if ((await shown()) !== '/api/uploads/p1') fail(`swipe left showed ${await shown()}`);

// tap zooms in and out; a swipe while zoomed pans instead of changing picture
await tap(page.locator('#photo-img'));
if (!(await page.locator('#photo-stage').evaluate((s) => s.classList.contains('zoomed')))) fail('tap did not zoom in');
await swipe(-160);
if ((await shown()) !== '/api/uploads/p1') fail('swiping while zoomed changed the picture');
await tap(page.locator('#photo-img'));
if (await page.locator('#photo-stage').evaluate((s) => s.classList.contains('zoomed'))) fail('second tap did not zoom out');

// Back gesture closes the viewer and stays on Characters
await page.goBack();
await wait(400);
if (await open()) fail('Back did not close the viewer');
if (!(await inApp())) fail(`Back from the viewer left Characters (url ${page.url()})`);

// close button, then Back still leaves Characters normally (no stuck history entry)
await tap(page.locator('.shot-open').first());
await tap(page.locator('#photo-close'));
if (await open()) fail('close button did not close the viewer');
if (!(await inApp())) fail('close button left Characters');
await page.goBack();
await wait(400);
if (await page.locator('#characters').isVisible()) fail('Back after closing the viewer did not leave Characters (stale history entry)');
if (!page.url().startsWith(`http://127.0.0.1:${port}/`)) fail('Back after closing the viewer left the app');

// open/close many times quickly, then Back still behaves
await tap(page.locator('#menu'));
await tap(page.locator('#open-characters'));
for (let i = 0; i < 8; i++) { await tap(page.locator('.shot-open').nth(i % 3)); if (i % 2) await page.goBack(); else await tap(page.locator('#photo-close')); await wait(150); }
if (await open()) fail('viewer left open after rapid open/close');
if (!(await inApp())) fail('rapid open/close left Characters');
await page.goBack();
await wait(400);
if (await page.locator('#characters').isVisible()) fail('Back after rapid open/close did not leave Characters');

await browser.close();
await app.close();
console.log(`picture viewer: ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
process.exit(problems.length ? 1 : 0);
