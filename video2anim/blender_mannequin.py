"""Blender (headless): build a plain mannequin straight from the mocap joints — no 3D character,
no bone map needed. The AI style step later turns it into the character from your reference image.

blender -b -P blender_mannequin.py -- --joints joints_p0.npz --out scene.blend

How: joints become keyed empties. Which joints are "connected" is worked out from the motion
itself — a real bone keeps the same length all clip long — so it works with any joint layout.
Capsules (Stretch To) join connected joints, spheres sit on the joints.
"""
import bpy, sys, argparse
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--joints", required=True); ap.add_argument("--out", required=True)
ap.add_argument("--height", type=float, default=1.75); ap.add_argument("--smooth", type=int, default=3)
ap.add_argument("--axes", default="cam")
a = ap.parse_args(argv)

d = np.load(a.joints)
J = d["joints"].astype(np.float64)
fps = int(round(float(d["fps"]))) if "fps" in d else 30
T, N, _ = J.shape
if a.axes == "cam":
    J = np.stack([J[..., 0], J[..., 2], -J[..., 1]], -1)
if a.smooth > 1:
    k = np.ones(a.smooth) / a.smooth; pad = a.smooth // 2
    Jp = np.pad(J, ((pad, pad), (0, 0), (0, 0)), mode="edge")
    J = np.stack([np.apply_along_axis(lambda s: np.convolve(s, k, "valid"), 0, Jp[..., c]) for c in range(3)], -1)[:T]

# scale to a human height, start centred at the origin, feet near z=0
h0 = np.nanmax(J[0, :, 2]) - np.nanmin(J[0, :, 2])
J *= a.height / h0 if h0 > 1e-6 else 1.0
c0 = np.nanmean(J[0], 0); J[..., 0] -= c0[0]; J[..., 1] -= c0[1]; J[..., 2] -= np.nanmin(J[0, :, 2])

# ---- find the skeleton: minimum spanning tree over "rigid-looking" joint pairs ----
diff = J[:, :, None, :] - J[:, None, :, :]
dist = np.linalg.norm(diff, axis=-1)                       # (T,N,N)
mean, std = np.nanmean(dist, 0), np.nanstd(dist, 0)
cost = std + 0.08 * mean                                    # constant length + short = bone
iu = np.triu_indices(N, 1)
order = np.argsort(cost[iu])
parent = list(range(N))
def find(x):
    while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
    return x
edges = []
for o in order:
    i, j = iu[0][o], iu[1][o]
    ri, rj = find(i), find(j)
    if ri != rj: parent[ri] = rj; edges.append((i, j, mean[i, j]))
    if len(edges) == N - 1: break

# ---- scene ----
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.frame_start, sc.frame_end, sc.render.fps = 1, T, fps
sc["v2a_height"] = a.height
col = bpy.data.collections.new("Mannequin"); sc.collection.children.link(col)

def keyed_empty(name, xyz):
    e = bpy.data.objects.new(name, None); col.objects.link(e); e.empty_display_size = 0.02
    e.animation_data_create(); act = bpy.data.actions.new(name + "_act"); e.animation_data.action = act
    for c in range(3):
        fc = act.fcurves.new("location", index=c); fc.keyframe_points.add(T)
        co = np.empty(T * 2); co[0::2] = np.arange(1, T + 1); co[1::2] = xyz[:, c]
        fc.keyframe_points.foreach_set("co", co); fc.update()
    return e

E = [keyed_empty(f"J{j:03d}", J[:, j]) for j in range(N)]
keyed_empty("MannequinRoot", np.nanmean(J, 1))              # camera follows this

mat = bpy.data.materials.new("MannequinGrey"); mat.use_nodes = True
bsdf = mat.node_tree.nodes.get("Principled BSDF")
bsdf.inputs["Base Color"].default_value = (0.62, 0.64, 0.68, 1); bsdf.inputs["Roughness"].default_value = 0.55

# unit capsule along +Y (0..1) and a unit sphere, shared by all parts
bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=1, depth=1, location=(0, 0.5, 0), rotation=(1.5708, 0, 0))
cyl = bpy.context.object; bpy.ops.object.transform_apply(location=True, rotation=True); cyl_mesh = cyl.data
bpy.data.objects.remove(cyl); cyl_mesh.materials.append(mat)
bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=1)
sph = bpy.context.object; sph_mesh = sph.data; bpy.data.objects.remove(sph); sph_mesh.materials.append(mat)
for m in (cyl_mesh, sph_mesh):
    for p in m.polygons: p.use_smooth = True

joint_r = np.zeros(N)
for i, j, L in edges:
    r = float(np.clip(L * 0.17, 0.012, 0.065))
    joint_r[i] = max(joint_r[i], r); joint_r[j] = max(joint_r[j], r)
    o = bpy.data.objects.new(f"Limb_{i}_{j}", cyl_mesh); col.objects.link(o)
    o.scale = (r, 1, r)
    c = o.constraints.new("COPY_LOCATION"); c.target = E[i]
    s = o.constraints.new("STRETCH_TO"); s.target = E[j]; s.rest_length = 1.0; s.volume = "NO_VOLUME"; s.keep_axis = "PLANE_X"
for j in range(N):
    if joint_r[j] == 0: continue
    o = bpy.data.objects.new(f"Joint_{j}", sph_mesh); col.objects.link(o)
    o.scale = [joint_r[j] * 1.15] * 3
    c = o.constraints.new("COPY_LOCATION"); c.target = E[j]

bpy.ops.wm.save_as_mainfile(filepath=a.out)
print(f"mannequin: {N} joints, {len(edges)} limbs, {T} frames @ {fps}fps -> {a.out}")
