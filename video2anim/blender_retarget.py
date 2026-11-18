"""Blender (headless): drive a rigged character from joints_pN.npz and bake the animation.

blender -b -P blender_retarget.py -- --character hero.fbx --joints joints_p0.npz \
        --map hero.json --out scene.blend

Bone map JSON (made once per character skeleton):
{
  "axes": "cam",                       # "cam" = SAM camera coords (x right, y down, z fwd); "zup" = already Blender
  "root": {"bone": "pelvis", "joint": 0},
  "bones": {
    "spine_01":  [0, 3],               # [head_joint, tail_joint]  -> bone aims at tail joint
    "thigh_l":   [1, 4],
    "pelvis":    [0, 3, 2, "TRACK_X"]  # optional 3rd/4th: side joint + bone axis that should point at it (fixes twist)
  }
}
Method: joint empties + Damped Track (aim) + optional Locked Track (twist) + Copy Location on root,
then visual-bake to keyframes and strip the constraints. Fast and robust; finger detail is not captured.
"""
import bpy, sys, json, argparse
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--character", required=True); ap.add_argument("--joints", required=True)
ap.add_argument("--map", required=True); ap.add_argument("--out", required=True)
ap.add_argument("--smooth", type=int, default=3, help="moving-average window to calm jitter (frames)")
a = ap.parse_args(argv)

# ---------- load character ----------
ext = a.character.lower().rsplit(".", 1)[-1]
if ext == "blend":
    bpy.ops.wm.open_mainfile(filepath=a.character)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if ext == "fbx": bpy.ops.import_scene.fbx(filepath=a.character, automatic_bone_orientation=True)
    elif ext in ("glb", "gltf"): bpy.ops.import_scene.gltf(filepath=a.character)
    else: sys.exit(f"unsupported character format: {ext}")
arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
if arm is None: sys.exit("no armature found in character file")

M = json.load(open(a.map))
d = np.load(a.joints)
J = d["joints"].astype(np.float64)               # (T, N, 3)
fps = int(round(float(d["fps"]))) if "fps" in d else 30
T, N, _ = J.shape

# ---------- axes / smoothing / scale / placement ----------
if M.get("axes", "cam") == "cam":                 # camera coords -> Blender Z-up
    J = np.stack([J[..., 0], J[..., 2], -J[..., 1]], -1)
if a.smooth > 1:
    k = np.ones(a.smooth) / a.smooth
    pad = a.smooth // 2
    Jp = np.pad(J, ((pad, pad), (0, 0), (0, 0)), mode="edge")
    J = np.stack([np.apply_along_axis(lambda s: np.convolve(s, k, "valid"), 0, Jp[..., c]) for c in range(3)], -1)[:T]

bpy.context.view_layer.update()
mw = arm.matrix_world
zs = [ (mw @ b.head_local).z for b in arm.data.bones ] + [ (mw @ b.tail_local).z for b in arm.data.bones ]
char_h = max(zs) - min(zs)
mocap_h = np.nanmax(J[0, :, 2]) - np.nanmin(J[0, :, 2])
scale = char_h / mocap_h if mocap_h > 1e-6 else 1.0
root_j = M["root"]["joint"]
rb = arm.data.bones[M["root"]["bone"]]
root_rest = np.array(mw @ rb.head_local)
J = (J - J[0, root_j]) * scale + root_rest      # start where the character stands, keep travel

# ---------- joint empties, keyed fast ----------
scene = bpy.context.scene
scene.frame_start, scene.frame_end = 1, T
scene.render.fps = fps
col = bpy.data.collections.new("mocap_joints"); scene.collection.children.link(col)
used = {root_j}
for spec in M["bones"].values():
    used.update(j for j in spec[:3] if isinstance(j, int))
empties = {}
for j in sorted(used):
    e = bpy.data.objects.new(f"J{j:03d}", None); col.objects.link(e); e.empty_display_size = 0.03
    e.animation_data_create(); act = bpy.data.actions.new(f"J{j:03d}_act"); e.animation_data.action = act
    for c in range(3):
        fc = act.fcurves.new("location", index=c)
        fc.keyframe_points.add(T)
        co = np.empty(T * 2); co[0::2] = np.arange(1, T + 1); co[1::2] = J[:, j, c]
        fc.keyframe_points.foreach_set("co", co)
        fc.update()
    empties[j] = e

# ---------- constraints ----------
pb = arm.pose.bones
rc = pb[M["root"]["bone"]].constraints.new("COPY_LOCATION"); rc.target = empties[root_j]
for bone, spec in M["bones"].items():
    if bone not in pb: print(f"WARN bone missing: {bone}"); continue
    dt = pb[bone].constraints.new("DAMPED_TRACK"); dt.target = empties[spec[1]]; dt.track_axis = "TRACK_Y"
    if len(spec) >= 3:
        lt = pb[bone].constraints.new("LOCKED_TRACK"); lt.target = empties[spec[2]]
        lt.lock_axis = "LOCK_Y"; lt.track_axis = spec[3] if len(spec) > 3 else "TRACK_X"

# ---------- bake ----------
bpy.ops.object.select_all(action="DESELECT")
arm.select_set(True); bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="POSE"); bpy.ops.pose.select_all(action="SELECT")
bpy.ops.nla.bake(frame_start=1, frame_end=T, only_selected=True, visual_keying=True,
                 clear_constraints=True, use_current_action=True, bake_types={"POSE"})
bpy.ops.object.mode_set(mode="OBJECT")
for e in empties.values(): bpy.data.objects.remove(e)
bpy.data.collections.remove(col)
bpy.ops.wm.save_as_mainfile(filepath=a.out)
print(f"baked {T} frames @ {fps}fps, scale {scale:.3f} -> {a.out}")
