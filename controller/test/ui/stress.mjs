// UI stress tester. Drives the real page in a headless phone-sized browser against mock
// services and does what an impatient, unlucky user would: taps everything in random order,
// double-taps, sends odd text, reloads mid-reply, loses the network, restarts the app.
// After every action it checks rules that must always hold. Any broken rule is a bug.
//
//   node test/ui/stress.mjs [--seed 1] [--actions 400] [--viewport phone|small|desktop]
//
// Needs Playwright with Chromium (not a dependency of the app itself).
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/server.js';
import { startMockRunpod } from '../mock-runpod.js';
import { startMockModel } from '../mock-model.js';
import { startMockComfy } from '../mock-comfy.js';

const require = createRequire(import.meta.url);
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch { ({ chromium, devices } = createRequire('/')('playwright')); }

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : process.argv[i + 1]; };
const SEED = Number(arg('seed', 1));
const ACTIONS = Number(arg('actions', 400));
const VIEWPORT = arg('viewport', 'phone');

// Deterministic randomness, so a failing run can be replayed with the same seed.
let rngState = SEED * 2654435761 % 2 ** 32;
const rnd = () => { rngState = (rngState * 1664525 + 1013904223) % 2 ** 32; return rngState / 2 ** 32; };
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NASTY_TEXT = [
	'hello', '', '   ', 'a'.repeat(6000), '<script>alert(1)</script><img src=x onerror=alert(2)>', '```js\nunclosed code block',
	'# Heading\n- list\n1. item\n**bold *nested** italic*', '🔥👩🏽‍🎤 emoji ‮right-to-left‬ text', 'line1\n\n\n\nline2', '[link](javascript:alert(1)) [ok](https://example.com)',
	'"quotes" \'single\' `ticks` \\backslash\\ %s %d ${x} {{y}}', 'نص عربي 中文 日本語', '\u0000\u0007 control chars', 'word '.repeat(800)
];

const root = mkdtempSync(join(tmpdir(), 'controller-stress-'));
const filesDir = join(root, 'files');
const here = dirname(fileURLToPath(import.meta.url));
const png = join(here, '..', '..', 'public', 'icon-192.png');
import('node:fs').then(({ mkdirSync }) => mkdirSync(filesDir, { recursive: true }));
await sleep(20);
writeFileSync(join(filesDir, 'note.txt'), 'some text');
writeFileSync(join(filesDir, 'weird name (1) #&?.txt'), 'x');
writeFileSync(join(filesDir, 'empty.txt'), '');
writeFileSync(join(filesDir, 'fake.mp4'), 'not really a video');

const rp = await startMockRunpod();
const comfy = await startMockComfy({ images: 2, pollsUntilDone: 2 });
const TOOL_REPLIES = [
	{ toolCalls: [{ name: 'recall', arguments: {} }] }, { toolCalls: [{ name: 'remember', arguments: { text: 'likes tests' } }] },
	{ toolCalls: [{ name: 'list_files', arguments: {} }] }, { toolCalls: [{ name: 'write_file', arguments: { path: 'out.txt', content: 'x' } }] },
	{ toolCalls: [{ name: 'read_file', arguments: '{"path": ' }] }, { toolCalls: [{ name: 'no_such_tool', arguments: {} }] },
	{ toolCalls: [{ name: 'gpu_status', arguments: {} }] }, { toolCalls: [{ name: 'start_gpu', arguments: { minutes: 5, purpose: 'test' } }] }, { toolCalls: [{ name: 'stop_gpu', arguments: {} }] },
	{ chunks: ['<think>hmm ', 'ok</think>', 'Answer with **markdown** and `code`.\n\n```py\nprint(1)\n```'] }, { chunks: [NASTY_TEXT[4]] }, { chunks: ['short'] }
];
const model = await startMockModel({ chunks: ['Fine.'] });

const dataDir = join(root, 'data');
const options = { dataDir, watchdogMs: 0, videoPollMs: 40, imagePollMs: 40 };
let app = createApp(options);
const PORT = (await app.listen(0, '127.0.0.1')).port;
const base = `http://127.0.0.1:${PORT}`;
const put = (body) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
await put({
	baseUrl: model.baseUrl, apiKey: 'k', model: 'mock-model', allowedDirs: filesDir, maxPodMinutes: '90',
	runpodApiKey: rp.state.key, runpodBaseUrl: rp.baseUrl, runpodGraphqlUrl: rp.graphqlUrl, podProxyTemplate: comfy.baseUrl, videoWorkflowUrl: `${comfy.baseUrl}/workflow.json`,
	imageLoras: JSON.stringify([{ name: 'loras/GTA_VI_3D_Style_krea2_3313988_epoch_10.safetensors', size: 1 }, { name: 'loras/a very long lora file name that goes on and on and on_v2_final_FINAL.safetensors', size: 1 }])
});

const sizes = { phone: devices['Pixel 7'], small: { viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }, desktop: { viewport: { width: 1280, height: 800 } } };
const browser = await chromium.launch();
const context = await browser.newContext(sizes[VIEWPORT]);
let page;
const problems = [];
const log = [];
const note = (kind, detail) => { const p = `${kind}: ${detail}`; if (!problems.includes(p)) problems.push(p); };
let appDown = false;

async function newPage() {
	page = await context.newPage();
	page.on('pageerror', (e) => note('script error', `${e.message.slice(0, 160)} [after: ${log.slice(-4).join(' > ')}]`));
	page.on('dialog', (d) => (chance(0.75) ? d.accept() : d.dismiss()).catch(() => {}));
	page.on('response', (r) => { if (r.status() >= 500 && r.status() !== 502 && !appDown) note('server error', `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname} [after: ${log.slice(-3).join(' > ')}]`); });
	await page.goto(base + '/').catch(() => {});
}
await newPage();

const visible = (sel) => page.locator(sel).first().isVisible().catch(() => false);
const tap = async (sel, opts = {}) => { const l = page.locator(sel); const n = await l.count().catch(() => 0); if (!n) return false; const t = l.nth(Math.floor(rnd() * n)); if (!await t.isVisible().catch(() => false)) return false; await t.click({ timeout: 1200, ...opts }).catch(() => {}); return true; };
const closeDialogs = async () => { for (const id of ['models', 'settings']) await page.evaluate((d) => document.getElementById(d)?.close?.(), id).catch(() => {}); };
const openDrawer = async () => { if (await visible('#menu')) await page.click('#menu', { timeout: 1000 }).catch(() => {}); await sleep(120); };
const goPage = async (name) => { await closeDialogs(); await openDrawer(); await page.click(`#open-${name}`, { timeout: 1500 }).catch(() => {}); };
const toChat = async () => { await closeDialogs(); if (await visible('#back')) await page.click('#back', { timeout: 1000 }).catch(() => {}); };

const actions = {
	async sendMessage() { await toChat(); if (chance(0.5)) model.state.replies.push(pick(TOOL_REPLIES), { chunks: ['Done.'] }); model.state.delayMs = pick([0, 0, 30, 150]); await page.fill('#input', pick(NASTY_TEXT), { timeout: 1500 }).catch(() => {}); await tap('#send'); if (chance(0.3)) await tap('#send'); },
	async stopReply() { await toChat(); if (await page.evaluate(() => document.body.classList.contains('working'))) await tap('#send'); },
	async approval() { await tap(chance(0.6) ? '.approval .btn-primary' : '.approval .btn-ghost'); },
	async newChat() { await closeDialogs(); await tap('#header-new'); },
	async openConversation() { await closeDialogs(); await openDrawer(); await tap('.conv-open'); },
	async deleteConversation() { await closeDialogs(); await openDrawer(); await tap('.conv-del'); },
	async pages() { await goPage(pick(['system', 'video', 'characters'])); },
	async back() { await closeDialogs(); await tap('#back'); },
	async browserBack() { await page.goBack({ timeout: 2000 }).catch(() => {}); if (!page.url().startsWith(base)) await page.goto(base + '/').catch(() => {}); },
	async reload() { await page.reload({ timeout: 5000 }).catch(() => {}); },
	async reopen() { await page.close().catch(() => {}); await newPage(); },
	async modelSheet() { await toChat(); await tap('#model-chip'); await sleep(150); for (let i = 0; i < 3; i++) await tap(pick(['#models .opt', '#models .switch', '#models .wake .btn-primary', '#models .btn-ghost', '#models-close'])); },
	async settings() { await closeDialogs(); await openDrawer(); await tap('#open-settings'); await sleep(100); if (await visible('#settings[open]')) { if (chance(0.4)) await page.fill('[name=temperature]', pick(['0.7', '', '99', '-1', 'abc']), { timeout: 800 }).catch(() => {}); if (chance(0.3)) await page.fill('[name=systemPrompt]', pick(NASTY_TEXT), { timeout: 800 }).catch(() => {}); await tap(pick(['#cancel-settings', '#settings .btn-primary', '#test-endpoint'])); await sleep(100); if (await visible('#settings[open]')) await tap('#cancel-settings'); } },
	async attach() { await toChat(); await page.setInputFiles('#file-input', pick([[png], [join(filesDir, 'note.txt')], [join(filesDir, 'weird name (1) #&?.txt'), png], [join(filesDir, 'empty.txt')]]), { timeout: 1500 }).catch(() => {}); await sleep(150); if (chance(0.3)) await tap('.pend-x'); },
	async system() { await goPage('system'); await sleep(150); await page.fill('#sys-minutes', pick(['5', '0', '', '9999', '-3', '1.5', 'abc']), { timeout: 800 }).catch(() => {}); await tap(pick(['#sys-quote', '#sys-brain-quote'])); await sleep(200); await tap(pick(['#sys-quote-out .btn-primary', '#sys-brain-out .btn-primary', '#sys-active .btn-danger', '#sys-unknown .btn-danger', '#sys-form .btn-primary'])); },
	async characters() {
		await goPage('characters'); await sleep(150);
		const what = pick(['session', 'session', 'generate', 'generate', 'refs', 'loras', 'gallery', 'end']);
		if (what === 'session') { await page.fill('#img-minutes', pick(['30', '5', '0', '', '500']), { timeout: 800 }).catch(() => {}); await tap('#img-session .btn-ghost'); await sleep(250); await tap('#img-session .btn-primary'); if (chance(0.3)) await tap('#img-session .btn-primary'); }
		if (what === 'generate') { await page.fill('#img-prompt', pick(NASTY_TEXT), { timeout: 1000 }).catch(() => {}); await page.fill('#img-count', pick(['2', '0', '9', '', '-1']), { timeout: 800 }).catch(() => {}); if (chance(0.5)) await page.locator('#img-enhance').setChecked(chance(0.5), { timeout: 800 }).catch(() => {}); await tap('#img-go'); if (chance(0.3)) await tap('#img-go'); }
		if (what === 'refs') { const role = pick(['face', 'body', 'look']); if (chance(0.6)) await page.setInputFiles(`#img-ref-${role}`, pick([png, join(filesDir, 'note.txt')]), { timeout: 1500 }).catch(() => {}); else await tap(`.pick.ref[data-role=${role}]`); }
		if (what === 'loras') { await tap('.lora-row input[type=checkbox]'); await page.locator('.lora-row input[type=number]').first().fill(pick(['0.9', '', '5', '-2', 'x']), { timeout: 800 }).catch(() => {}); }
		if (what === 'gallery') await tap(pick(['.shot-actions button', '.gen .link']));
		if (what === 'end') await tap('#img-session .btn-danger');
	},
	async video() {
		await goPage('video'); await sleep(150);
		if (chance(0.5)) await page.setInputFiles('#vid-video-input', pick([join(filesDir, 'fake.mp4'), png]), { timeout: 1500 }).catch(() => {});
		if (chance(0.5)) await page.setInputFiles('#vid-image-input', pick([png, join(filesDir, 'note.txt')]), { timeout: 1500 }).catch(() => {});
		if (chance(0.6)) await page.locator('#vid-rights').setChecked(chance(0.7), { timeout: 800 }).catch(() => {});
		await tap(pick(['#vid-quote', '#vid-quote-out .btn-primary', '#vid-active .btn-danger', '#vid-result .btn-ghost']));
	},
	async resize() { const v = pick([{ width: 412, height: 839 }, { width: 320, height: 480 }, { width: 915, height: 412 }, { width: 360, height: 300 }]); await page.setViewportSize(v).catch(() => {}); },
	async chaos() {
		const what = pick(['runpod-down', 'runpod-ok', 'no-capacity', 'capacity', 'comfy-fail', 'comfy-ok', 'comfy-not-ready', 'model-key', 'model-ok', 'balance-low', 'balance-ok', 'restart']);
		log.push(`chaos:${what}`);
		if (what === 'runpod-down') await put({ runpodApiKey: 'wrong-key' });
		if (what === 'runpod-ok') await put({ runpodApiKey: rp.state.key });
		if (what === 'no-capacity') for (const g of rp.state.gpus) rp.state.noCapacity.add(g.id);
		if (what === 'capacity') rp.state.noCapacity.clear();
		if (what === 'comfy-fail') comfy.state.outcome = pick(['error', 'reject', 'empty']);
		if (what === 'comfy-ok') Object.assign(comfy.state, { outcome: 'ok', ready: true });
		if (what === 'comfy-not-ready') comfy.state.ready = false;
		if (what === 'model-key') model.state.requireKey = 'other';
		if (what === 'model-ok') model.state.requireKey = null;
		if (what === 'balance-low') rp.state.balance = 0.01;
		if (what === 'balance-ok') rp.state.balance = 61;
		if (what === 'restart') { appDown = true; await app.close().catch((e) => note('app close failed', e.message)); app = createApp(options); await app.listen(PORT, '127.0.0.1'); appDown = false; }
	}
};
const WEIGHTS = { sendMessage: 9, stopReply: 3, approval: 5, newChat: 3, openConversation: 4, deleteConversation: 1, pages: 5, back: 4, browserBack: 2, reload: 2, reopen: 1, modelSheet: 4, settings: 2, attach: 3, system: 4, characters: 9, video: 5, resize: 1, chaos: 4 };
const bag = Object.entries(WEIGHTS).flatMap(([name, w]) => Array(w).fill(name));

/** Rules that must hold after every action, whatever was tapped. */
async function checkInvariants(step, name) {
	const r = await page.evaluate(() => {
		const shown = (el) => el && !el.hidden && getComputedStyle(el).display !== 'none';
		const text = document.body.innerText;
		const pages = ['system', 'video', 'characters'].filter((id) => shown(document.getElementById(id)));
		const junk = text.match(/\bundefined\b|\bNaN\b|\[object Object\]|\$-\d|Infinity/);
		return {
			overflow: document.documentElement.scrollWidth - window.innerWidth,
			banner: shown(document.getElementById('js-error')) ? document.getElementById('js-error').textContent.slice(0, 160) : '',
			pages, composer: shown(document.getElementById('composer')), title: document.getElementById('title').textContent.trim(),
			junk: junk ? `${junk[0]} in "${text.slice(Math.max(0, junk.index - 60), junk.index + 40).replace(/\s+/g, ' ')}"` : '',
			dialogs: document.querySelectorAll('dialog[open]').length,
			injected: document.querySelectorAll('.msg script, .msg img[onerror], .msg a[href^="javascript:"]').length,
			backShown: shown(document.getElementById('back')),
			// The app must fill the window: a gap at the bottom means the layout height is stale.
			gap: Math.round(window.innerHeight - document.querySelector('main').getBoundingClientRect().bottom),
			deadButtons: [...document.querySelectorAll('button:disabled')].filter((b) => b.offsetParent && getComputedStyle(b).opacity === '1' && b.id !== 'send').map((b) => b.id || b.textContent.trim().slice(0, 20))
		};
	}).catch(() => null);
	if (!r) return;
	const where = `[step ${step} ${name}; before: ${log.slice(-4, -1).join(' > ')}]`;
	if (r.overflow > 1) note('sideways overflow', `${r.overflow}px on ${r.pages[0] || 'chat'} ${where}`);
	if (r.banner) note('error banner shown', `${r.banner} ${where}`);
	if (r.pages.length > 1) note('two pages visible', `${r.pages} ${where}`);
	if (r.pages.length === 1 && r.composer) note('chat box visible on a page', `${r.pages} ${where}`);
	if (r.pages.length === 0 && !r.composer) note('nothing visible', where);
	if (r.pages.length === 1 && !r.backShown) note('page without a back arrow', `${r.pages} ${where}`);
	if (!r.title) note('empty title', where);
	if (r.junk) note('raw value on screen', `${r.junk} ${where}`);
	if (r.dialogs > 1) note('two dialogs open', where);
	if (Math.abs(r.gap) > 2) note('app does not fill the window', `${r.gap}px gap ${where}`);
	if (r.deadButtons.length) note('disabled button looks enabled', `${r.deadButtons.join(', ')} ${where}`);
	if (r.injected) note('unsafe content rendered from a message', where);
}

for (let step = 1; step <= ACTIONS; step++) {
	const name = pick(bag);
	log.push(name);
	try { await actions[name](); } catch (e) { note('tester action crashed', `${name}: ${e.message.slice(0, 120)}`); }
	await sleep(pick([0, 0, 20, 80]));
	await checkInvariants(step, name);
	// The money rule: never more than one rented machine at a time.
	const live = [...rp.state.pods.values()].filter((p) => p.status !== 'TERMINATED').length;
	if (live > 1) note('more than one pod running', `${live} at step ${step} ${name}`);
}

// Wind down: everything healthy again, let work finish, then check nothing is stuck or left running.
await closeDialogs();
rp.state.noCapacity.clear(); rp.state.balance = 61; Object.assign(comfy.state, { outcome: 'ok', ready: true }); model.state.requireKey = null; model.state.delayMs = 0;
await put({ runpodApiKey: rp.state.key });
await sleep(1500);
const stuck = await (await fetch(`${base}/api/conversations`)).json();
for (const c of stuck.conversations.slice(0, 40)) {
	const conv = await (await fetch(`${base}/api/conversations/${c.id}`)).json();
	if (conv.working && !conv.messages.some((m) => m.role === 'assistant' && m.tool_calls)) { await sleep(1500); if ((await (await fetch(`${base}/api/conversations/${c.id}`)).json()).working) note('reply stuck forever', `conversation "${c.title.slice(0, 30)}"`); }
}
const sys = await (await fetch(`${base}/api/system`)).json();
for (const p of sys.active) await fetch(`${base}/api/system/pods/${p.id}`, { method: 'DELETE' });
await sleep(400);
const leaked = [...rp.state.pods.values()].filter((p) => p.status !== 'TERMINATED');
if (leaked.length) note('pod left running after everything was stopped', leaked.map((p) => `${p.id} ${p.name}`).join(', '));
const video = await (await fetch(`${base}/api/video`)).json();
if (video.jobs.some((j) => j.active)) note('video job still active with no pod', video.jobs.filter((j) => j.active).map((j) => j.status).join(','));
const images = await (await fetch(`${base}/api/images`)).json();
if (images.generations.some((g) => g.status === 'running')) note('picture still "being made" with no session', '');

await browser.close();
await app.close().catch((e) => note('app close failed', e.message));
await rp.close(); await comfy.close(); await model.close();
rmSync(root, { recursive: true, force: true });

// How much of the app the run actually exercised: a quiet run that did nothing proves nothing.
console.log(`coverage: ${stuck.conversations.length} chats, ${model.state.requests.length} model calls, ${rp.state.created.length} pods rented, ${comfy.state.prompts.length} image/video jobs sent, ${comfy.state.uploads.length} files sent to the engine, ${video.jobs.length} video jobs, ${images.generations.length} picture requests, ${log.filter((l) => l.startsWith('chaos:')).length} failures injected`);
console.log(`seed ${SEED}, ${ACTIONS} actions, ${VIEWPORT}: ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
for (const p of problems) console.log(` - ${p}`);
process.exit(problems.length ? 1 : 0);
