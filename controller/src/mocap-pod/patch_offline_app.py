#!/usr/bin/env python3
"""Make a data-only copy of SAM-Body4D's scripts/offline_app.py.

  python3 patch_offline_app.py /path/to/sam-body4d
  -> writes scripts/offline_app_data.py

Changes versus the original:
  1. NO pictures of the result are written: the rendered_frames/, rendered_frames_individual/ overlays and the 4d_*.mp4 are removed.
  2. Joint data IS written: <output_dir>/joints/<frame>.npz, one file per frame holding every tracked person.
  3. Per-frame .ply meshes are off by default (SAVE_PLY=1 turns them back on).
  4. The tool's own working copies of the video frames (images/, masks/, completion/) are deleted when the run ends (KEEP_FRAMES=1 keeps them).
  5. People can be marked by hand: with PROMPTS_FILE set, its points (and boxes) seed SAM 3 instead of the automatic
     person detector, on any frame, so performers who are close together or overlapping are tracked separately.
The patch fails loudly if the upstream file no longer looks the way it did at the pinned commit.
(Steps 1-4 as written by the owner's phone session, tested 2026-11-12; step 5 added for the app.)
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

def add_hand_prompts(predictor, video_path, width, height):
    """Seed SAM 3 from the owner's marks: PROMPTS_FILE is JSON
    {"people": [{"id": 1, "name": "Person A", "marks": [{"t": 0.5, "points": [[x, y, 1], ...], "box": [x0, y0, x1, y1]}]}]}
    with x, y relative to the frame (0-1), label 1 = this person, 0 = not this person; t in seconds."""
    import json as _json, cv2 as _cv2
    spec = _json.load(open(os.environ["PROMPTS_FILE"]))
    cap = _cv2.VideoCapture(video_path); fps = cap.get(_cv2.CAP_PROP_FPS) or 30.0; total = int(cap.get(_cv2.CAP_PROP_FRAME_COUNT) or 0); cap.release()
    first = None
    for person in spec["people"]:
        for mark in person["marks"]:
            frame = max(0, min(total - 1 if total else 10**9, int(round(float(mark["t"]) * fps))))
            kw = {}
            pts = [p for p in mark.get("points", []) if len(p) == 3]
            if pts:
                kw["points"] = torch.tensor([[float(p[0]), float(p[1])] for p in pts], dtype=torch.float32)
                kw["labels"] = torch.tensor([int(p[2]) for p in pts], dtype=torch.int32)
            if mark.get("box"):
                kw["box"] = np.array([mark["box"]], dtype=np.float32)
            if not kw: continue
            _, ids, _, _ = predictor.predictor.add_new_points_or_box(
                inference_state=predictor.RUNTIME["inference_state"], frame_idx=frame, obj_id=int(person["id"]), **kw)
            predictor.RUNTIME["out_obj_ids"] = ids
            first = frame if first is None else min(first, frame)
            print(f"[prompts] {person.get('name', person['id'])}: {len(pts)} point(s){' + box' if mark.get('box') else ''} on frame {frame}")
    print(f"[prompts] {len(spec['people'])} people marked by hand; fps {fps:.3f}; frames {total}")
    return first or 0
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
# 5: hand-placed prompts instead of the automatic detector (video input)
sub(r'( *)# human detection on the frame where human FIRST appear\n( *)if os\.path\.isfile\(args\.input_video\) and args\.input_video\.endswith\("\.mp4"\):\n',
    lambda m: (m.group(1) + '# human detection on the frame where human FIRST appear (or the owner\'s own marks)\n'
               + m.group(2) + 'if os.environ.get("PROMPTS_FILE") and os.path.isfile(args.input_video):\n'
               + m.group(2) + '    image = read_frame_at(args.input_video, 0)\n'
               + m.group(2) + '    width, height = image.size\n'
               + m.group(2) + '    inference_state = predictor.predictor.init_state(video_path=args.input_video)\n'
               + m.group(2) + '    predictor.predictor.clear_all_points_in_video(inference_state)\n'
               + m.group(2) + "    predictor.RUNTIME['inference_state'] = inference_state\n"
               + m.group(2) + "    predictor.RUNTIME['out_obj_ids'] = []\n"
               + m.group(2) + '    add_hand_prompts(predictor, args.input_video, width, height)\n'
               + m.group(2) + 'elif os.path.isfile(args.input_video) and args.input_video.endswith(".mp4"):\n'))
for bad in ("rendered_frames", "jpg_folder_to_mp4(", "cv2.imwrite(\n                    f\"{self.OUTPUT_DIR}/rendered"):
    if bad in s.split("class OfflineApp:")[1]: sys.exit("PATCH FAILED: still writes pictures: " + bad)
dst = os.path.join(repo, "scripts", "offline_app_data.py"); open(dst, "w").write(s)
print(f"OK: {n} edits -> {dst}")
