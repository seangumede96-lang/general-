"""Blender (headless): fast low-res render of the baked scene.

blender -b scene.blend -P blender_render.py -- --out frames/ --engine eevee [--test 3]

Look = "Void": pure white infinite world, no floor, soft even light from all sides,
wide lens close to the character on a slow orbit. All settings come from env (config.env).
--engine cycles is the fallback when the pod has no OpenGL/EGL for Eevee.
"""
import bpy, sys, os, math, argparse
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True); ap.add_argument("--engine", default="eevee")
ap.add_argument("--test", type=int, default=0, help="render only N frames (speed test)")
a = ap.parse_args(argv)
E = lambda k, d: type(d)(os.environ.get(k, d))

sc = bpy.context.scene
r = sc.render
r.resolution_x, r.resolution_y, r.resolution_percentage = E("RENDER_W", 540), E("RENDER_H", 960), 100
r.fps = E("FPS", 30)
r.image_settings.file_format = "PNG"; r.image_settings.color_mode = "RGB"; r.image_settings.compression = 15
r.filepath = os.path.join(os.path.abspath(a.out), "f_")
r.use_persistent_data = True
if a.test: sc.frame_end = sc.frame_start + a.test - 1

# ---------- engine ----------
if a.engine == "eevee":
    items = [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    r.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in items else "BLENDER_EEVEE"
    ee = sc.eevee
    ee.taa_render_samples = E("EEVEE_SAMPLES", 8)
    for attr, val in (("use_raytracing", False), ("use_gtao", False), ("use_bloom", False),
                      ("use_ssr", False), ("use_motion_blur", False), ("use_volumetric_shadows", False)):
        if hasattr(ee, attr): setattr(ee, attr, val)
    if hasattr(ee, "shadow_ray_count"): ee.shadow_ray_count = 1
    if hasattr(ee, "shadow_step_count"): ee.shadow_step_count = 1
else:
    r.engine = "CYCLES"
    cy = sc.cycles
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for dev in ("OPTIX", "CUDA"):
        try: prefs.compute_device_type = dev; prefs.get_devices(); break
        except Exception: pass
    for d in prefs.devices: d.use = d.type != "CPU"
    cy.device = "GPU"; cy.samples = 16; cy.use_denoising = True
    cy.denoiser = "OPTIX" if prefs.compute_device_type == "OPTIX" else "OPENIMAGEDENOISE"
    cy.max_bounces = 3; cy.use_adaptive_sampling = True

# ---------- void world + light ----------
if E("VOID_WHITE", 1):
    for o in [o for o in sc.objects if o.type in ("LIGHT",) or o.name.lower() in ("floor", "ground", "plane")]:
        bpy.data.objects.remove(o)
    w = sc.world or bpy.data.worlds.new("Void"); sc.world = w; w.use_nodes = True
    bg = w.node_tree.nodes.get("Background") or w.node_tree.nodes.new("ShaderNodeBackground")
    bg.inputs[0].default_value = (1, 1, 1, 1); bg.inputs[1].default_value = 1.0
    r.film_transparent = False
    sc.view_settings.view_transform = "Standard"     # keeps white truly white

# ---------- camera: wide lens, slow orbit around the character ----------
arm = next((o for o in sc.objects if o.type == "ARMATURE"), None)
root = bpy.data.objects.get("MannequinRoot")              # mannequin mode
if sc.camera is None:
    bpy.context.view_layer.update()
    target = arm.matrix_world.translation.copy() if arm else Vector((0, 0, 1))
    height = max((arm.matrix_world @ b.tail_local).z for b in arm.data.bones) if arm else float(sc.get("v2a_height", 1.8))
    target.z = height * 0.55
    pivot = bpy.data.objects.new("CamPivot", None); sc.collection.objects.link(pivot); pivot.location = target
    if arm:   # follow the character's travel
        c = pivot.constraints.new("COPY_LOCATION"); c.target = arm; c.subtarget = arm.pose.bones[0].name; c.use_z = False
    elif root:
        c = pivot.constraints.new("COPY_LOCATION"); c.target = root; c.use_z = False
    cd = bpy.data.cameras.new("Cam"); cd.lens = E("LENS_MM", 16); cd.clip_start = 0.05
    cam = bpy.data.objects.new("Cam", cd); sc.collection.objects.link(cam); cam.parent = pivot
    cam.location = (0, -height * 0.95, 0)          # close: wide lens fills frame
    tc = cam.constraints.new("TRACK_TO"); tc.target = pivot; tc.track_axis = "TRACK_NEGATIVE_Z"; tc.up_axis = "UP_Y"
    sc.camera = cam
    orbit = math.radians(E("ORBIT_DEGREES", 90))
    pivot.rotation_euler = (0, 0, 0); pivot.keyframe_insert("rotation_euler", index=2, frame=sc.frame_start)
    pivot.rotation_euler = (0, 0, orbit); pivot.keyframe_insert("rotation_euler", index=2, frame=sc.frame_end)
    for fc in pivot.animation_data.action.fcurves:
        for k in fc.keyframe_points: k.interpolation = "LINEAR"

os.makedirs(a.out, exist_ok=True)
bpy.ops.render.render(animation=True)
print("RENDER_DONE", r.engine)
