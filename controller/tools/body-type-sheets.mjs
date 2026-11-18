// Renders every reference body type (public/body-types.js) from the front, side and back with the
// app's own renderer (A-pose, like a character creator's base mesh), one sheet per type, plus an
// overview of all fronts. Free: no GPU. Needs ffmpeg. Run: node tools/body-type-sheets.mjs <out>
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const { renderBody } = await import('../src/body-depth.js');
const body = await import('../public/body.js');
const { BODY_TYPES } = await import('../public/body-types.js');
const out = process.argv[2];
const only = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
await mkdir(join(out, 'views'), { recursive: true });
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const ff = (...a) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...a]);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const fronts = [];
for (const [group, types] of Object.entries(BODY_TYPES)) {
	for (const [name, t] of Object.entries(types)) {
		if (only && !only.test(name)) continue;
		const v = { ...body.defaults('female'), ...t.v, armPose: 0.55, stance: 0.25 };
		const id = `${slug(group)}--${slug(name)}`;
		const files = [];
		for (const [view, angle] of [['front', 0], ['side', 90], ['back', 180]]) {
			const r = await renderBody(v, { angleDeg: angle, width: 400, height: 720 });
			const f = join(out, 'views', `${id}-${view}.png`);
			await writeFile(f, r.preview);
			files.push(f);
		}
		const label = `${name}  ·  ${t.note}  ·  ${v.height} cm`.replace(/:/g, '\\:');
		ff(...files.flatMap((f) => ['-i', f]), '-filter_complex', `[0][1][2]hstack=3,pad=iw:ih+60:0:60:white,drawtext=fontfile=${FONT}:text='${label}':x=20:y=18:fontsize=28:fontcolor=0x333333`, join(out, `${id}.png`));
		fronts.push({ f: files[0], name });
		console.log('sheet', id);
	}
}
// Overview: all fronts in rows of 10, labelled.
const cells = fronts.map((x, i) => { const c = join(out, 'views', `cell${i}.png`); ff('-i', x.f, '-vf', `scale=200:-1,pad=iw:ih+34:0:34:white,drawtext=fontfile=${FONT}:text='${x.name.replace(/:/g, '\\:')}':x=(w-text_w)/2:y=6:fontsize=18:fontcolor=0x333333`, c); return c; });
const rows = [];
for (let i = 0; i < cells.length; i += 10) {
	const row = cells.slice(i, i + 10);
	const r = join(out, 'views', `row${i}.png`);
	ff(...row.flatMap((c) => ['-i', c]), '-filter_complex', row.length > 1 ? `hstack=${row.length}` : 'null', r);
	rows.push(r);
}
if (rows.length) ff(...rows.flatMap((r) => ['-i', r]), '-filter_complex', rows.length > 1 ? `vstack=${rows.length}` : 'null', join(out, 'overview.png'));
console.log('overview', join(out, 'overview.png'));
