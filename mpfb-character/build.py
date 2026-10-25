"""Builds the tiefling character with MPFB in headless Blender.

Usage:
  blender -b --python build.py -- [--preview] [--view full|face|both] [--out DIR]

Everything is scripted: MPFB generates and shapes the human from its CC0
assets, and this script adds the fantasy parts, outfit, materials, studio and
cameras, then renders with Cycles on the CPU.
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.locationservice import LocationService
from bl_ext.user_default.mpfb.services.targetservice import TargetService

HERE = os.path.dirname(os.path.abspath(__file__))
MPFB_DATA = LocationService.get_mpfb_data()
USER_DATA = LocationService.get_user_data()

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--preview", action="store_true", help="fast low-sample render")
ap.add_argument("--view", default="both", choices=["full", "face", "both"])
ap.add_argument("--out", default=HERE)
args = ap.parse_args(argv)


# ---------------------------------------------------------------- human
MACRO = {
    "gender": 0.0,        # female
    "age": 0.45,          # mid twenties
    "muscle": 0.5,
    "weight": 0.62,
    "proportions": 1.0,
    "height": 0.55,
    "cupsize": 0.68,
    "firmness": 0.65,
    "race": {"african": 1.0, "asian": 0.0, "caucasian": 0.0},
}

# Curvy hourglass figure from the blue reference, plus fantasy face tweaks.
TARGETS = {
    "torso/measure-waist-circ-decr": 1.0,
    "torso/measure-hips-circ-incr": 0.6,
    "hip/hip-scale-horiz-incr": 0.3,
    "buttocks/buttocks-volume-incr": 1.0,
    "legs/l-upperleg-fat-incr": 1.0,
    "legs/r-upperleg-fat-incr": 1.0,
    "legs/measure-thigh-circ-incr": 1.0,
    "legs/l-lowerleg-fat-incr": 0.5,
    "legs/r-lowerleg-fat-incr": 0.5,
    "stomach/stomach-tone-incr": 0.5,
    "ears/l-ear-shape-pointed": 1.0,
    "ears/r-ear-shape-pointed": 1.0,
    "ears/l-ear-scale-vert-incr": 0.5,
    "ears/r-ear-scale-vert-incr": 0.5,
    "ears/l-ear-rot-backward": 0.4,
    "ears/r-ear-rot-backward": 0.4,
    "mouth/mouth-upperlip-volume-incr": 0.5,
    "mouth/mouth-lowerlip-volume-incr": 0.6,
    "mouth/mouth-angles-up": 0.8,
    "head/head-oval": 0.4,
    "chin/chin-width-decr": 0.3,
}


def build_human():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    human = HumanService.create_human(macro_detail_dict=MACRO)
    for rel, weight in TARGETS.items():
        path = os.path.join(MPFB_DATA, "targets", rel + ".target.gz")
        if not os.path.exists(path):
            print("missing target", rel)
            continue
        TargetService.load_target(human, path, weight=weight)
    rig = HumanService.add_builtin_rig(human, "game_engine")
    return human, rig


def add_assets(human):
    def asset(kind, rel, **kw):
        path = os.path.join(USER_DATA, rel)
        return HumanService.add_mhclo_asset(path, human, asset_type=kind, **kw)

    asset("Eyes", "eyes/high-poly/high-poly.mhclo")
    asset("Eyebrows", "eyebrows/eyebrow001/eyebrow001.mhclo")
    asset("Eyelashes", "eyelashes/eyelashes01/eyelashes01.mhclo")
    asset("Hair", "hair/long01/long01.mhclo")
    HumanService.set_character_skin(
        os.path.join(USER_DATA, "skins/young_african_female/young_african_female.mhmat"), human)


# ---------------------------------------------------------------- pose
# MPFB humans face -Y; the character's left side is +X.
FRONT, BACK, UP = Vector((0, -1, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))


def aim_bone(rig, name, direction):
    """Rotate a pose bone so it points along a world-space direction."""
    pb = rig.pose.bones[name]
    bpy.context.view_layer.update()
    cur = (pb.tail - pb.head).normalized()
    rot = cur.rotation_difference(direction.normalized())
    m = pb.matrix.copy()
    loc = m.translation.copy()
    m = rot.to_matrix().to_4x4() @ m
    m.translation = loc
    pb.matrix = m
    bpy.context.view_layer.update()


def pose(rig):
    for side, sx in (("l", 1), ("r", -1)):
        aim_bone(rig, f"upperarm_{side}", Vector((0.17 * sx, 0.2, -1)))
        aim_bone(rig, f"lowerarm_{side}", Vector((-0.55 * sx, 0.55, -0.45)))
        aim_bone(rig, f"hand_{side}", Vector((-0.8 * sx, 0.35, -0.3)))


# ---------------------------------------------------------------- materials
def principled(name, color, rough=0.5, **kw):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    for k, v in kw.items():
        b.inputs[k].default_value = v
    return m


def recolor_skin():
    """Shift MPFB's photographic skin texture to deep crimson, keeping its detail."""
    g = bpy.data.node_groups["Human.body"]
    nodes, links = g.nodes, g.links
    tex, mix = nodes["DiffuseTexture"], nodes["Mix"]
    hsv = nodes.new("ShaderNodeHueSaturation")
    hsv.inputs["Hue"].default_value = 0.43
    hsv.inputs["Saturation"].default_value = 1.9
    hsv.inputs["Value"].default_value = 0.8
    links.new(tex.outputs["Color"], hsv.inputs["Color"])
    links.new(hsv.outputs["Color"], mix.inputs["Color1"])
    # tint toward crimson through MPFB's own colour-mix input
    for mat in bpy.data.materials:
        for n in (mat.node_tree.nodes if mat.use_nodes else []):
            if n.bl_idname == "ShaderNodeGroup" and n.node_tree == g:
                n.inputs["colorMixIn"].default_value = (0.55, 0.04, 0.05, 1)
                n.inputs["colorMixInStrength"].default_value = 0.3
                n.inputs["Roughness"].default_value = 0.42


def set_material(obj, mat, slot=None):
    if slot is None:
        obj.data.materials.clear()
        obj.data.materials.append(mat)
    else:
        obj.material_slots[slot].material = mat


def style_materials(human, assets):
    recolor_skin()
    lips = principled("Lips", (0.025, 0.006, 0.05), rough=0.3, **{"Coat Weight": 0.3})
    set_material(human, lips, slot=human.material_slots.find("Human.lips"))
    nails = principled("Nails", (0.03, 0.01, 0.02), rough=0.15)
    for s in ("Human.fingernails", "Human.toenails"):
        set_material(human, nails, slot=human.material_slots.find(s))

    # solid glowing yellow eyes
    eyes = principled("GlowEyes", (1.0, 0.8, 0.2), rough=0.1,
                      **{"Emission Color": (1.0, 0.78, 0.18, 1), "Emission Strength": 6.0})
    set_material(assets["eyes"], eyes)

    # glossy black hair with one crimson lock on her left (+X) side
    hair = assets["hair"].material_slots[0].material
    nt = hair.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(geo.outputs["Position"], sep.inputs[0])
    band = nt.nodes.new("ShaderNodeMapRange")       # x position -> streak mask
    band.data_type = "FLOAT"
    band.interpolation_type = "SMOOTHSTEP"
    band.inputs["From Min"].default_value = STREAK_X[0]
    band.inputs["From Max"].default_value = STREAK_X[1]
    nt.links.new(sep.outputs["X"], band.inputs["Value"])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["A"].default_value = (0.012, 0.01, 0.012, 1)
    mix.inputs["B"].default_value = (0.32, 0.01, 0.025, 1)
    nt.links.new(band.outputs["Result"], mix.inputs["Factor"])
    nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.32
    bsdf.inputs["Coat Weight"].default_value = 0.3

    brows = assets["brows"].material_slots[0].material.node_tree.nodes["Principled BSDF"]
    for n in assets["brows"].material_slots[0].material.node_tree.nodes:
        if n.name == "diffuseIntensity":
            n.inputs["Color2"].default_value = (0.01, 0.005, 0.005, 1)
    brows.inputs["Roughness"].default_value = 0.6


STREAK_X = (0.012, 0.03)   # set from the head position at build time


# ---------------------------------------------------------------- landmarks
def posed_positions(human):
    """World positions of every basemesh vertex after shape keys and pose.

    The helper-hiding Mask modifier is switched off while evaluating so the
    result lines up 1:1 with the basemesh vertex indices and vertex groups.
    """
    mask = human.modifiers["Hide helpers"]
    mask.show_viewport = False
    dg = bpy.context.evaluated_depsgraph_get()
    ev = human.evaluated_get(dg)
    me = ev.to_mesh()
    pts = [human.matrix_world @ v.co for v in me.vertices]
    ev.to_mesh_clear()
    mask.show_viewport = True
    return pts


def group_members(human, name, min_weight=0.5):
    idx = human.vertex_groups[name].index
    return {v.index for v in human.data.vertices
            if any(g.group == idx and g.weight >= min_weight for g in v.groups)}


def head_frame(human, pts):
    body = group_members(human, "body")
    top = max(pts[i].z for i in body)
    front = min(pts[i].y for i in body if abs(pts[i].x) < 0.02 and pts[i].z > top - 0.12)
    ears = [pts[i] for i in group_members(human, "ears")]
    return top, front, ears


# ---------------------------------------------------------------- outfit
def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (a + ab * t - p).length


def bone_points(rig, name):
    pb = rig.pose.bones[name]
    return rig.matrix_world @ pb.head, rig.matrix_world @ pb.tail


BLUE = (0.2, 0.36, 0.66)


def fabric_material(name):
    """Baby-blue ribbed knit with a white lace band driven by a 'lace' attribute."""
    m = principled(name, BLUE, rough=0.75, **{"Sheen Weight": 0.3})
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    coord = nt.nodes.new("ShaderNodeTexCoord")
    wave = nt.nodes.new("ShaderNodeTexWave")          # vertical ribs
    wave.bands_direction = "X"
    wave.inputs["Scale"].default_value = 180.0
    nt.links.new(coord.outputs["Object"], wave.inputs["Vector"])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.25
    nt.links.new(wave.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    lace = nt.nodes.new("ShaderNodeAttribute")
    lace.attribute_name = "lace"
    vor = nt.nodes.new("ShaderNodeTexVoronoi")        # floral-ish openwork
    vor.inputs["Scale"].default_value = 260.0
    nt.links.new(coord.outputs["Object"], vor.inputs["Vector"])
    holes = nt.nodes.new("ShaderNodeMapRange")
    holes.inputs["From Min"].default_value = 0.15
    holes.inputs["From Max"].default_value = 0.45
    holes.inputs["To Min"].default_value = 0.55
    nt.links.new(vor.outputs["Distance"], holes.inputs["Value"])
    white = nt.nodes.new("ShaderNodeMix")
    white.data_type = "RGBA"
    white.inputs["A"].default_value = (*BLUE, 1)
    nt.links.new(holes.outputs["Result"], white.inputs["B"])  # grey-white lace pattern
    nt.links.new(lace.outputs["Fac"], white.inputs["Factor"])
    nt.links.new(white.outputs["Result"], bsdf.inputs["Base Color"])
    return m


def cut_garment(human, pts, name, keep, offset, lace_width=0.013):
    """Copy the posed skin faces whose vertices pass `keep`, then puff them outward."""
    import bmesh
    hidden = group_members(human, "HelperGeometry", 0.01) | group_members(human, "JointCubes", 0.01)
    bm = bmesh.new()
    bm.from_mesh(human.data)
    bm.verts.ensure_lookup_table()
    for v in bm.verts:
        v.co = pts[v.index]
    bm.normal_update()
    kill = [v for v in bm.verts if v.index in hidden or not keep(v.index, pts[v.index])]
    bmesh.ops.delete(bm, geom=kill, context="VERTS")
    # drop little islands/fringes: faces must have all verts kept (done) and >=2 linked faces
    loose = [v for v in bm.verts if len(v.link_faces) < 2]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * offset(v.co)
    # lace: geodesic distance from open edges (hems, neckline, waistband)
    import heapq
    dist = {v: (0.0 if v.is_boundary else 1e9) for v in bm.verts}
    heap = [(0.0, i, v) for i, v in enumerate(bm.verts) if v.is_boundary]
    heapq.heapify(heap)
    while heap:
        d, _, v = heapq.heappop(heap)
        if d > dist[v] or d > lace_width * 2:
            continue
        for e in v.link_edges:
            w = e.other_vert(v)
            nd = d + e.calc_length()
            if nd < dist[w]:
                dist[w] = nd
                heapq.heappush(heap, (nd, id(w), w))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    attr = me.attributes.new("lace", "FLOAT", "POINT")
    for v in bm.verts:
        attr.data[v.index].value = 1.0 if dist[v] < lace_width else 0.0
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    for p in me.polygons:
        p.use_smooth = True
    sol = ob.modifiers.new("Thickness", "SOLIDIFY")
    sol.thickness = 0.0025
    sol.offset = 1.0
    sub = ob.modifiers.new("Subdiv", "SUBSURF")
    sub.levels = sub.render_levels = 1
    return ob


def add_outfit(human, rig, pts):
    nip = [pts[i] for i in group_members(human, "nipple")]
    bust_z = sum(p.z for p in nip) / len(nip)
    arm_segs = []
    for s in ("l", "r"):
        for b in ("upperarm", "lowerarm", "hand"):
            arm_segs.append(bone_points(rig, f"{b}_{s}"))
        for f in ("index", "middle", "ring", "pinky", "thumb"):
            arm_segs.append((bone_points(rig, f"{f}_01_{s}")[0], bone_points(rig, f"{f}_03_{s}")[1]))
    arm_rad = [0.07, 0.055, 0.05] + [0.03] * 5
    arm_rad = arm_rad * 2

    def is_arm(p):
        return any(seg_dist(p, a, b) < r for (a, b), r in zip(arm_segs, arm_rad))

    hem_z = bust_z - 0.155
    waist_z = bust_z - 0.255

    def top_keep(i, p):
        if p.z < hem_z or is_arm(p):
            return False
        # sweetheart neckline in front, straight across under the shoulder blades behind
        front = p.y < 0.0
        line = bust_z + (0.055 + 0.02 * min(abs(p.x) / 0.09, 1.0) - 0.035 * math.exp(-(p.x / 0.03) ** 2)
                         if front else 0.09)
        return p.z < line

    top = cut_garment(human, pts, "Cami", top_keep, lambda co: 0.006)
    top.data.materials.append(fabric_material("CamiFabric"))

    knee_z = {s: bone_points(rig, f"calf_{s}")[0].z for s in ("l", "r")}
    ankle = {s: bone_points(rig, f"foot_{s}")[0] for s in ("l", "r")}
    knee = {s: bone_points(rig, f"calf_{s}")[0] for s in ("l", "r")}
    ankle_z = min(a.z for a in ankle.values()) + 0.03

    def pants_keep(i, p):
        return ankle_z < p.z < waist_z and not is_arm(p)

    def flare(co):
        s = "l" if co.x > 0 else "r"
        kz = knee_z[s]
        if co.z > kz:
            return 0.007
        t = (kz - co.z) / (kz - ankle_z)
        return 0.007 + 0.05 * t * t

    pants = cut_garment(human, pts, "Pants", pants_keep, flare)
    extend_hems(pants, ankle, 0.012, 0.085)
    pants.data.materials.append(fabric_material("PantsFabric"))
    add_straps(top, human, pts, bust_z)


def extend_hems(ob, ankle, floor_z, radius):
    """Extrude the bottom openings of the pant legs down to the floor as a flare."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    low = [e for e in bm.edges if e.is_boundary and all(v.co.z < 0.2 for v in e.verts)]
    ret = bmesh.ops.extrude_edge_only(bm, edges=low)
    new_verts = [g for g in ret["geom"] if isinstance(g, bmesh.types.BMVert)]
    for v in new_verts:
        s = "l" if v.co.x > 0 else "r"
        c = Vector((ankle[s].x, ankle[s].y, 0))
        d = Vector((v.co.x, v.co.y, 0)) - c
        d = d.normalized() * radius if d.length else d
        v.co = Vector((c.x + d.x, c.y + d.y, floor_z))
    lace = bm.verts.layers.float.get("lace")
    if lace:
        for v in new_verts:
            v[lace] = 0.0
    bm.to_mesh(ob.data)
    bm.free()


def add_straps(top, human, pts, bust_z):
    fabric = top.data.materials[0]
    body = group_members(human, "body")
    tv = [top.matrix_world @ v.co for v in top.data.vertices]
    for sx in (1, -1):
        def nearest(y_sign):
            cand = [p for p in tv if 0.06 < p.x * sx < 0.11 and (p.y - mid_y) * y_sign > 0.02]
            return max(cand, key=lambda p: p.z)
        mid_y = sum(p.y for p in tv) / len(tv)
        f, b = nearest(-1), nearest(1)
        # shoulder apex: highest body point near the strap's x
        sh = max((pts[i] for i in body if 0.085 < pts[i].x * sx < 0.115
                  and abs(pts[i].y - (f.y + b.y) / 2) < 0.04 and pts[i].z < bust_z + 0.25),
                 key=lambda p: p.z)
        cu = bpy.data.curves.new("strap", "CURVE")
        cu.dimensions = "3D"
        cu.bevel_depth = 0.0028
        cu.resolution_u = 16
        sp = cu.splines.new("BEZIER")
        sp.bezier_points.add(2)
        for bp, c in zip(sp.bezier_points, (f, sh + Vector((0, 0, 0.006)), b)):
            bp.co = c
            bp.handle_left_type = bp.handle_right_type = "AUTO"
        ob = bpy.data.objects.new("Strap", cu)
        ob.data.materials.append(fabric)
        bpy.context.collection.objects.link(ob)


def add_horns(top, front):
    mat = principled("Horn", (0.13, 0.015, 0.02), rough=0.35, **{"Coat Weight": 0.4})
    nt = mat.node_tree
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.wave_type = "RINGS"
    wave.inputs["Scale"].default_value = 18.0
    wave.inputs["Distortion"].default_value = 2.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.6
    nt.links.new(wave.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], nt.nodes["Principled BSDF"].inputs["Normal"])
    horns = []
    for sx in (1, -1):
        cu = bpy.data.curves.new("horn", "CURVE")
        cu.dimensions = "3D"
        cu.bevel_depth = 0.021
        cu.bevel_resolution = 6
        cu.resolution_u = 24
        sp = cu.splines.new("BEZIER")
        z0, y0 = top - 0.045, front + 0.035
        ctrl = [(0.032, y0, z0), (0.05, y0 + 0.01, z0 + 0.045),
                (0.085, y0 + 0.055, z0 + 0.075), (0.125, y0 + 0.13, z0 + 0.07)]
        radii = [1.0, 0.72, 0.42, 0.04]
        sp.bezier_points.add(len(ctrl) - 1)
        for bp, c, r in zip(sp.bezier_points, ctrl, radii):
            bp.co = (c[0] * sx, c[1], c[2])
            bp.handle_left_type = bp.handle_right_type = "AUTO"
            bp.radius = r
        cu.use_fill_caps = True
        ob = bpy.data.objects.new("Horn", cu)
        ob.data.materials.append(mat)
        bpy.context.collection.objects.link(ob)
        horns.append(ob)
    return horns


def add_earrings(ears):
    gold = principled("Gold", (1.0, 0.72, 0.3), rough=0.18, Metallic=1.0)
    for sx in (1, -1):
        side = [p for p in ears if p.x * sx > 0]
        lobe = min(side, key=lambda p: p.z)
        bpy.ops.mesh.primitive_torus_add(major_radius=0.016, minor_radius=0.0018,
                                         location=(lobe.x + 0.004 * sx, lobe.y + 0.004, lobe.z - 0.016),
                                         rotation=(0, math.radians(90), 0))
        bpy.context.object.data.materials.append(gold)
        bpy.ops.object.shade_smooth()


# ---------------------------------------------------------------- studio
def studio():
    scn = bpy.context.scene
    world = bpy.data.worlds.new("Studio")
    scn.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (1, 1, 1, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.25

    # seamless white cyclorama: floor sweeping up into a back wall
    bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 1.5, 0))
    cyc = bpy.context.object
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.subdivide(number_cuts=40)
    bpy.ops.object.mode_set(mode="OBJECT")
    for v in cyc.data.vertices:
        y = v.co.y + 1.5
        if y > 2.6:  # bend up well behind the character
            t = y - 2.6
            v.co.z = t * t * 0.9 if t < 1.2 else 1.296 + (t - 1.2) * 2.2
    bpy.ops.object.shade_smooth()
    cyc.data.materials.append(principled("Cyc", (0.9, 0.9, 0.9), rough=0.9,
                                          **{"Emission Color": (1, 1, 1, 1), "Emission Strength": 0.35}))

    def area(name, loc, size, energy, color=(1, 1, 1)):
        d = bpy.data.lights.new(name, "AREA")
        d.size = size
        d.energy = energy
        d.color = color
        o = bpy.data.objects.new(name, d)
        o.location = loc
        bpy.context.collection.objects.link(o)
        c = o.constraints.new("TRACK_TO")
        tgt = bpy.data.objects.get("LightTarget") or bpy.data.objects.new("LightTarget", None)
        if tgt.name not in bpy.context.collection.objects:
            bpy.context.collection.objects.link(tgt)
            tgt.location = (0, 0, 1.1)
        c.target = tgt
    area("Key", (-1.8, -2.4, 2.6), 2.5, 220, (1, 0.97, 0.93))
    area("Fill", (2.2, -2.2, 1.6), 3.0, 70, (0.93, 0.96, 1))
    area("Rim", (0.7, 1.3, 2.5), 1.0, 120)
    area("Top", (0, -0.6, 3.6), 3.0, 50)


def camera(name, loc, target, lens):
    cam = bpy.data.cameras.new(name)
    cam.lens = lens
    o = bpy.data.objects.new(name, cam)
    o.location = loc
    bpy.context.collection.objects.link(o)
    t = bpy.data.objects.new(name + "Target", None)
    t.location = target
    bpy.context.collection.objects.link(t)
    c = o.constraints.new("TRACK_TO")
    c.target = t
    return o


def render(cam, path, res, samples):
    scn = bpy.context.scene
    scn.camera = cam
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = samples
    scn.cycles.use_denoising = True
    scn.render.resolution_x, scn.render.resolution_y = res
    scn.render.resolution_percentage = 100
    scn.view_settings.view_transform = "AgX"
    scn.view_settings.look = "AgX - Medium High Contrast"
    scn.view_settings.exposure = -0.4
    scn.render.image_settings.file_format = "PNG"
    # soft bloom around the glowing eyes
    scn.use_nodes = True
    nt = scn.node_tree
    nt.nodes.clear()
    rl = nt.nodes.new("CompositorNodeRLayers")
    glare = nt.nodes.new("CompositorNodeGlare")
    glare.glare_type = "FOG_GLOW"
    glare.quality = "HIGH"
    glare.threshold = 1.5
    glare.size = 7
    out = nt.nodes.new("CompositorNodeComposite")
    nt.links.new(rl.outputs["Image"], glare.inputs["Image"])
    nt.links.new(glare.outputs["Image"], out.inputs["Image"])
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("RENDERED", path)


if __name__ == "__main__":
    human, rig = build_human()
    add_assets(human)
    assets = {}
    for o in bpy.data.objects:
        for key, tag in (("eyes", "high-poly"), ("brows", "eyebrow"), ("lashes", "eyelashes"), ("hair", "long01")):
            if tag in o.name:
                assets[key] = o
    pose(rig)
    pts = posed_positions(human)
    top, front, ears = head_frame(human, pts)
    STREAK_X = (0.0, 0.035)
    style_materials(human, assets)
    add_horns(top, front)
    add_earrings(ears)
    add_outfit(human, rig, pts)
    studio()
    face_z = top - 0.13
    cams = {
        "full": (camera("CamFull", (0, -5.4, 0.95), (0, 0, 0.9), 85), (1024, 1536)),
        "face": (camera("CamFace", (0.05, -1.25, face_z + 0.02), (0, 0, face_z), 85), (1024, 1024)),
    }
    os.makedirs(args.out, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.out, "character.blend"))
    for name, (cam, res) in cams.items():
        if args.view in (name, "both"):
            if args.preview:
                res = (res[0] // 3, res[1] // 3)
            render(cam, os.path.join(args.out, f"{name}{'_preview' if args.preview else ''}.png"),
                   res, 24 if args.preview else 160)
