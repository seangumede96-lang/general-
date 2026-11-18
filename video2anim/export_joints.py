"""Find SAM-Body4D's per-frame 3D joints and save them as joints_p<N>.npz (T, J, 3).

SAM-Body4D's README doesn't document its output layout, so this script searches
for arrays shaped like 3D joints instead of assuming file names.

  --inspect        list every candidate array (key, shape) and exit
  --key NAME       force which array key to use (after inspecting)
"""
import argparse, glob, os, pickle, re, sys
import numpy as np

EXTS = (".npz", ".npy", ".pkl", ".pt", ".pth")
JOINT_HINTS = ("keypoints_3d", "joints_3d", "pred_keypoints_3d", "pred_joint_coords", "joints", "kp3d")


def load_any(path):
    if path.endswith(".npz"):
        d = np.load(path, allow_pickle=True); return {k: d[k] for k in d.files}
    if path.endswith(".npy"):
        a = np.load(path, allow_pickle=True)
        return a.item() if a.dtype == object and a.shape == () else {"array": a}
    if path.endswith(".pkl"):
        with open(path, "rb") as f: return pickle.load(f)
    import torch
    return torch.load(path, map_location="cpu", weights_only=False)


def walk(obj, prefix=""):
    """Yield (key_path, ndarray) for every array-like leaf."""
    if hasattr(obj, "detach"): obj = obj.detach().cpu().numpy()
    if isinstance(obj, np.ndarray) and obj.dtype != object:
        yield prefix, obj
    elif isinstance(obj, dict):
        for k, v in obj.items(): yield from walk(v, f"{prefix}.{k}" if prefix else str(k))
    elif isinstance(obj, (list, tuple)) and obj and not isinstance(obj[0], (int, float)):
        for i, v in enumerate(obj): yield from walk(v, f"{prefix}[{i}]")
    elif isinstance(obj, np.ndarray) and obj.dtype == object:
        for i, v in enumerate(obj.ravel()): yield from walk(v, f"{prefix}[{i}]")


def candidates(root):
    files = sorted(p for p in glob.glob(os.path.join(root, "**", "*"), recursive=True)
                   if p.endswith(EXTS) and "ckpt" not in p and "checkpoint" not in p and ".venv" not in p)
    for f in files:
        try: data = load_any(f)
        except Exception as e:
            print(f"skip {f}: {e}", file=sys.stderr); continue
        for k, a in walk(data):
            if a.ndim >= 2 and a.shape[-1] == 3 and 15 <= a.shape[-2] <= 200:
                yield f, k, a


def frame_no(path):
    m = re.findall(r"(\d+)", os.path.basename(path)); return int(m[-1]) if m else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--search", default="."); ap.add_argument("--out", default="out")
    ap.add_argument("--fps", type=float, default=30); ap.add_argument("--key")
    ap.add_argument("--inspect", action="store_true")
    a = ap.parse_args()
    cands = list(candidates(a.search))
    if a.inspect:
        for f, k, arr in cands: print(f"{f} :: {k} :: {arr.shape}")
        return
    if not cands: sys.exit("No joint-like arrays found. Run with --inspect and check the output folder.")
    def score(c):
        k = c[1].lower(); s = sum(h in k for h in JOINT_HINTS) * 10
        return s + c[2].ndim  # prefer named + already-stacked arrays
    best_key = a.key or max(cands, key=score)[1]
    chosen = [c for c in cands if c[1] == best_key]
    print(f"using key '{best_key}' from {len(chosen)} file(s)")
    if len(chosen) == 1 and chosen[0][2].ndim >= 3:
        arr = chosen[0][2]                       # (T,J,3) or (T,P,J,3) or (P,T,J,3)
        people = [arr] if arr.ndim == 3 else [arr[:, p] if arr.shape[0] > arr.shape[1] else arr[p] for p in range(min(arr.shape[:2]))]
    else:                                        # one file per frame -> stack
        chosen.sort(key=lambda c: frame_no(c[0]))
        frames = [c[2] for c in chosen]
        frames = [f[None] if f.ndim == 2 else f for f in frames]   # (P,J,3)
        P = max(f.shape[0] for f in frames)
        people = []
        for p in range(P):
            seq = [f[p] if p < f.shape[0] else np.full_like(frames[0][0], np.nan) for f in frames]
            people.append(np.stack(seq))
    os.makedirs(a.out, exist_ok=True)
    for p, j in enumerate(people):
        j = j.astype(np.float32)
        # fill dropped frames by holding the last good pose
        for t in range(1, len(j)):
            if np.isnan(j[t]).any(): j[t] = j[t - 1]
        np.savez(os.path.join(a.out, f"joints_p{p}.npz"), joints=j, fps=a.fps, key=best_key)
        print(f"person {p}: {j.shape[0]} frames x {j.shape[1]} joints")


if __name__ == "__main__":
    main()
