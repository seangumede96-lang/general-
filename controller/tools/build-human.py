#!/usr/bin/env python3
"""Build the body editor's mannequin from MakeHuman's CC0 base mesh and targets.

  python3 tools/build-human.py <makehuman/data dir> <output dir>

Writes human.json (layout, morph names) and human.bin (base positions, triangle indices and
sparse morph offsets) for public/body.js. Only the skin of the body is kept; eyes, teeth,
helper geometry and joint markers are dropped, so it reads as a smooth mannequin.
MakeHuman assets are CC0 1.0 (see LICENSE.ASSETS.md in the MakeHuman repository).
"""
import json, struct, sys
from pathlib import Path

data = Path(sys.argv[1]); out = Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
T = data / 'targets'

# --- base mesh: keep faces of the "body" group only
verts, faces, group = [], [], None
eyes = {'joint-l-eye': set(), 'joint-r-eye': set()}
for line in open(data / '3dobjs' / 'base.obj'):
    if line.startswith('v '):
        verts.append(tuple(map(float, line.split()[1:4])))
    elif line.startswith('g '):
        group = line.split()[1]
    elif line.startswith('f ') and group == 'body':
        faces.append([int(p.split('/')[0]) - 1 for p in line.split()[1:]])
    elif line.startswith('f ') and group in ('joint-l-eye', 'joint-r-eye'):
        eyes[group].update(int(p.split('/')[0]) - 1 for p in line.split()[1:])
used = sorted({i for f in faces for i in f})
# The eye joint markers are kept (not drawn) so the viewer can place eyeballs that follow the morphs.
eye_start = len(used)
used += sorted(eyes['joint-l-eye']) + sorted(eyes['joint-r-eye'])
remap = {old: new for new, old in enumerate(used)}
tris = []
for f in faces:
    f = [remap[i] for i in f]
    for k in range(1, len(f) - 1):
        tris += [f[0], f[k], f[k + 1]]

def target(rel):
    d = {}
    for line in open(T / rel):
        if line[:1] in '#\n' or not line.strip():
            continue
        i, x, y, z = line.split()
        i = int(i)
        if i in remap:
            d[remap[i]] = (float(x), float(y), float(z))
    return d

def diff(a, b):
    """Offsets that take shape b to shape a (both offsets from the base)."""
    keys = set(a) | set(b)
    return {k: tuple(p - q for p, q in zip(a.get(k, (0, 0, 0)), b.get(k, (0, 0, 0)))) for k in keys}

M = 'macrodetails/universal-{g}-young-{m}muscle-{w}weight.target'
morphs = {}
for g in ('female', 'male'):
    avg = target(M.format(g=g, m='average', w='average'))
    morphs[g] = avg
    morphs[f'{g}-weight-up'] = diff(target(M.format(g=g, m='average', w='max')), avg)
    morphs[f'{g}-weight-down'] = diff(target(M.format(g=g, m='average', w='min')), avg)
    morphs[f'{g}-muscle-up'] = diff(target(M.format(g=g, m='max', w='average')), avg)
    morphs[f'{g}-muscle-down'] = diff(target(M.format(g=g, m='min', w='average')), avg)
B = 'breast/female-young-averagemuscle-averageweight-{c}cup-averagefirmness.target'
morphs['cup-up'] = target(B.format(c='max'))
morphs['cup-down'] = target(B.format(c='min'))
for name in ['neck-height', 'neck-circ', 'shoulder-dist', 'frontchest-dist', 'bust-circ', 'underbust-circ', 'waist-circ', 'hips-circ',
             'thigh-circ', 'calf-circ', 'upperarm-circ', 'upperarm-length', 'lowerarm-length', 'upperleg-height', 'lowerleg-height',
             'napetowaist-dist', 'waisttohip-dist', 'wrist-circ', 'ankle-circ', 'knee-circ']:
    morphs[f'{name}-up'] = target(f'measure/measure-{name}-incr.target')
    morphs[f'{name}-down'] = target(f'measure/measure-{name}-decr.target')
for a, b in [('buttocks/buttocks-volume', 'glutes'), ('hip/hip-scale-depth', 'hip-depth'), ('torso/torso-scale-depth', 'torso-depth'),
             ('stomach/stomach-pregnant', 'belly'), ('head/head-scale-vert', 'head-height'), ('head/head-scale-horiz', 'head-width'), ('breast/breast-dist', 'breast-dist')]:
    morphs[f'{b}-up'] = target(f'{a}-incr.target')
    morphs[f'{b}-down'] = target(f'{a}-decr.target')
morphs['breast-up'] = target('breast/breast-trans-up.target')
morphs['breast-down'] = target('breast/breast-trans-down.target')
for shape in ['oval', 'round', 'square', 'rectangular', 'triangular', 'invertedtriangular', 'diamond']:
    morphs[f'head-{shape}'] = target(f'head/head-{shape}.target')

# --- binary: positions (float32), indices (uint16/uint32), then per morph: count, indices (uint16), offsets (float32 x3)
n = len(used)
blob = bytearray()
layout = {'vertices': n, 'triangles': len(tris) // 3, 'eyes': [[eye_start, len(eyes['joint-l-eye'])], [eye_start + len(eyes['joint-l-eye']), len(eyes['joint-r-eye'])]]}
layout['positions'] = len(blob); blob += struct.pack(f'<{n * 3}f', *[c for i in used for c in verts[i]])
big = n > 65535
layout['indexType'] = 'uint32' if big else 'uint16'
while len(blob) % 4: blob += b'\0'
layout['indices'] = len(blob); blob += struct.pack(f"<{len(tris)}{'I' if big else 'H'}", *tris)
layout['morphs'] = []
for name, d in morphs.items():
    keys = sorted(k for k, v in d.items() if any(abs(c) > 1e-6 for c in v))
    while len(blob) % 4: blob += b'\0'
    entry = {'name': name, 'count': len(keys), 'indices': len(blob)}
    blob += struct.pack(f"<{len(keys)}{'I' if big else 'H'}", *keys)
    while len(blob) % 4: blob += b'\0'
    entry['offsets'] = len(blob)
    blob += struct.pack(f'<{len(keys) * 3}f', *[c for k in keys for c in d[k]])
    layout['morphs'].append(entry)
(out / 'human.bin').write_bytes(bytes(blob))
(out / 'human.json').write_text(json.dumps(layout))
print(f'{n} vertices, {len(tris) // 3} triangles, {len(morphs)} morphs, {len(blob) / 1e6:.1f} MB')
