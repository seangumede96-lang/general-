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
# Marker points are kept (not drawn) so the viewer can find places that move with the morphs:
# the eye joints (for eyeballs) and the arm joints (to pose the arms).
eye_start = len(used)
used += sorted(eyes['joint-l-eye']) + sorted(eyes['joint-r-eye'])
skel = json.load(open(data / 'rigs' / 'default.mhskel'))
markers = {}
for side in 'LR':
    for joint in ('shoulder01', 'upperarm01', 'wrist'):
        idx = skel['joints'][f'{joint}.{side}____head']
        markers[f'{joint}.{side}'] = [len(used), len(idx)]
        used += idx
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

def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)

M = 'macrodetails/universal-{g}-young-{m}muscle-{w}weight.target'
morphs = {}
for g in ('female', 'male'):
    # The gender shape lives in the ethnic targets (the average-build universal target is empty);
    # MakeHuman's default mixes the three equally, so do the same.
    eth = [target(f'macrodetails/{e}-{g}-young.target') for e in ('african', 'asian', 'caucasian')]
    morphs[g] = {k: tuple(sum(t.get(k, (0, 0, 0))[c] for t in eth) / 3 for c in range(3)) for k in set().union(*eth)}
    avg = target(M.format(g=g, m='average', w='average'))
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
# Bow legs (varus) and knock knees (valgus): MakeHuman's per-leg valgus targets, both legs together.
def both(a, b):
    out = dict(a)
    for k, v in b.items(): out[k] = tuple(p + q for p, q in zip(out.get(k, (0, 0, 0)), v))
    return out
morphs['bowlegs-up'] = both(target('armslegs/l-leg-valgus-decr.target'), target('armslegs/r-leg-valgus-decr.target'))
morphs['bowlegs-down'] = both(target('armslegs/l-leg-valgus-incr.target'), target('armslegs/r-leg-valgus-incr.target'))

# Thigh gap: MakeHuman has no target for it, so it is made here. The inner side of each thigh,
# from just below the crotch down towards the knee, moves outwards (or inwards for "less").
CROTCH, KNEE, LIMIT, AMOUNT = -0.35, -4.2, 2.6, 0.17  # MakeHuman units are decimetres
legs = [(new, verts[old]) for old, new in remap.items() if new < eye_start and KNEE - 0.3 < verts[old][1] < CROTCH and abs(verts[old][0]) < LIMIT]
gap = {}
for i, (x, y, z) in legs:
    side = [abs(v[0]) for _, v in legs if abs(v[1] - y) < 0.2 and v[0] * x > 0]
    if len(side) < 4: continue
    lo, hi = min(side), max(side)
    centre, radius = (lo + hi) / 2, max(0.05, (hi - lo) / 2)
    inner = smooth((centre - abs(x)) / radius * 1.5)
    t1 = smooth((CROTCH - y) / 0.9)
    t2 = smooth((CROTCH - 1.0 - y) / (CROTCH - 1.0 - KNEE))
    dx = inner * t1 * (1 - t2) * AMOUNT
    if dx > 1e-4: gap[i] = (dx if x > 0 else -dx, 0.0, 0.0)
morphs['thigh-gap-up'] = gap
morphs['thigh-gap-down'] = {k: (-v[0], 0.0, 0.0) for k, v in gap.items()}
morphs['breast-up'] = target('breast/breast-trans-up.target')
morphs['breast-down'] = target('breast/breast-trans-down.target')
for shape in ['oval', 'round', 'square', 'rectangular', 'triangular', 'invertedtriangular', 'diamond']:
    morphs[f'head-{shape}'] = target(f'head/head-{shape}.target')

# Breasts: MakeHuman's own breast controls (firmness at an average cup, position on the chest,
# upper/lower fullness, how pointed). Cup size is 'cup' above, spacing is 'breast-dist'.
FB = 'breast/female-young-averagemuscle-averageweight-averagecup-{f}firmness.target'
morphs['firmness-up'] = target(FB.format(f='max'))
morphs['firmness-down'] = target(FB.format(f='min'))
morphs['breast-point-up'] = target('breast/breast-point-incr.target')
morphs['breast-point-down'] = target('breast/breast-point-decr.target')
morphs['breast-fullness-up'] = target('breast/breast-volume-vert-up.target')
morphs['breast-fullness-down'] = target('breast/breast-volume-vert-down.target')
# Torso detail, after Daz's chest/back/waist dials.
for a, b in [('torso/torso-muscle-pectoral', 'pecs'), ('torso/torso-muscle-dorsi', 'lats'), ('torso/torso-vshape', 'vshape'), ('stomach/stomach-tone', 'abs'), ('hip/hip-scale-horiz', 'hip-width')]:
    morphs[f'{b}-up'] = target(f'{a}-incr.target')
    morphs[f'{b}-down'] = target(f'{a}-decr.target')
morphs['hip-height-up'] = target('hip/hip-trans-up.target')
morphs['hip-height-down'] = target('hip/hip-trans-down.target')

# Buttocks: MakeHuman only has a volume control, so the shape controls are made here. Its
# volume target marks where the buttocks are (how far each vertex moves is used as a soft
# mask), and the region is then lifted, pushed out, widened, or filled at the top or bottom.
vol = target('buttocks/buttocks-volume-incr.target')
peak = max((sum(c * c for c in v) ** 0.5 for v in vol.values()), default=1)
mask = {}
for k, v in vol.items():
    m = (sum(c * c for c in v) ** 0.5) / peak
    if m > 0.01 and k < eye_start: mask[k] = smooth(m) ** 0.8  # soft edges, no ridge where the region ends
pos = {k: verts[used[k]] for k in mask}
ys = [pos[k][1] for k in mask]
lo_y, hi_y = min(ys), max(ys)
def glute(fn):
    return {k: fn(k, m, pos[k]) for k, m in mask.items()}
LIFT, OUT, WIDE = 0.26, 0.34, 0.2  # decimetres at full strength
morphs['glute-lift-up'] = glute(lambda k, m, p: (0.0, LIFT * m, 0.0))
morphs['glute-lift-down'] = glute(lambda k, m, p: (0.0, -LIFT * m, 0.0))
morphs['glute-out-up'] = glute(lambda k, m, p: (0.0, 0.0, -OUT * m))
morphs['glute-out-down'] = glute(lambda k, m, p: (0.0, 0.0, OUT * 0.6 * m))
morphs['glute-width-up'] = glute(lambda k, m, p: ((WIDE if p[0] > 0 else -WIDE) * m, 0.0, 0.0))
morphs['glute-width-down'] = glute(lambda k, m, p: ((-WIDE if p[0] > 0 else WIDE) * 0.7 * m, 0.0, 0.0))
def top(p): return smooth((p[1] - lo_y) / (hi_y - lo_y))
morphs['glute-top-up'] = glute(lambda k, m, p: (0.0, 0.0, -OUT * m * top(p)))  # fuller at the top
morphs['glute-top-down'] = glute(lambda k, m, p: (0.0, -0.05 * m * (1 - top(p)), -OUT * m * (1 - top(p))))  # fuller at the bottom

# --- binary: positions (float32), indices (uint16/uint32), then per morph: count, indices (uint16), offsets (float32 x3)
n = len(used)
blob = bytearray()
layout = {'vertices': n, 'triangles': len(tris) // 3, 'markers': markers, 'eyes': [[eye_start, len(eyes['joint-l-eye'])], [eye_start + len(eyes['joint-l-eye']), len(eyes['joint-r-eye'])]]}
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
# Skin weights for posing the arms (MakeHuman's default rig, CC0): per side, how much each vertex
# follows the shoulder bone itself, and how much it follows the whole arm below it.
weights = json.load(open(data / 'rigs' / 'default_weights.mhw'))['weights']
bones = skel['bones']
def below(name):
    return [b for b in bones if any(a == name for a in ancestors(b))]
def ancestors(b):
    while b:
        yield b
        b = bones[b]['parent']
layout['skin'] = {}
for side in 'LR':
    for part, names in (('shoulder', [f'shoulder01.{side}']), ('arm', below(f'upperarm01.{side}'))):
        w = {}
        for name in names:
            for i, x in weights.get(name, []):
                if i in remap and remap[i] < eye_start: w[remap[i]] = w.get(remap[i], 0) + x
        keys = sorted(w)
        while len(blob) % 4: blob += b'\0'
        entry = {'count': len(keys), 'indices': len(blob)}
        blob += struct.pack(f"<{len(keys)}{'I' if big else 'H'}", *keys)
        while len(blob) % 4: blob += b'\0'
        entry['weights'] = len(blob)
        blob += struct.pack(f'<{len(keys)}f', *[min(1.0, w[k]) for k in keys])
        layout['skin'][f'{part}.{side}'] = entry
# Smoothing: one level of Catmull-Clark subdivision, stored as fixed weights over the base
# vertices. The phone shapes and poses the base mesh, then applies these weights to draw a
# four-times finer, smoother surface (the same idea as a subdivision modifier in Blender).
body_faces = [[remap[i] for i in f] for f in faces]
nv = eye_start
edges = {}
vert_faces = [[] for _ in range(nv)]
for fi, f in enumerate(body_faces):
    for k in range(len(f)):
        a, b = f[k], f[(k + 1) % len(f)]
        edges.setdefault((min(a, b), max(a, b)), []).append(fi)
        vert_faces[a].append(fi)
vert_edges = [[] for _ in range(nv)]
for (a, b) in edges:
    vert_edges[a].append(b); vert_edges[b].append(a)
def face_point(fi):
    f = body_faces[fi]
    return {v: 1 / len(f) for v in f}
def add_to(acc, row, k):
    for v, w in row.items(): acc[v] = acc.get(v, 0) + w * k
rows = []
for v in range(nv):  # vertex points
    acc = {}
    bnd = [u for u in vert_edges[v] if len(edges[(min(u, v), max(u, v))]) == 1]
    if bnd:
        acc[v] = 0.75
        for u in bnd[:2]: acc[u] = acc.get(u, 0) + 0.125
    elif vert_faces[v]:
        n = len(vert_edges[v])
        for fi in vert_faces[v]: add_to(acc, face_point(fi), 1 / len(vert_faces[v]) / n)
        for u in vert_edges[v]: add_to(acc, {v: 0.5, u: 0.5}, 2 / len(vert_edges[v]) / n)
        acc[v] = acc.get(v, 0) + (n - 3) / n
    else:
        acc[v] = 1.0
    rows.append(acc)
edge_index = {}
for e, fl in edges.items():  # edge points
    a, b = e
    acc = {a: 0.5, b: 0.5}
    if len(fl) == 2:
        acc = {a: 0.25, b: 0.25}
        for fi in fl: add_to(acc, face_point(fi), 0.25)
    edge_index[e] = len(rows)
    rows.append(acc)
face_index = []
for fi in range(len(body_faces)):  # face points
    face_index.append(len(rows))
    rows.append(face_point(fi))
sub_tris = []
for fi, f in enumerate(body_faces):
    n = len(f)
    for k in range(n):
        prev, cur, nxt = f[k - 1], f[k], f[(k + 1) % n]
        q = [cur, edge_index[(min(cur, nxt), max(cur, nxt))], face_index[fi], edge_index[(min(prev, cur), max(prev, cur))]]
        sub_tris += [q[0], q[1], q[2], q[0], q[2], q[3]]
nnz = sum(len(r) for r in rows)
sub_big = len(rows) > 65535
while len(blob) % 4: blob += b'\0'
layout['subdiv'] = {'vertices': len(rows), 'triangles': len(sub_tris) // 3, 'indexType': 'uint32' if sub_big else 'uint16', 'nnz': nnz}
layout['subdiv']['starts'] = len(blob); acc = 0; starts = []
for r in rows: starts.append(acc); acc += len(r)
starts.append(acc)
blob += struct.pack(f'<{len(starts)}I', *starts)
layout['subdiv']['cols'] = len(blob)
blob += struct.pack(f"<{nnz}{'I' if big else 'H'}", *[v for r in rows for v in r])
while len(blob) % 4: blob += b'\0'
layout['subdiv']['weights'] = len(blob)
blob += struct.pack(f'<{nnz}f', *[w for r in rows for w in r.values()])
layout['subdiv']['indices'] = len(blob)
blob += struct.pack(f"<{len(sub_tris)}{'I' if sub_big else 'H'}", *sub_tris)
print(f'subdivided: {len(rows)} vertices, {len(sub_tris) // 3} triangles, {nnz} weights')
(out / 'human.bin').write_bytes(bytes(blob))
(out / 'human.json').write_text(json.dumps(layout))
print(f"{layout['vertices']} vertices, {len(tris) // 3} triangles, {len(morphs)} morphs, {len(blob) / 1e6:.1f} MB")
