"""Mocap with 4D-Humans, one person at a time, from taps (runs ON a GPU pod; nothing visual is saved).

  python fourdh_track.py --frames DIR --seeds seeds.json --fps 30 --out OUT --sam2-ckpt X.pt

1. SAM 2 follows each tapped person through the clip (the owner taps each person once in the
   portal, on a frame where they are apart). Every tap of one person is also a "not this one" hint
   for the others, so the two masks stay apart when the people overlap.
2. 4D-Humans (HMR 2.0) reads each person's body per frame from a box around their mask, with the
   OTHER people blacked out, so the two bodies can't merge or swap.
3. Output per person: joints_p<N>.npz with joints (T, 44, 3) in camera space (metres; x right, y down,
   z forward, as the render step expects), fps, valid (T,), SMPL rotations, shape and camera; and
   qc.json: numbers only (frames covered, gaps filled, jitter, jumps, how much the people overlap).
The frames folder is the pod's temporary copy of the video; this script never writes any image.
"""
import argparse, glob, json, os, sys, time
# PyTorch 2.6+ loads checkpoints 'weights only' by default and refuses the official 4D-Humans checkpoint
# (it stores its settings as omegaconf objects). It's the project's own published file, so load it fully.
os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")
import numpy as np
import cv2
import torch

ap = argparse.ArgumentParser()
ap.add_argument("--frames", required=True); ap.add_argument("--seeds", required=True)
ap.add_argument("--fps", type=float, default=30); ap.add_argument("--out", required=True)
ap.add_argument("--sam2-ckpt", required=True); ap.add_argument("--sam2-cfg", default="configs/sam2.1/sam2.1_hiera_l.yaml")
ap.add_argument("--batch", type=int, default=32); ap.add_argument("--max-gap", type=int, default=12)
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
log = lambda *m: print("[4dh]", *m, flush=True)

frames = sorted(glob.glob(os.path.join(a.frames, "*.jpg")), key=lambda p: int(os.path.splitext(os.path.basename(p))[0]))
T = len(frames)
H, W = cv2.imread(frames[0]).shape[:2]
seeds = json.load(open(a.seeds))
people = [p for p in seeds["people"] if p]
P = len(people)
if not P: sys.exit("no people were marked")
f0 = int(min(T - 1, max(0, round(float(seeds.get("t", 0)) * a.fps))))
log(f"{T} frames {W}x{H}, {P} people marked on frame {f0}")

# ---------------- 1. SAM 2: one mask per person per frame ----------------
from sam2.build_sam import build_sam2_video_predictor
pred = build_sam2_video_predictor(a.sam2_cfg, a.sam2_ckpt, device="cuda")
masks = [[None] * T for _ in range(P)]  # packed bits per frame, or None when the person isn't visible
t0 = time.time()
with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
    state = pred.init_state(video_path=a.frames, offload_video_to_cpu=True, offload_state_to_cpu=True)
    for k, pts in enumerate(people):
        pos = [[x * W, y * H] for x, y in pts]
        neg = [[x * W, y * H] for j, q in enumerate(people) if j != k for x, y in q]
        box = (seeds.get("boxes") or [None] * P)[k] if k < len(seeds.get("boxes") or []) else None
        extra = {"box": np.array([box[0] * W, box[1] * H, box[2] * W, box[3] * H], np.float32)} if box else {}
        pred.add_new_points_or_box(state, frame_idx=f0, obj_id=k + 1, points=np.array(pos + neg, np.float32),
                                   labels=np.array([1] * len(pos) + [0] * len(neg), np.int32), **extra)
        log(f"person {k + 1}: {len(pos)} taps{' + outline box' if box else ''}")
    for reverse in (False, True):
        for fi, obj_ids, logits in pred.propagate_in_video(state, start_frame_idx=f0, reverse=reverse):
            for j, oid in enumerate(obj_ids):
                m = (logits[j, 0] > 0).cpu().numpy()
                if m.sum() > 50: masks[oid - 1][fi] = np.packbits(m)
        log(f"SAM 2 {'backward' if reverse else 'forward'} done, {time.time() - t0:.0f}s")
del pred, state; torch.cuda.empty_cache()
unpack = lambda b: np.unpackbits(b)[: H * W].reshape(H, W).astype(bool)

# ---------------- 2. 4D-Humans (HMR 2.0) per person ----------------
from hmr2.configs import CACHE_DIR_4DHUMANS
from hmr2.models import download_models, load_hmr2, DEFAULT_CHECKPOINT
from hmr2.datasets.vitdet_dataset import ViTDetDataset
from hmr2.utils import recursive_to
download_models(CACHE_DIR_4DHUMANS)
try:  # belt and braces for PyTorch versions that ignore the variable above
    import omegaconf, typing, collections
    torch.serialization.add_safe_globals([omegaconf.dictconfig.DictConfig, omegaconf.listconfig.ListConfig, omegaconf.base.ContainerMetadata,
                                          omegaconf.base.Metadata, omegaconf.nodes.AnyNode, typing.Any, dict, list, int, collections.defaultdict])
except Exception as e:
    log("note: couldn't pre-allow checkpoint types:", e)
model, cfg = load_hmr2(DEFAULT_CHECKPOINT)
model = model.cuda().eval()
focal = cfg.EXTRA.FOCAL_LENGTH / cfg.MODEL.IMAGE_SIZE * max(W, H)


def cam_crop_to_full(cam, center, size, img_size, f):
    """Crop camera -> full-image camera translation (as 4D-Humans' renderer.cam_crop_to_full)."""
    w, h = img_size[:, 0], img_size[:, 1]
    bs = size * cam[:, 0] + 1e-9
    return torch.stack([2 * (center[:, 0] - w / 2) / bs + cam[:, 1], 2 * (center[:, 1] - h / 2) / bs + cam[:, 2], 2 * f / bs], -1)


J = np.full((P, T, 44, 3), np.nan, np.float32)
GO = np.full((P, T, 1, 3, 3), np.nan, np.float32); BP = np.full((P, T, 23, 3, 3), np.nan, np.float32)
BE = np.full((P, T, 10), np.nan, np.float32); CT = np.full((P, T, 3), np.nan, np.float32)
items, keys = [], []


def flush():
    if not items: return
    batch = recursive_to(torch.utils.data.default_collate(items), "cuda")
    with torch.no_grad(): out = model(batch)
    ct = cam_crop_to_full(out["pred_cam"], batch["box_center"].float(), batch["box_size"].float(), batch["img_size"].float(), focal)
    kp = out["pred_keypoints_3d"].float().cpu().numpy(); ct = ct.float().cpu().numpy()
    sp = {k: v.float().cpu().numpy() for k, v in out["pred_smpl_params"].items()}
    for i, (k, fi) in enumerate(keys):
        J[k, fi] = kp[i] + ct[i][None]; CT[k, fi] = ct[i]
        GO[k, fi] = sp["global_orient"][i]; BP[k, fi] = sp["body_pose"][i]; BE[k, fi] = sp["betas"][i]
    items.clear(); keys.clear()


t0 = time.time()
for fi, path in enumerate(frames):
    img = None
    for k in range(P):
        if masks[k][fi] is None: continue
        if img is None: img = cv2.imread(path); full = [unpack(masks[q][fi]) if masks[q][fi] is not None else None for q in range(P)]
        mk = full[k]; ys, xs = np.nonzero(mk)
        box = np.array([[xs.min(), ys.min(), xs.max(), ys.max()]], np.float32)
        im = img.copy()
        for q in range(P):  # black out the other people (only where they aren't this person)
            if q != k and full[q] is not None: im[full[q] & ~mk] = 0
        ds = ViTDetDataset(cfg, im, box)
        items.append(ds[0]); keys.append((k, fi))
        if len(items) >= a.batch: flush()
    if fi % 100 == 0: log(f"4D-Humans frame {fi}/{T}, {time.time() - t0:.0f}s")
flush()
log(f"4D-Humans done, {time.time() - t0:.0f}s")

# ---------------- 3. gaps, QC (numbers only), save ----------------
qc = {"frames": T, "fps": a.fps, "width": W, "height": H, "seed_frame": f0, "people": []}
boxes = [[None] * T for _ in range(P)]
for k in range(P):
    for fi in range(T):
        if masks[k][fi] is not None:
            ys, xs = np.nonzero(unpack(masks[k][fi])); boxes[k][fi] = (xs.min(), ys.min(), xs.max(), ys.max())
for k in range(P):
    valid = ~np.isnan(J[k, :, 0, 0])
    filled = 0
    idx = np.nonzero(valid)[0]
    # fill short gaps by linear interpolation; longer gaps stay empty (reported)
    for s, e in zip(idx[:-1], idx[1:]):
        if 1 < e - s <= a.max_gap + 1:
            for fi in range(s + 1, e):
                w = (fi - s) / (e - s); J[k, fi] = (1 - w) * J[k, s] + w * J[k, e]; filled += 1
    ok = ~np.isnan(J[k, :, 0, 0])
    centre = np.nanmean(J[k], 1)  # body centre: mean of all joints
    v = np.linalg.norm(np.diff(centre, axis=0), axis=1) * 100  # cm per frame
    acc = np.linalg.norm(np.diff(J[k], 2, axis=0), axis=-1) * 100  # cm/frame^2 per joint
    height = np.nanmedian(np.nanmax(J[k, :, :, 1], 1) - np.nanmin(J[k, :, :, 1], 1)) * 100
    qc["people"].append({
        "person": k, "frames_seen": int(valid.sum()), "gaps_filled": filled, "frames_missing": int((~ok).sum()),
        "body_height_cm_median": round(float(height), 1),
        "centre_speed_cm_per_frame": {"median": round(float(np.nanmedian(v)), 2), "p95": round(float(np.nanpercentile(v, 95)), 2), "max": round(float(np.nanmax(v)), 1)},
        "jumps_over_15cm": int(np.nansum(v > 15)),
        "joint_jitter_cm": {"median": round(float(np.nanmedian(acc)), 2), "p95": round(float(np.nanpercentile(acc, 95)), 2)},
    })
    np.savez(os.path.join(a.out, f"joints_p{k}.npz"), joints=J[k], fps=a.fps, valid=ok, joint_layout="hmr2_openpose44_cam_metres",
             smpl_global_orient=GO[k], smpl_body_pose=BP[k], smpl_betas=BE[k], cam_t=CT[k], focal_px=focal, image_wh=np.array([W, H]))
# how often two people's boxes overlap a lot (where swaps or merges could happen)
if P > 1:
    def iou(b1, b2):
        x1, y1 = max(b1[0], b2[0]), max(b1[1], b2[1]); x2, y2 = min(b1[2], b2[2]), min(b1[3], b2[3])
        i = max(0, x2 - x1) * max(0, y2 - y1); u = (b1[2] - b1[0]) * (b1[3] - b1[1]) + (b2[2] - b2[0]) * (b2[3] - b2[1]) - i
        return i / u if u > 0 else 0
    ious = [iou(boxes[0][f], boxes[1][f]) for f in range(T) if boxes[0][f] is not None and boxes[1][f] is not None]
    qc["box_overlap_p0_p1"] = {"frames_both_seen": len(ious), "median": round(float(np.median(ious)), 3) if ious else None,
                               "frames_over_0.5": int(sum(x > 0.5 for x in ious)), "frames_over_0.8": int(sum(x > 0.8 for x in ious))}
json.dump(qc, open(os.path.join(a.out, "qc.json"), "w"), indent=1)
log("QC", json.dumps(qc))
