#!/usr/bin/env python3
"""Make a data-only copy of SAM-Body4D's scripts/offline_app.py.

  python3 patch_offline_app.py /path/to/sam-body4d
  -> writes scripts/offline_app_data.py

Changes versus the original:
  1. NO pictures of the result are written: the rendered_frames/, rendered_frames_individual/ overlays and the 4d_*.mp4 are removed.
  2. Joint data IS written: <output_dir>/joints/<frame>.npz, one file per frame holding every tracked person.
  3. Per-frame .ply meshes are off by default (SAVE_PLY=1 turns them back on).
  4. The tool's own working copies of the video frames (images/, masks/, completion/) are deleted when the run ends (KEEP_FRAMES=1 keeps them).
The patch fails loudly if the upstream file no longer looks the way it did on 2026-11-11.
"""
import re, sys, os
repo = sys.argv[1]; src = os.path.join(repo, "scripts", "offline_app.py"); s = open(src).read(); n = 0
def sub(pattern, repl, count=1, flags=re.S):
    global s, n
    s2, k = re.subn(pattern, repl, s, count=count, flags=flags)
    if k < 1: sys.exit("PATCH FAILED: pattern not found:\n  " + pattern[:90])
    s = s2; n += k

HELPER = '''
# ---- added by patch_offline_app.py: data-only output ----
import shutil as _shutil
_JOINT_KEYS = ("pred_joint_coords", "pred_global_rots", "mhr_model_params", "shape_params", "scale_params", "pred_cam_t",
               "focal_length", "pred_keypoints_3d", "pred_keypoints_2d", "global_rot", "body_pose_params", "hand_pose_params", "bbox")
def _np(x):
    if hasattr(x, "detach"): x = x.detach().cpu().numpy()
    return np.asarray(x)
def save_joint_data(out_dir, image_path, mask_output, id_current):
    """One .npz per frame. Arrays are stacked over the people present in that frame; `ids` says who each row is."""
    os.makedirs(os.path.join(out_dir, "joints"), exist_ok=True)
    name = os.path.basename(image_path)[:-4]
    data = {"ids": np.asarray(list(id_current) if id_current is not None else [], dtype=np.int64)}
    if mask_output:
        for k in _JOINT_KEYS:
            if all(k in p for p in mask_output):
                try: data[k] = np.stack([_np(p[k]) for p in mask_output])
                except Exception as e: print(f"[joints] {name}: could not stack {k}: {e}")
        data["keys_available"] = np.asarray(sorted(mask_output[0].keys()))
    np.savez_compressed(os.path.join(out_dir, "joints", name + ".npz"), **data)
# ---- end of added block ----
'''
# helper goes right before the main class
sub(r"\nclass OfflineApp:", lambda m: HELPER + "\nclass OfflineApp:")
# 1+2: replace the picture-writing block with the joint-data save
sub(r"( *)img = cv2\.imread\(image_path\)\n.*?(?=\1# save mesh for individual person)",
    lambda m: m.group(1) + "save_joint_data(self.OUTPUT_DIR, image_path, mask_output, id_current)\n")
# 3: meshes only on request
sub(r"( *)save_mesh_results\(", lambda m: m.group(1) + 'if os.environ.get("SAVE_PLY", "0") == "1": save_mesh_results(')
# no overlay folders
sub(r' *os\.makedirs\(f"\{self\.OUTPUT_DIR\}/rendered_frames", exist_ok=True\)\n', "")
sub(r' *os\.makedirs\(f"\{self\.OUTPUT_DIR\}/rendered_frames_individual/\{obj_id\}", exist_ok=True\)\n', "")
# 1: no result video; 4: clean up working frames
sub(r'( *)out_4d_path = os\.path\.join\(self\.OUTPUT_DIR, f"4d_\{time\.time\(\):\.0f\}\.mp4"\)\n *jpg_folder_to_mp4\([^\n]*\)\n',
    lambda m: (m.group(1) + 'out_4d_path = os.path.join(self.OUTPUT_DIR, "joints")\n'
               + m.group(1) + 'if os.environ.get("KEEP_FRAMES", "0") != "1":\n'
               + m.group(1) + '    for _d in ("images", "masks", "completion"):\n'
               + m.group(1) + '        _shutil.rmtree(os.path.join(self.OUTPUT_DIR, _d), ignore_errors=True)\n'))
for bad in ("rendered_frames", "jpg_folder_to_mp4(", "cv2.imwrite(\n                    f\"{self.OUTPUT_DIR}/rendered"):
    if bad in s.split("class OfflineApp:")[1]: sys.exit("PATCH FAILED: still writes pictures: " + bad)
dst = os.path.join(repo, "scripts", "offline_app_data.py"); open(dst, "w").write(s)
print(f"OK: {n} edits -> {dst}")
