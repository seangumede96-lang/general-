"""Turn a motion (BVH made by the app, public/motion.js toBVH) into an FBX with Blender, no screen.

  blender -b --factory-startup -P motion_to_fbx.py -- IN.bvh OUT.fbx [--fps 10] [--mixamo] [--check CHECK.json]

- Skeleton and baked animation; centimetres become metres; Y up, the figure facing -Y in Blender
  and +Z in the file (the usual FBX convention for game engines and Blender alike).
- --mixamo renames the bones to Mixamo names (mixamorig:Hips ...) so Mixamo-style rigs retarget.
- --check writes, for a few frames, where every joint is after a round trip (FBX imported again
  into an empty scene), so the app's tests can compare it with its own numbers.
Works on Blender 4.2 and 5.0 (the phone's Ubuntu has 5.0).
"""
import bpy, sys, json

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
src, dst = argv[0], argv[1]
fps = int(argv[argv.index('--fps') + 1]) if '--fps' in argv else None
mixamo = '--mixamo' in argv
check = argv[argv.index('--check') + 1] if '--check' in argv else None

MIXAMO = {'hips': 'Hips', 'waist': 'Spine', 'chest': 'Spine2', 'neck': 'Neck', 'head': 'Head'}
for s, side in (('L', 'Left'), ('R', 'Right')):
    MIXAMO.update({f'clavicle_{s}': f'{side}Shoulder', f'upperArm_{s}': f'{side}Arm', f'forearm_{s}': f'{side}ForeArm', f'hand_{s}': f'{side}Hand',
                   f'thigh_{s}': f'{side}UpLeg', f'shin_{s}': f'{side}Leg', f'foot_{s}': f'{side}Foot'})


# Ubuntu's Blender 5.0.1 runs on Python 3.14, where these add-on operators lose their settings
# (deferred class annotations: only filepath/axis props register), so passing settings raises
# TypeError and the FBX exporter crashes on missing attributes. Fall back to the add-ons' own
# functions with the same settings when that happens. Works unchanged on a normal Blender.
from bpy_extras.io_utils import axis_conversion
class _Op:  # stands in for the operator the add-on functions report through
    def report(self, kind, msg): print('BLENDER', kind, msg)

def import_bvh(**kw):
    try: return bpy.ops.import_anim.bvh(**kw)
    except (TypeError, RuntimeError, AttributeError):
        from io_anim_bvh import import_bvh as m
        gm = axis_conversion(from_forward=kw.pop('axis_forward', '-Z'), from_up=kw.pop('axis_up', 'Y')).to_4x4()
        return m.load(bpy.context, kw.pop('filepath'), global_matrix=gm, report=lambda kind, msg: print('BLENDER', kind, msg), **kw)

def export_fbx(**kw):
    try: return bpy.ops.export_scene.fbx(**kw)
    except (TypeError, RuntimeError, AttributeError):
        from io_scene_fbx import export_fbx_bin as m
        gm = axis_conversion(to_forward=kw.pop('axis_forward', '-Z'), to_up=kw.pop('axis_up', 'Y')).to_4x4()
        return m.save(_Op(), bpy.context, global_matrix=gm, **kw)

def import_fbx(**kw):
    try: return bpy.ops.import_scene.fbx(**kw)
    except (TypeError, RuntimeError, AttributeError):
        from io_scene_fbx import import_fbx as m
        return m.load(_Op(), bpy.context, **kw)

bpy.ops.wm.read_factory_settings(use_empty=True)
import_bvh(filepath=src, global_scale=0.01, frame_start=1, use_fps_scale=False,
                        update_scene_fps=True, update_scene_duration=True, rotate_mode='NATIVE',
                        axis_forward='-Z', axis_up='Y')
arm = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
arm.name = arm.data.name = 'Character'
if fps:
    bpy.context.scene.render.fps = fps
if mixamo:
    for b in arm.data.bones:
        if b.name in MIXAMO:
            b.name = 'mixamorig:' + MIXAMO[b.name]
scene = bpy.context.scene
# The file's own frames only (an empty scene starts with 250).
act = arm.animation_data.action
scene.frame_start, scene.frame_end = int(act.frame_range[0]), int(act.frame_range[1])
first, last = scene.frame_start, scene.frame_end
print(f'MOTION {len(arm.data.bones)} bones, frames {first}-{last} at {scene.render.fps} fps')

export_fbx(filepath=dst, use_selection=False, object_types={'ARMATURE'}, add_leaf_bones=False,
                         bake_anim=True, bake_anim_use_all_actions=False, bake_anim_use_nla_strips=False,
                         bake_anim_force_startend_keying=True, bake_anim_step=1.0, bake_anim_simplify_factor=0.0,
                         apply_unit_scale=True, apply_scale_options='FBX_SCALE_UNITS', axis_forward='-Z', axis_up='Y',
                         primary_bone_axis='Y', secondary_bone_axis='X', armature_nodetype='NULL')
print('FBX', dst)

if check:
    # Round trip: read the FBX back into an empty scene and record joint positions (centimetres,
    # in the BVH's own axes: x, y up, z) at a few frames.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    import_fbx(filepath=dst, axis_forward='-Z', axis_up='Y', automatic_bone_orientation=False)
    a = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
    act = a.animation_data.action if a.animation_data else None
    lo, hi = (int(act.frame_range[0]), int(act.frame_range[1])) if act else (1, 1)
    out = {'bones': len(a.data.bones), 'frames': [lo, hi], 'fps': bpy.context.scene.render.fps, 'at': {}}
    for fr in sorted({lo, (lo + hi) // 2, hi}):
        bpy.context.scene.frame_set(fr)
        pos = {}
        for pb in a.pose.bones:
            w = a.matrix_world @ pb.head
            pos[pb.name] = [round(w.x * 100, 2), round(w.z * 100, 2), round(-w.y * 100, 2)]
        out['at'][fr] = pos
    json.dump(out, open(check, 'w'))
    print('CHECK', check)
