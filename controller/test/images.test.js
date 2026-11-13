import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { buildImageGraph, imagePodSpec } from '../src/image-recipe.js';
import { startMockRunpod } from './mock-runpod.js';
import { startMockComfy } from './mock-comfy.js';
import { startMockModel } from './mock-model.js';

let app, base, rp, comfy, b2, b2Url, root, now, n = 0;
const MIN = 60000;
const api = async (method, path, body) => {
	const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, body: await res.json() };
};
const upload = async (name, type) => (await (await fetch(`${base}/api/uploads?name=${name}`, { method: 'POST', headers: { 'Content-Type': type }, body: 'DATA' })).json()).id;
async function startSession(minutes = 30) {
	const q = (await api('POST', '/api/images/quote', { minutes })).body;
	return api('POST', '/api/images/session', { minutes, confirmEstimate: q.estimate });
}
async function generate(body) {
	const r = await api('POST', '/api/images/generate', body);
	if (r.status !== 200) return r.body;
	for (let i = 0; i < 300; i++) {
		const g = (await api('GET', '/api/images')).body.generations.find((x) => x.id === r.body.id);
		if (g.status !== 'running') return g;
		await new Promise((res) => setTimeout(res, 10));
	}
	throw new Error('generation did not finish');
}

// A minimal Backblaze: authorize, list file names, download authorization.
const b2State = { files: [{ fileName: 'loras/GTA_VI_3D_Style_krea2_3313988_epoch_10.safetensors', contentLength: 228588976, action: 'upload' }, { fileName: 'loras/readme.txt', contentLength: 10, action: 'upload' }], calls: [] };
before(async () => {
	rp = await startMockRunpod();
	comfy = await startMockComfy();
	b2 = createServer(async (req, res) => {
		let raw = ''; for await (const c of req) raw += c;
		b2State.calls.push(req.url);
		const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
		if (req.url.endsWith('b2_authorize_account')) {
			if (req.headers.authorization !== `Basic ${Buffer.from('kid:secret-app-key').toString('base64')}`) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ code: 'unauthorized', message: 'bad key' })); }
			return send({ accountId: 'acc', authorizationToken: 'tok', apiInfo: { storageApi: { apiUrl: b2Url, downloadUrl: 'https://f000.example-b2.test', bucketId: null, bucketName: null } } });
		}
		if (req.url.endsWith('b2_list_buckets')) return send({ buckets: [{ bucketId: 'bkt1', bucketName: 'mybucket' }] });
		if (req.url.endsWith('b2_list_file_names')) return send({ files: b2State.files });
		if (req.url.endsWith('b2_get_download_authorization')) return send({ authorizationToken: `dl-${JSON.parse(raw).validDurationInSeconds}` });
		res.writeHead(404).end();
	});
	await new Promise((r) => b2.listen(0, '127.0.0.1', r));
	b2Url = `http://127.0.0.1:${b2.address().port}`;
	root = mkdtempSync(join(tmpdir(), 'controller-img-'));
});
after(async () => { await app?.close(); await rp.close(); await comfy.close(); b2.close(); rmSync(root, { recursive: true, force: true }); });
beforeEach(async () => {
	await app?.close();
	now = Date.UTC(2026, 10, 12, 12, 0, 0);
	Object.assign(rp.state, { noCapacity: new Set(), pods: new Map(), created: [], deleted: [], seq: 0, balance: 61.38 });
	Object.assign(comfy.state, { ready: true, pollsUntilDone: 1, outcome: 'ok', images: 2, uploads: [], prompts: [], historyChecks: 0, setupLog: 'STEP 2/3 Downloading models\n' });
	app = createApp({ dataDir: join(root, `d${++n}`), clock: () => now, watchdogMs: 0, imagePollMs: 5 });
	base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
	await api('PUT', '/api/settings', { maxPodMinutes: '90', runpodApiKey: rp.state.key, runpodBaseUrl: rp.baseUrl, runpodGraphqlUrl: rp.graphqlUrl, podCloud: 'COMMUNITY', podProxyTemplate: comfy.baseUrl, b2KeyId: 'kid', b2AppKey: 'secret-app-key', b2Bucket: 'mybucket', b2ApiBase: b2Url });
});

test('a session rents one pod set up with Krea 2, the same-face add-on and the LoRAs from Backblaze', async () => {
	assert.equal((await api('GET', '/api/images')).body.session.state, 'off');
	const r = await startSession(30);
	assert.equal(r.status, 200);
	const sent = rp.state.created[0];
	assert.equal(sent.image, 'ghcr.io/seangumede96-lang/assistant-image-engine:latest', 'the ready-made engine built on GitHub');
	const cmd = JSON.parse(sent.args).cmd[0];
	assert.match(cmd, /krea2_turbo_fp8_scaled[\s\S]*krea2_turbo_int8_convrot[\s\S]*qwen3vl_4b_bf16[\s\S]*qwen_image_vae[\s\S]*krea2_reid_rank32/);
	assert.match(cmd, /ComfyUI-Krea2-Ostris-Edit checkout -q 7756566/);
	assert.ok(cmd.includes(`get 'https://f000.example-b2.test/file/mybucket/loras/GTA_VI_3D_Style_krea2_3313988_epoch_10.safetensors?Authorization=dl-3600' "/root/ComfyUI/models/loras/GTA_VI_3D_Style_krea2_3313988_epoch_10.safetensors" &`));
	assert.ok(!cmd.includes('secret-app-key') && !cmd.includes('readme.txt'), 'no key and no non-LoRA files reach the pod');
	assert.deepEqual(sent.env, {});

	const s = (await api('GET', '/api/images')).body;
	assert.equal(s.session.state, 'ready');
	assert.deepEqual(s.loras.map((l) => l.name), ['loras/GTA_VI_3D_Style_krea2_3313988_epoch_10.safetensors']);
	assert.ok(!JSON.stringify((await api('GET', '/api/settings')).body).includes('secret-app-key'));
});

test('pictures are generated with the hand-tested settings and saved on the phone', async () => {
	await startSession();
	await api('GET', '/api/images');
	const g = await generate({ prompt: 'gta6game_ a tall woman, full body, white void', size: 'portrait', count: 2, loras: [{ name: 'loras/GTA_VI_3D_Style_krea2_3313988_epoch_10.safetensors', strength: 0.9 }] });
	assert.equal(g.status, 'done');
	assert.equal(g.images.length, 2);
	const graph = comfy.state.prompts[0].prompt;
	assert.equal(graph['1'].inputs.unet_name, 'krea2_turbo_fp8_scaled.safetensors');
	assert.deepEqual(graph['4'].inputs, { model: ['1', 0], lora_name: 'GTA_VI_3D_Style_krea2_3313988_epoch_10.safetensors', strength_model: 0.9 });
	assert.deepEqual([graph['7'].inputs.width, graph['7'].inputs.height, graph['7'].inputs.batch_size], [1024, 1536, 2]);
	assert.deepEqual([graph['8'].inputs.steps, graph['8'].inputs.cfg, graph['8'].inputs.sampler_name, graph['8'].inputs.scheduler, graph['8'].inputs.model], [8, 1, 'euler', 'simple', ['4', 0]]);
	const res = await fetch(`${base}/api/uploads/${g.images[0]}`);
	assert.equal(res.headers.get('content-type'), 'image/png');
	assert.match(await res.text(), /^PNG:gen_00001_/);
});

test('a face reference alone is wired exactly as the hand-run script did', async () => {
	await startSession();
	await api('GET', '/api/images');
	const face = await upload('face.png', 'image/png');
	const g = await generate({ prompt: 'the same woman in a red coat', refs: { face }, loras: [{ name: 'loras/GTA_VI_3D_Style_krea2_3313988_epoch_10.safetensors', strength: 0.9 }] });
	assert.equal(g.status, 'done');
	assert.match(comfy.state.uploads[0].name, /^face-.*face\.png$/);
	const graph = comfy.state.prompts[0].prompt;
	assert.equal(graph['1'].inputs.unet_name, 'krea2_turbo_int8_convrot.safetensors');
	assert.deepEqual(graph['21'].inputs, { image: ['20', 0], upscale_method: 'area', megapixels: 0.140625, resolution_steps: 16 });
	assert.deepEqual(graph['30'].inputs, { model: ['1', 0], lora_name: 'krea2_reid_rank32.safetensors', strength_model: 1 });
	assert.deepEqual(graph['4'].inputs.model, ['30', 0]);
	assert.deepEqual(graph['31'], { class_type: 'Krea2OstrisEditModelPatch', inputs: { model: ['4', 0], kv_cache: true } });
	assert.equal(graph['5'].class_type, 'TextEncodeKrea2OstrisEdit');
	assert.deepEqual(graph['5'].inputs.image1, ['21', 0]);
	assert.equal(graph['5'].inputs.prompt, 'the same woman in a red coat Keep the face of the person in image 1.');
	assert.deepEqual(graph['45'].inputs, { conditioning: ['5', 0], reference_latents_method: 'index_timestep_zero' });
	assert.deepEqual([graph['8'].inputs.model, graph['8'].inputs.positive, graph['8'].inputs.negative], [['31', 0], ['45', 0], ['46', 0]]);
});

test('face, body and look references can be combined, with several LoRAs stacked', () => {
	const g = buildImageGraph({
		prompt: 'A woman on a beach.', width: 1024, height: 1536, count: 1, seed: 1, prefix: 'p',
		loras: [{ name: 'loras/style.safetensors', strength: 0.9 }, { name: 'loras/detail.safetensors', strength: 0.6 }],
		refs: [{ role: 'face', file: 'f.png' }, { role: 'body', file: 'b.png' }, { role: 'look', file: 'l.png' }]
	});
	assert.deepEqual([g['21'].inputs.megapixels, g['23'].inputs.megapixels, g['25'].inputs.megapixels], [0.140625, 0.5, 0.5]);
	assert.deepEqual([g['5'].inputs.image1, g['5'].inputs.image2, g['5'].inputs.image3], [['21', 0], ['23', 0], ['25', 0]]);
	assert.equal(g['5'].inputs.prompt, 'A woman on a beach. Keep the face of the person in image 1. Use the body shape and proportions of the person in image 2. Use the outfit, makeup and styling shown in image 3.');
	const sheets = buildImageGraph({ prompt: 'A woman.', width: 1024, height: 1024, count: 1, seed: 1, prefix: 'p', refs: [{ role: 'face', file: 'a.png', count: 3 }, { role: 'body', file: 'b.png', count: 2 }, { role: 'look', file: 'c.png' }] });
	assert.equal(sheets['5'].inputs.prompt, "A woman. Image 1 shows 3 pictures of the same person's face; keep that face. Image 2 shows 2 pictures of the same body; use that body shape and proportions. Use the outfit, makeup and styling shown in image 3.");
	assert.deepEqual([sheets['21'].inputs.megapixels, sheets['23'].inputs.megapixels, sheets['25'].inputs.megapixels], [0.421875, 1, 0.5], 'each picture in a sheet keeps the size of a single one');
	assert.deepEqual([g['4'].inputs.model, g['4a'].inputs.model, g['31'].inputs.model], [['30', 0], ['4', 0], ['4a', 0]]);
	assert.equal(g['4a'].inputs.strength_model, 0.6);

	// A body reference on its own becomes image 1; no LoRA means the patch sits on the reference LoRA.
	const solo = buildImageGraph({ prompt: 'x', width: 1024, height: 1024, count: 1, seed: 1, prefix: 'p', refs: [{ role: 'body', file: 'b.png' }] });
	assert.equal(solo['21'].inputs.megapixels, 0.5);
	assert.match(solo['5'].inputs.prompt, /body shape and proportions of the person in image 1/);
	assert.deepEqual(solo['31'].inputs.model, ['30', 0]);
	// Two LoRAs without references: plain text-to-image through both.
	const plain = buildImageGraph({ prompt: 'x', width: 1024, height: 1024, count: 1, seed: 1, prefix: 'p', loras: [{ name: 'a.safetensors', strength: 1 }, { name: 'b.safetensors', strength: 0.5 }] });
	assert.deepEqual([plain['1'].inputs.unet_name, plain['8'].inputs.model, plain['5'].class_type], ['krea2_turbo_fp8_scaled.safetensors', ['4a', 0], 'CLIPTextEncode']);
});

test('requests are checked, and nothing is generated without a ready session', async () => {
	assert.match((await generate({ prompt: 'x' })).error, /Start a session first/);
	comfy.state.ready = false;
	await startSession();
	assert.equal((await api('GET', '/api/images')).body.session.detail, '2/3 Downloading models');
	assert.match((await generate({ prompt: 'x' })).error, /still starting/);
	comfy.state.ready = true;
	await api('GET', '/api/images');
	assert.match((await generate({ prompt: '  ' })).error, /Describe the picture/);
	assert.match((await generate({ prompt: 'x', loras: [{ name: 'loras/other.safetensors', strength: 1 }] })).error, /not loaded/);
	assert.match((await generate({ prompt: 'x', refs: { body: 'missing' } })).error, /body pictures is missing/);
	const pic = await upload('p.png', 'image/png');
	assert.match((await generate({ prompt: 'x', refs: { face: [pic, pic], body: [pic, pic] } })).error, /At most 3 reference pictures/);
	assert.equal(comfy.state.prompts.length, 0);
});

test('an idle session is shut down; generating keeps it alive; setup failure ends it with the reason', async () => {
	await startSession(60);
	await api('GET', '/api/images');
	now += 8 * MIN;
	await generate({ prompt: 'x' });
	now += 8 * MIN;
	await app.gpu.tick();
	assert.deepEqual(rp.state.deleted, []);
	now += 3 * MIN;
	await app.gpu.tick();
	assert.deepEqual(rp.state.deleted, ['pod1']);

	Object.assign(comfy.state, { ready: false, setupLog: 'STEP 2/3 Downloading models\ncurl: (22) The requested URL returned error: 403\nSETUP FAILED\n' });
	await startSession(30);
	const s = (await api('GET', '/api/images')).body;
	assert.equal(s.session.state, 'off');
	assert.match(s.session.lastEnd, /setup failed: .*error: 403/);
	assert.deepEqual(rp.state.deleted, ['pod1', 'pod2']);
});

test('a failed generation says why; pictures can be deleted; a wrong Backblaze key is reported', async () => {
	await startSession();
	await api('GET', '/api/images');
	comfy.state.outcome = 'error';
	const bad = await generate({ prompt: 'x' });
	assert.equal(bad.status, 'failed');
	assert.match(bad.detail, /CUDA out of memory/);
	comfy.state.outcome = 'ok'; comfy.state.historyChecks = 0;
	const good = await generate({ prompt: 'y' });
	assert.equal((await api('DELETE', `/api/images/${good.id}`)).status, 200);
	assert.equal((await fetch(`${base}/api/uploads/${good.images[0]}`)).status, 404);

	await api('DELETE', '/api/images/session');
	await api('PUT', '/api/settings', { b2AppKey: 'wrong' });
	const r = await startSession();
	assert.equal(r.status, 502);
	assert.match(r.body.error, /Backblaze: bad key/);
	assert.equal(rp.state.created.length, 1, 'no pod is rented when the LoRAs cannot be fetched');
});

test('a casual request is written up into a detailed prompt; a refusal falls back to the user\'s words', async () => {
	const writer = await startMockModel({ chunks: ['Full-body picture of a tall athletic woman with short silver hair, fully dressed in a black leather jacket and jeans, standing against a plain pure white void.'] });
	try {
		await api('PUT', '/api/settings', { baseUrl: writer.baseUrl, model: 'mock-model' });
		await startSession();
		await api('GET', '/api/images');
		const g = await generate({ prompt: 'cool silver haired girl', enhance: true, prefix: 'gta6game_' });
		assert.equal(g.status, 'done');
		assert.match(g.prompt, /^Full-body picture of a tall athletic woman/);
		assert.equal(g.params.asked, 'cool silver haired girl');
		assert.match(comfy.state.prompts[0].prompt['5'].inputs.text, /^gta6game_ Full-body picture/, 'the trigger word is added after writing, never reworded');
		const asked = writer.state.requests[0].messages;
		assert.match(asked[0].content, /framing[\s\S]*clothing explicitly[\s\S]*white void/);
		assert.equal(asked[1].content, 'cool silver haired girl');

		writer.state.chunks = ["I'm sorry, but I can't help with that."];
		comfy.state.historyChecks = 0;
		const refused = await generate({ prompt: 'something the writer refuses', enhance: true });
		assert.equal(refused.prompt, 'something the writer refuses');
		assert.match(refused.params.note, /declined/);
		assert.equal(comfy.state.prompts[1].prompt['5'].inputs.text, 'something the writer refuses');
	} finally { await writer.close(); }
});

test('a session reserves setup time on top of the minutes asked for, and a stalled setup is explained afterwards', async () => {
	const q = (await api('POST', '/api/images/quote', { minutes: 30 })).body;
	assert.equal(q.minutes, 45);
	assert.equal(q.useMinutes, 30);
	comfy.state.ready = false;
	comfy.state.setupLog = 'STEP 1/3 Installing the image engine\n[notice] A new release of pip is available\nSTEP 2/3 Downloading models (2 of 6 files, 9 GB)\n';
	await api('POST', '/api/images/session', { minutes: 30, confirmEstimate: q.estimate });
	await api('GET', '/api/images');
	now += 46 * MIN;
	await app.gpu.tick();
	const s = (await api('GET', '/api/images')).body;
	assert.equal(s.session.state, 'off');
	assert.match(s.session.lastEnd, /never finished setting up \(.*\); it was at step 2\/3 Downloading models \(2 of 6 files, 9 GB\)/);
	assert.deepEqual(s.session.setupLog, ['STEP 1/3 Installing the image engine', 'STEP 2/3 Downloading models (2 of 6 files, 9 GB)']);
});

test('a body shape from the editor becomes the starting picture, partly repainted', async () => {
	const g = buildImageGraph({ prompt: 'x', width: 1024, height: 1536, count: 2, seed: 1, prefix: 'p', shape: 'shape-1.png', shapeDenoise: 0.7 });
	assert.deepEqual(g['41'].inputs, { image: ['40', 0], upscale_method: 'lanczos', width: 1024, height: 1536, crop: 'center' });
	assert.deepEqual(g['43'].inputs, { samples: ['42', 0], amount: 2 });
	assert.deepEqual([g['8'].inputs.latent_image, g['8'].inputs.denoise], [['43', 0], 0.7]);
	assert.equal(g['7'], undefined, 'no empty starting picture when a shape is used');

	await startSession();
	await api('GET', '/api/images');
	const shape = await upload('body-shape.png', 'image/png');
	const done = await generate({ prompt: 'a woman', shape, shapeDenoise: 0.66 });
	assert.equal(done.status, 'done');
	assert.match(comfy.state.uploads.at(-1).name, /^shape-/);
	assert.equal(comfy.state.prompts.at(-1).prompt['8'].inputs.denoise, 0.66);
	assert.match((await generate({ prompt: 'x', shape: 'missing' })).error, /body shape picture is missing/);
});

test('depth control from the body editor is wired in before the same-face patch', async () => {
	const { DEPTH_LORA } = await import('../src/image-recipe.js');
	const g = buildImageGraph({ prompt: 'x', width: 1024, height: 1536, count: 2, seed: 1, prefix: 'p', depth: 'depth-1.png', depthStrength: 0.85,
		loras: [{ name: 'loras/style.safetensors', strength: 0.9 }], refs: [{ role: 'face', file: 'f.png' }] });
	assert.deepEqual(g['51'].inputs, { control_image: ['50', 0], vae: ['3', 0], resize: 'match_latent_size', upscale_method: 'lanczos', crop: 'center', channel_mode: 'grayscale', normalize: 'per_image_minmax', invert: false, batch_mode: 'independent_images', latent: ['7', 0] });
	assert.deepEqual(g['52'].inputs, { model: ['4', 0], lora_name: DEPTH_LORA, strength: 0.85 });
	assert.deepEqual(g['31'].inputs.model, ['53', 0], 'same-face patch sits on top of the depth control');
	assert.equal(g['8'].inputs.denoise, 1, 'depth control starts from noise, not from the mannequin picture');

	await startSession();
	await api('GET', '/api/images');
	const depth = await upload('body-depth.png', 'image/png');
	const done = await generate({ prompt: 'a woman', depth, depthStrength: 0.8 });
	assert.equal(done.status, 'done');
	assert.match(comfy.state.uploads.at(-1).name, /^depth-/);
	assert.equal(comfy.state.prompts.at(-1).prompt['52'].inputs.strength, 0.8);
	assert.match(imagePodSpec([]).cmd, /comfyui-krea2-controlnet checkout -q 79ebfd3[\s\S]*krea2_depth_control\.safetensors/);
});

test('without Backblaze the session still starts, with no LoRAs', async () => {
	await api('PUT', '/api/settings', { clearB2AppKey: true });
	assert.equal((await startSession()).status, 200);
	assert.ok(!JSON.parse(rp.state.created[0].args).cmd[0].includes('example-b2'));
	assert.deepEqual((await api('GET', '/api/images')).body.loras, []);
	assert.match(imagePodSpec([]).cmd, /STEP 1\/3[\s\S]*STEP 2\/3[\s\S]*STEP 3\/3/);
	assert.equal(imagePodSpec([]).image, 'runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2404');
	assert.equal(imagePodSpec([], 'ghcr.io/x/assistant-image-engine:latest').image, 'ghcr.io/x/assistant-image-engine:latest');
	assert.match(imagePodSpec([]).cmd, /if \[ -f \/root\/ComfyUI\/\.ready-made-engine \]; then .*; else\ncd \/root && git clone[\s\S]*\nfi\n/);
});
