"""Make the plain-numpy SMPL_NEUTRAL.pkl that 4D-Humans loads, from the file the owner downloads.

  python smpl_convert.py <download: .zip or .pkl> <out SMPL_NEUTRAL.pkl>

Accepts the SMPLify download (mpips_smplify_public_v2.zip -> basicModel_neutral_lbs_10_207_0_v1.0.0.pkl)
or the SMPL "for Python" download (SMPL_python_v.1.1.0.zip -> basicmodel_neutral_lbs_10_207_0_v1.1.0.pkl),
zipped or not. Those pickles hold 'chumpy' objects (an old library that no longer installs on current
Python); they are read here with stand-in classes and turned into numpy arrays, so chumpy isn't needed.
"""
import io, pickle, sys, zipfile
import numpy as np


class _Stub:
    """Stands in for any chumpy class while unpickling: keeps its state, turns into an array later."""
    def __init__(self, *a, **k): self._args = a
    def __setstate__(self, state): self._state = state
    def __call__(self, *a, **k): return _Stub(*a)


class _Unpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if module.startswith("chumpy"): return _Stub
        # old SciPy paths (scipy.sparse.csc ...) are being retired: the classes live in scipy.sparse
        if module.startswith("scipy.sparse."): module = "scipy.sparse"
        return super().find_class(module, name)


def to_array(v):
    if isinstance(v, _Stub):
        st = getattr(v, "_state", {}) or {}
        if isinstance(st, dict):
            for key in ("x", "r", "_x"):
                if key in st and isinstance(st[key], np.ndarray): return np.asarray(st[key])
            arrs = [x for x in st.values() if isinstance(x, np.ndarray)]
            if arrs: return max(arrs, key=lambda x: x.size)
        arrs = [x for x in getattr(v, "_args", ()) if isinstance(x, np.ndarray)]
        if arrs: return max(arrs, key=lambda x: x.size)
        raise ValueError("a chumpy value without array data")
    return v


def load(src):
    raw = open(src, "rb").read()
    if raw[:2] == b"PK":
        z = zipfile.ZipFile(io.BytesIO(raw))
        names = [n for n in z.namelist() if n.lower().endswith(".pkl") and "neutral" in n.lower()]
        if not names: sys.exit(f"no neutral SMPL .pkl inside the zip (found: {[n for n in z.namelist() if n.endswith('.pkl')][:6]})")
        raw = z.read(sorted(names, key=len)[0]); print("using", sorted(names, key=len)[0])
    return _Unpickler(io.BytesIO(raw), encoding="latin1").load()


if __name__ == "__main__":
    d = load(sys.argv[1])
    out = {k: to_array(v) for k, v in d.items()}
    need = ["v_template", "shapedirs", "posedirs", "J_regressor", "weights", "kintree_table", "f"]
    missing = [k for k in need if k not in out]
    if missing: sys.exit(f"not an SMPL model file (missing {missing})")
    out["shapedirs"] = np.asarray(out["shapedirs"])
    print({k: getattr(v, "shape", type(v).__name__) for k, v in out.items() if k in need})
    pickle.dump(out, open(sys.argv[2], "wb"))
    print("wrote", sys.argv[2])
