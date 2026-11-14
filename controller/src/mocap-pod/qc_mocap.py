#!/usr/bin/env python3
"""Numbers-only quality check of SAM-Body4D joint data: no pictures are read or written.

  python3 qc_mocap.py <joints dir> <fps> > qc.json

Per person (track id): frames present and missing, jitter (median frame-to-frame acceleration of
the joints, cm), sudden jumps (a joint moving more than 15 cm between frames), bone-length drift
(how much the most rigid joint pairs change length, %), and likely identity swaps (two people's
positions trading places between frames).
"""
import glob, json, os, sys
import numpy as np

JUMP_M = 0.15

def load(dirname):
    frames = []
    for path in sorted(glob.glob(os.path.join(dirname, "*.npz"))):
        d = np.load(path, allow_pickle=False)
        people = {}
        ids = d["ids"].tolist() if "ids" in d.files else []
        if "pred_joint_coords" in d.files:
            j = d["pred_joint_coords"]
            t = d["pred_cam_t"] if "pred_cam_t" in d.files else np.zeros((len(j), 3))
            for row, pid in enumerate(ids[: len(j)]):
                # Camera-space joints: per-person joints plus that person's translation.
                people[int(pid)] = np.asarray(j[row], dtype=np.float64).reshape(-1, 3) + np.asarray(t[row], dtype=np.float64).reshape(1, 3)
        frames.append(people)
    return frames

def rigid_pairs(seq, count=12):
    """Joint pairs whose distance varies least over the clip: stand-ins for bones."""
    stack = np.stack(seq)  # frames x joints x 3
    n = stack.shape[1]
    idx = np.array([(a, b) for a in range(n) for b in range(a + 1, n)])
    if len(idx) == 0: return idx, None
    dist = np.linalg.norm(stack[:, idx[:, 0]] - stack[:, idx[:, 1]], axis=-1)  # frames x pairs
    mean = dist.mean(0)
    ok = mean > 0.05  # ignore pairs closer than 5 cm (noise dominates)
    if not ok.any(): return idx[:0], None
    cv = dist.std(0) / np.maximum(mean, 1e-6)
    order = np.argsort(np.where(ok, cv, np.inf))[:count]
    return idx[order], dist[:, order]

def main():
    dirname, fps = sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 30.0
    frames = load(dirname)
    total = len(frames)
    ids = sorted({pid for f in frames for pid in f})
    report = {"frames": total, "fps": fps, "seconds": round(total / fps, 2) if fps else None, "people": {}, "swaps": []}
    for pid in ids:
        present = [i for i, f in enumerate(frames) if pid in f]
        seq = [frames[i][pid] for i in present]
        r = {"frames_present": len(present), "frames_missing": total - len(present), "first_frame": present[0] if present else None, "last_frame": present[-1] if present else None}
        # Units: SAM 3D Body works in metres; if one body spans 10+ units, it is centimetres.
        if seq:
            extent = float(np.linalg.norm(seq[0].max(0) - seq[0].min(0)))
            if extent >= 10: seq = [x / 100.0 for x in seq]
            r["unit_guess"] = "centimetres" if extent >= 10 else "metres"
            sizes = np.array([np.linalg.norm(x.max(0) - x.min(0)) for x in seq]) * 100
            r["body_extent_cm_mean"] = round(float(sizes.mean()), 1)
            r["body_extent_cm_std"] = round(float(sizes.std()), 1)
        consecutive = [k for k in range(1, len(present)) if present[k] == present[k - 1] + 1]
        if consecutive and seq[0].shape[0] > 0:
            moves = np.stack([np.linalg.norm(seq[k] - seq[k - 1], axis=-1) for k in consecutive])  # pairs x joints
            r["jumps_over_15cm"] = int((moves > JUMP_M).any(axis=1).sum())
            r["largest_jump_cm"] = round(float(moves.max()) * 100, 1)
            triples = [k for k in range(2, len(present)) if present[k] == present[k - 2] + 2]
            if triples:
                acc = np.stack([np.linalg.norm(seq[k] - 2 * seq[k - 1] + seq[k - 2], axis=-1) for k in triples])
                r["jitter_median_cm"] = round(float(np.median(acc)) * 100, 2)
                r["jitter_p95_cm"] = round(float(np.percentile(acc, 95)) * 100, 2)
            pairs, dist = rigid_pairs(seq)
            if dist is not None and len(pairs):
                drift = np.abs(dist - np.median(dist, 0)) / np.maximum(np.median(dist, 0), 1e-6)
                r["bone_length_drift_pct_median"] = round(float(np.median(drift)) * 100, 2)
                r["bone_length_drift_pct_max"] = round(float(drift.max()) * 100, 1)
        report["people"][str(pid)] = r
    # identity swaps: two people whose centres trade places between consecutive frames
    for i in range(1, total):
        a, b = frames[i - 1], frames[i]
        common = [p for p in ids if p in a and p in b]
        for x in range(len(common)):
            for y in range(x + 1, len(common)):
                p, q = common[x], common[y]
                cp, cq = a[p].mean(0), a[q].mean(0)
                np_, nq = b[p].mean(0), b[q].mean(0)
                kept = np.linalg.norm(np_ - cp) + np.linalg.norm(nq - cq)
                swapped = np.linalg.norm(np_ - cq) + np.linalg.norm(nq - cp)
                if swapped < 0.5 * kept and kept > 0.2:
                    report["swaps"].append({"frame": i, "people": [p, q]})
    # Plain-language verdict for the app.
    notes = []
    for pid, r in report["people"].items():
        if total and r["frames_missing"] > 0.1 * total: notes.append(f"person {pid} is missing in {r['frames_missing']} of {total} frames")
        if r.get("jitter_median_cm", 0) > 2: notes.append(f"person {pid} is jittery ({r['jitter_median_cm']} cm median)")
        if r.get("jumps_over_15cm", 0) > 0: notes.append(f"person {pid} has {r['jumps_over_15cm']} sudden jumps over 15 cm")
        if r.get("bone_length_drift_pct_median", 0) > 5: notes.append(f"person {pid}'s bone lengths drift ({r['bone_length_drift_pct_median']}% median)")
    if report["swaps"]: notes.append(f"{len(report['swaps'])} possible identity swaps")
    if not ids: notes.append("nobody was tracked")
    report["verdict"] = "Looks clean." if not notes else "Check: " + "; ".join(notes) + "."
    print(json.dumps(report, indent=1))

if __name__ == "__main__":
    main()
