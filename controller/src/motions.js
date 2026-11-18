// The animation library: motion/1 records (public/motion.js) saved as JSON files, plus BVH and
// FBX made from them. FBX goes through Blender without a screen (tools/blender/motion_to_fbx.py);
// on the phone that is Ubuntu's own Blender package, so it costs nothing and nothing leaves it.
import { mkdir, readdir, readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../tools/blender/motion_to_fbx.py', import.meta.url));
export const MAX_MOTION_BYTES = 8 * 1024 * 1024;

export function createMotionStore({ dataDir, getSettings, blenderTimeoutMs = 180000 }) {
	const dir = join(dataDir, 'motions');
	const file = (id) => join(dir, `${id}.json`);
	const valid = (id) => /^[\w-]{8,64}$/.test(id);

	let body = null;
	/** The figure motions are exported on: the editor's standard body (its proportions set the BVH offsets). */
	async function figure() {
		if (!body) body = (async () => {
			const b = await import('../public/body.js');
			await b.loadHuman(undefined, (url) => readFile(url));
			const poser = b.createPoser(b.defaults('female'));
			const upc = poser.toUnits([1, 0, 0], 0)[0] - poser.toUnits([0, 0, 0], 0)[0];
			return { rest: poser.rest, upc };
		})();
		return body;
	}

	async function list() {
		await mkdir(dir, { recursive: true });
		const out = [];
		for (const name of await readdir(dir)) {
			if (!name.endsWith('.json')) continue;
			try {
				const m = JSON.parse(await readFile(join(dir, name), 'utf8'));
				out.push({ id: m.id, name: m.name, created: m.created, duration: m.duration, fps: m.fps, frameCount: m.frameCount, person: m.person, people: m.source?.people, sourceKey: m.source?.key, file: m.source?.file, quality: m.quality });
			} catch { /* a damaged file is skipped */ }
		}
		return out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
	}

	async function get(id) {
		if (!valid(id)) return null;
		try { return JSON.parse(await readFile(file(id), 'utf8')); } catch { return null; }
	}

	/** Save one motion; checks it is a motion/1 record with sane frames. */
	async function save(m) {
		if (m?.format !== 'motion/1' || !Array.isArray(m.frames) || !m.frames.length) throw Object.assign(new Error('Expected a motion/1 record with frames.'), { status: 400 });
		if (!(m.fps > 0 && m.fps <= 60)) throw Object.assign(new Error('fps must be between 1 and 60.'), { status: 400 });
		if (m.frames.some((f) => !f || typeof f.pose !== 'object' || !Number.isFinite(f.t))) throw Object.assign(new Error('Every frame needs t and pose.'), { status: 400 });
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const id = randomUUID();
		await writeFile(file(id), JSON.stringify({ ...m, id }), { mode: 0o600 });
		return id;
	}

	async function remove(id) { if (valid(id)) await rm(file(id), { force: true }); }

	async function bvh(id) {
		const m = await get(id);
		if (!m) return null;
		const { toBVH } = await import('../public/motion.js');
		const { rest, upc } = await figure();
		return { name: m.name, text: toBVH(rest, upc, m) };
	}

	/** FBX through Blender. Resolves { name, data } or throws with a message the owner can act on. */
	async function fbx(id, { mixamo = false } = {}) {
		const b = await bvh(id);
		if (!b) return null;
		const m = await get(id);
		const work = await mkdtemp(join(tmpdir(), 'motion-'));
		try {
			await writeFile(join(work, 'in.bvh'), b.text);
			const blender = getSettings().blenderPath || 'blender';
			const args = ['-b', '--factory-startup', '-P', SCRIPT, '--', join(work, 'in.bvh'), join(work, 'out.fbx'), '--fps', String(Math.round(m.fps)), ...(mixamo ? ['--mixamo'] : [])];
			const log = await new Promise((resolve, reject) => {
				let out = '';
				const p = spawn(blender, args, { stdio: ['ignore', 'pipe', 'pipe'] });
				const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Blender took too long (over 3 minutes).')); }, blenderTimeoutMs);
				p.stdout.on('data', (d) => { out += d; });
				p.stderr.on('data', (d) => { out += d; });
				p.on('error', (err) => { clearTimeout(timer); reject(err.code === 'ENOENT' ? Object.assign(new Error('Blender is not installed on this phone yet, so FBX cannot be made. BVH works now; Blender can be added for free with: apt install blender'), { status: 501 }) : err); });
				p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`Blender stopped with an error: ${out.split('\n').filter((l) => /error|Error|Traceback/.test(l)).slice(-2).join(' ').slice(0, 300)}`)); });
			});
			if (!/^FBX /m.test(log)) throw new Error('Blender did not write the FBX.');
			return { name: m.name, data: await readFile(join(work, 'out.fbx')) };
		} finally { await rm(work, { recursive: true, force: true }); }
	}

	return { list, get, save, remove, bvh, fbx, figure };
}
