// Makes the animation tests' sample clips from the app's own grey mannequin (no real person):
//   one.mp4  one figure: stand, walk, wave, arms up            (test/ui/animation.mjs)
//   two.mp4  two figures walk towards each other and high-five (test/ui/animation-two.mjs)
// Needs ffmpeg. Run: node tools/test-clips.mjs <output folder>
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const { renderBody } = await import('../src/body-depth.js');
const { POSE_PRESETS, mirrorPose } = await import('../public/pose.js');
const out = process.argv[2];
const tmp = join(out, 'frames');
await mkdir(tmp, { recursive: true });
const lerp = (a, b, t) => { const o = {}; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { o[k] = {}; for (const ax of new Set([...Object.keys(a[k] || {}), ...Object.keys(b[k] || {})])) o[k][ax] = (a[k]?.[ax] || 0) * (1 - t) + (b[k]?.[ax] || 0) * t; } return o; };
const ff = (...args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);
const n3 = (i) => String(i).padStart(3, '0');

// One figure.
const keys = ['Standing', 'Walking', 'Standing', 'Waving', 'Arms up', 'Standing'];
for (let i = 0; i < 40; i++) {
	const u = i / 39 * (keys.length - 1), k = Math.min(keys.length - 2, Math.floor(u));
	await writeFile(join(tmp, `o${n3(i)}.png`), (await renderBody({ posing: true, pose: lerp(POSE_PRESETS[keys[k]], POSE_PRESETS[keys[k + 1]], u - k) }, { width: 360, height: 540 })).preview);
}
ff('-framerate', '10', '-i', join(tmp, 'o%03d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(out, 'one.mp4'));

// Two figures: A on the left walks right facing her left, B the mirror; then a high five.
const W = POSE_PRESETS.Walking, Wm = mirrorPose(W);
const five = (s) => ({ [`upperArm.${s}`]: { lift: 150, toward: 70 }, [`forearm.${s}`]: { bend: 20 } });
for (let i = 0; i < 50; i++) {
	const walk = i < 34, t = Math.min(1, i / 33), cyc = (Math.sin(i * 0.9) + 1) / 2;
	const pose = (mine, other, side, turn) => {
		const p = walk ? lerp(mine, other, cyc) : lerp(POSE_PRESETS.Standing, { ...POSE_PRESETS.Standing, ...five(side) }, Math.min(1, (i - 34) / 6));
		return { ...p, hips: { ...(p.hips || {}), turn } };
	};
	const ra = await renderBody({ posing: true, pose: pose(W, Wm, 'L', 35) }, { width: 360, height: 540 });
	const rb = await renderBody({ posing: true, pose: pose(Wm, W, 'R', -35) }, { width: 360, height: 540 });
	await writeFile(join(tmp, 'a.png'), ra.preview); await writeFile(join(tmp, 'b.png'), rb.preview);
	const xa = Math.round(20 + 150 * t), xb = Math.round(440 - 150 * t);
	ff('-f', 'lavfi', '-i', 'color=white:s=820x540', '-i', join(tmp, 'b.png'), '-i', join(tmp, 'a.png'), '-filter_complex',
		`[1]colorkey=white:0.01:0.0[b];[2]colorkey=white:0.01:0.0[a];[0][b]overlay=${xb}:0[t];[t][a]overlay=${xa}:0`, '-frames:v', '1', join(tmp, `t${n3(i)}.png`));
}
ff('-framerate', '10', '-i', join(tmp, 't%03d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(out, 'two.mp4'));
console.log(`made ${join(out, 'one.mp4')} and ${join(out, 'two.mp4')}`);
