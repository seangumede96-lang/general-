#!/usr/bin/env python3
"""Build the body editor's mannequin from MakeHuman's CC0 base mesh and targets.

  python3 tools/build-human.py <makehuman/data dir> <output dir>

Writes human.json (layout, morph names) and human.bin (base positions, triangle indices and
sparse morph offsets) for public/body.js. Only the skin of the body is kept; eyes, teeth,
helper geometry and joint markers are dropped, so it reads as a smooth mannequin.
MakeHuman assets are CC0 1.0 (see LICENSE.ASSETS.md in the MakeHuman repository).
"""
import json, math, struct, sys
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
    for joint in ('shoulder01', 'upperarm01', 'lowerarm01', 'wrist', 'upperleg01', 'foot'):
        idx = skel['joints'][f'{joint}.{side}____head']
        markers[f'{joint}.{side}'] = [len(used), len(idx)]
        used += idx
# More joints for the posing rig (Pose mode): the spine, neck and head, collarbones, knees, and
# the ends of the hands, feet and head (for dragging them). Added after the others, so the
# layout above is unchanged.
POSE_MARKERS = {'spine04': 'spine04____head', 'spine02': 'spine02____head', 'neck01': 'neck01____head',
                'head': 'head____head', 'head.top': 'head____tail'}
for side in 'LR':
    POSE_MARKERS.update({f'clavicle.{side}': f'clavicle.{side}____head', f'lowerleg01.{side}': f'lowerleg01.{side}____head',
                         f'hand.{side}': f'finger3-1.{side}____head', f'fingertip.{side}': f'finger3-3.{side}____tail',
                         f'toe.{side}': f'toe3-1.{side}____head'})
for name, joint in POSE_MARKERS.items():
    idx = skel['joints'][joint]
    markers[name] = [len(used), len(idx)]
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
# Separation between the cheeks: a cleft down the middle (its own region: the buttock mask is
# weakest exactly there), a crease under each cheek, and rounder cheek centres, so the two
# cheeks read as distinct shapes, as the breasts do.
cleft_rows = [k for k in range(eye_start) if lo_y - 0.25 <= verts[used[k]][1] <= hi_y and abs(verts[used[k]][0]) < 1.6]
split = {}
for k in cleft_rows:
    x, y, z = verts[used[k]]
    zs = [verts[used[j]][2] for j in cleft_rows if abs(verts[used[j]][1] - y) < 0.06]
    zc = (min(zs) + max(zs)) / 2
    if z > zc: continue  # back half of the body only
    behind = smooth((zc - z) / 0.5)
    t = (y - lo_y) / (hi_y - lo_y)
    along = smooth((t + 0.15) / 0.3) * smooth((0.72 - t) / 0.3)  # fades in at the bottom, out where the cheeks end
    cleft = math.exp(-(x / 0.2) ** 2) * along * behind
    dz = 0.45 * cleft
    m = mask.get(k, 0.0)
    centre = math.exp(-((abs(x) - 0.6) / 0.32) ** 2) * m
    under = math.exp(-((y - lo_y) / 0.18) ** 2) * smooth((abs(x) - 0.1) / 0.3) * behind
    dz += 0.06 * under - 0.2 * centre
    dy = 0.04 * under
    if abs(dz) > 1e-4 or abs(dy) > 1e-4: split[k] = (0.0, dy, dz)
morphs['glute-split-up'] = split
morphs['glute-split-down'] = {k: tuple(-c * 0.7 for c in v) for k, v in split.items()}
morphs['glute-top-down'] = glute(lambda k, m, p: (0.0, -0.05 * m * (1 - top(p)), -OUT * m * (1 - top(p))))  # fuller at the bottom

# Hip dips and lower belly (FUPA), measured from the base body around the crotch level.
body_idx = [k for k in range(eye_start)]
bp = {k: verts[used[k]] for k in body_idx}
def band(y0, y1, xmax):
    return [k for k in body_idx if y0 <= bp[k][1] <= y1 and abs(bp[k][0]) < xmax]
# Hip dips: the outer side of the hips, between the hip bone and the top of the thigh, sinks in.
DIP_Y, DIP_H = CROTCH + 0.55, 0.45
hip_band = band(DIP_Y - 1.2, DIP_Y + 1.2, 2.3)
# Made at five heights (6 cm apart) so the editor can slide the dip up and down by blending
# neighbours.
DIP_STEPS = [-0.6, -0.3, 0.0, 0.3, 0.6]
for n, off in enumerate(DIP_STEPS):
    dips = {}
    for k in hip_band:
        x, y, z = bp[k]
        side = [abs(bp[j][0]) for j in hip_band if abs(bp[j][1] - y) < 0.08]
        wmax = max(side)
        outer = smooth((abs(x) / wmax - 0.72) / 0.28)
        zs = [bp[j][2] for j in hip_band if abs(bp[j][1] - y) < 0.08]
        zc = sum(zs) / len(zs)
        lateral = smooth(1 - abs(z - zc) / 0.9)
        w = outer * lateral * math.exp(-((y - DIP_Y - off) / 0.35) ** 2)
        if w > 1e-3: dips[k] = (-(0.2 * w) if x > 0 else 0.2 * w, 0.0, 0.0)
    morphs[f'hip-dips-{n}-up'] = dips
    morphs[f'hip-dips-{n}-down'] = {k: (-v[0] * 0.8, 0.0, 0.0) for k, v in dips.items()}
layout_extra = {'hipDipSteps': len(DIP_STEPS)}
# Lower belly (FUPA): a soft mound above the pubic bone, on the front only.
FUPA_Y = CROTCH + 0.65
FUPA_STEPS = [-0.4, -0.2, 0.0, 0.2, 0.4]  # five heights, 2 cm apart, for the height slider
fupa_band = band(CROTCH - 0.6, CROTCH + 1.8, 1.4)
centres = {}
for k in fupa_band:
    y = bp[k][1]
    key = round(y / 0.08)
    if key not in centres:
        zs = [bp[j][2] for j in body_idx if abs(bp[j][1] - y) < 0.08 and abs(bp[j][0]) < 1.4]
        centres[key] = sum(zs) / len(zs)
for n, off in enumerate(FUPA_STEPS):
    fupa = {}
    for k in fupa_band:
        x, y, z = bp[k]
        zc = centres[round(y / 0.08)]
        if z <= zc: continue
        front = smooth((z - zc) / 0.6)
        w = front * math.exp(-((y - FUPA_Y - off) / 0.42) ** 2) * math.exp(-(x / 1.0) ** 2)
        if w > 1e-3: fupa[k] = (0.0, -0.02 * w, 0.19 * w)
    morphs[f'fupa-{n}-up'] = fupa
    morphs[f'fupa-{n}-down'] = {k: (0.0, 0.0, -v[2] * 0.6) for k, v in fupa.items()}

# Midsection, between the waist and the bottom of the ribcage: its length (the figure gets
# taller or shorter: the editor adds this after scaling to the chosen height), its width, and
# the belly button's height. Arm vertices move with the chest, so the arms keep their length.
WAIST_Y, CHEST_Y, ARMPIT_Y = 2.7, 4.3, 5.3
wts = json.load(open(data / 'rigs' / 'default_weights.mhw'))['weights']
arm_w = {}
for bone, lst in wts.items():
    if any(t in bone for t in ('upperarm', 'lowerarm', 'wrist', 'finger', 'metacarpal', 'shoulder01', 'clavicle')):
        for i, x in lst:
            if i in remap: arm_w[remap[i]] = min(1.0, arm_w.get(remap[i], 0) + x)
LONG = 0.6  # decimetres at full strength
long_up = {}
for k in range(len(used)):
    x, y, z = verts[used[k]]
    ramp = smooth((y - WAIST_Y) / (CHEST_Y - WAIST_Y))
    a = arm_w.get(k, 0.0)
    if any(k in range(st, st + c) for st, c in markers.values() if True):
        a = 1.0 if y > WAIST_Y else a  # joint markers of the arms move with the chest
    dy = LONG * (a + (1 - a) * ramp)
    if dy > 1e-4: long_up[k] = (0.0, dy, 0.0)
morphs['midsection-long-up'] = long_up
morphs['midsection-long-down'] = {k: (0.0, -v[1] * 0.8, 0.0) for k, v in long_up.items()}
mid_rows = {}
wide = {}
for k in body_idx:
    x, y, z = bp[k]
    if arm_w.get(k, 0.0) > 0.5: continue
    # Straight-line fades only (no S-curves): full from the waist to the bottom of the ribcage,
    # fading in a straight line to nothing at the armpits and at the top of the hips.
    lin = lambda t: min(1.0, max(0.0, t))
    bump = min(lin((y - (WAIST_Y - 0.9)) / 0.9), lin((ARMPIT_Y - y) / (ARMPIT_Y - CHEST_Y))) * (1 - arm_w.get(k, 0.0))
    if bump <= 1e-3: continue
    key = round(y / 0.08)
    if key not in mid_rows:
        xs = [abs(bp[j][0]) for j in body_idx if abs(bp[j][1] - y) < 0.08 and arm_w.get(j, 0.0) < 0.3 and abs(bp[j][0]) < 2.2]
        mid_rows[key] = max(xs) if xs else 1.0
    half = mid_rows[key]
    # Only the sides move, outwards by an even amount; the chest, breasts and abs in the middle
    # are not stretched, so they keep their shape.
    side = smooth((abs(x) / half - 0.5) / 0.4)
    if side <= 1e-3: continue
    dx = 0.2 * side * bump
    wide[k] = (dx if x > 0 else -dx, 0.0, 0.0)
morphs['midsection-wide-up'] = wide
morphs['midsection-wide-down'] = {k: tuple(-c * 0.8 for c in v) for k, v in wide.items()}
morphs['navel-up'] = target('stomach/stomach-navel-up.target')
morphs['navel-in'] = target('stomach/stomach-navel-in.target')
morphs['navel-down'] = target('stomach/stomach-navel-down.target')

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
    foot = below(f'foot.{side}')
    leg = [b for b in below(f'upperleg01.{side}') if b not in foot]
    for part, names in (('shoulder', [f'shoulder01.{side}']), ('arm', below(f'upperarm01.{side}')), ('forearm', below(f'lowerarm01.{side}')), ('leg', leg), ('foot', foot)):
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
# The posing rig: MakeHuman's 163 bones gathered into 19 body parts, each turning about its own
# joint. Every bone belongs to the part of its nearest ancestor that starts a part, so the face
# goes with the head, fingers with the hand, toes with the foot. Per vertex: up to 4 parts and
# their weights (summing to 1). Joint markers follow the part above their joint.
PARTS = [('hips', 'root'), ('waist', 'spine04'), ('chest', 'spine02'), ('neck', 'neck01'), ('head', 'head')]
for side in 'LR':
    PARTS += [(f'clavicle.{side}', f'clavicle.{side}'), (f'upperArm.{side}', f'upperarm01.{side}'), (f'forearm.{side}', f'lowerarm01.{side}'),
              (f'hand.{side}', f'wrist.{side}'), (f'thigh.{side}', f'upperleg01.{side}'), (f'shin.{side}', f'lowerleg01.{side}'), (f'foot.{side}', f'foot.{side}')]
part_of_start = {bone: i for i, (_, bone) in enumerate(PARTS)}
def part_of(bone):
    for b in ancestors(bone):
        if b in part_of_start: return part_of_start[b]
    return 0
vw = [dict() for _ in range(n)]
for bone, lst in weights.items():
    pi = part_of(bone)
    for i, x in lst:
        if i in remap: vw[remap[i]][pi] = vw[remap[i]].get(pi, 0) + x
for k in range(eye_start, eye_start + len(eyes['joint-l-eye']) + len(eyes['joint-r-eye'])):
    if not vw[k]: vw[k] = {part_of_start['head']: 1.0}
# A joint marker sits where its part meets the part above: it moves with the part above.
MARKER_PART = {'spine04': 'hips', 'spine02': 'waist', 'neck01': 'chest', 'head': 'neck', 'head.top': 'head'}
for side in 'LR':
    MARKER_PART.update({f'shoulder01.{side}': f'clavicle.{side}', f'upperarm01.{side}': f'clavicle.{side}', f'lowerarm01.{side}': f'upperArm.{side}',
                        f'wrist.{side}': f'forearm.{side}', f'hand.{side}': f'hand.{side}', f'fingertip.{side}': f'hand.{side}',
                        f'upperleg01.{side}': 'hips', f'clavicle.{side}': 'chest', f'lowerleg01.{side}': f'thigh.{side}',
                        f'foot.{side}': f'shin.{side}', f'toe.{side}': f'foot.{side}'})
names = [p for p, _ in PARTS]
for m, (st, c) in markers.items():
    for k in range(st, st + c): vw[k] = {names.index(MARKER_PART[m]): 1.0}
J = bytearray(); Wt = []
for k in range(n):
    top = sorted(vw[k].items(), key=lambda t: -t[1])[:4]
    s = sum(w for _, w in top) or 1.0
    if not top: top = [(0, 1.0)]; s = 1.0
    top += [(0, 0.0)] * (4 - len(top))
    J += bytes(j for j, _ in top); Wt += [w / s for _, w in top]
while len(blob) % 4: blob += b'\0'
layout['rig'] = {'parts': names, 'parents': [names.index(p) if p else -1 for p in
                 [None, 'hips', 'waist', 'chest', 'neck'] + [x for side in 'LR' for x in ['chest', f'clavicle.{side}', f'upperArm.{side}', f'forearm.{side}', 'hips', f'thigh.{side}', f'shin.{side}']]]}
layout['rig']['joints'] = len(blob); blob += bytes(J)
while len(blob) % 4: blob += b'\0'
layout['rig']['weights'] = len(blob); blob += struct.pack(f'<{n * 4}f', *Wt)
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
