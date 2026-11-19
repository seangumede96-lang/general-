#!/usr/bin/env bash
# STAGE 1 (cheap) — runs ON an RTX 4090-class pod.
# Video (from B2) + the owner's taps -> SAM 2 per-person masks -> 4D-Humans per person -> joints_pN.npz + qc.json -> B2.
# Nobody looks at the video: frames are extracted to the pod's disk only for the models, never uploaded, and deleted.
set -eEuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"; set -a; source ./config.env; set +a
W=/workspace; OUT=$W/out; CK=$W/ckpts; mkdir -p "$OUT" "$CK" $W/in
exec > >(tee -a /tmp/pipeline.log) 2>&1
DEST="$B2_BUCKET/jobs/$JOB_NAME/stage1"
export PIP_BREAK_SYSTEM_PACKAGES=1 DEBIAN_FRONTEND=noninteractive
pip install -q --upgrade b2
source "$HERE/status.sh"
selfdestruct () { runpodctl remove pod "$RUNPOD_POD_ID" 2>/dev/null || curl -s -X DELETE "https://api.runpod.io/v2/pods/$RUNPOD_POD_ID" -H "Authorization: Bearer ${RUNPOD_API_KEY:-}"; }
trap 'rm -rf $W/frames' EXIT

st mocap_setup "Mocap pod is up (4D-Humans), checking budget" 0 force
bash "$HERE/ledger.sh" check "$STAGE1B_CAP_USD" || { st failed "Budget would run out — not starting" "" force; selfdestruct; exit 1; }
nohup bash "$HERE/budget_guard.sh" "$STAGE1B_RATE_USD_HR" "$STAGE1B_CAP_USD" "$OUT" "$DEST" mocap >/dev/null 2>&1 &
if b2 ls "b2://$DEST/" | grep -q "joints_p0.npz"; then
  st mocap_done "Mocap for this video already exists — reusing it" 100 force; selfdestruct; exit 0
fi

st mocap_setup "Downloading video and your marks from B2 (video kept sealed, not viewed)" 5 force
b2 file download --no-progress "b2://$B2_BUCKET/$INPUT_VIDEO" $W/in/video.mp4
b2 file download --no-progress "b2://$B2_BUCKET/jobs/$JOB_NAME/seeds.json" $W/in/seeds.json

st mocap_setup "Installing SAM 2 and 4D-Humans" 10 force
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq ffmpeg git libegl1 libgl1 libgles2 libglib2.0-0 libosmesa6 >/dev/null 2>&1 || true
# 4D-Humans imports its (unused) mesh renderer, pyrender, at load time: give it a headless OpenGL.
export PYOPENGL_PLATFORM=egl
command -v python >/dev/null || ln -sf "$(command -v python3)" /usr/local/bin/python
python -c "import torch; print('torch', torch.__version__, 'cuda', torch.version.cuda, torch.cuda.is_available())"
SAM2_BUILD_CUDA=0 pip install -q "git+https://github.com/facebookresearch/sam2.git"
# 4D-Humans without its 'chumpy' dependency (doesn't install on Python 3.12); the SMPL file is converted instead.
pip install -q --no-deps "git+https://github.com/shubham-goel/4D-Humans.git"
pip install -q gdown hydra-core omegaconf pytorch-lightning smplx==0.1.28 yacs einops timm webdataset braceexpand dill pandas \
  scikit-image opencv-python-headless pyrender trimesh rich
pip install -q -U "PyOpenGL>=3.1.7"   # pyrender pins 3.1.0, which predates Python 3.12
# Load exactly what the run uses now, so a missing piece fails here (minutes in), not after the downloads.
python -c "import sam2; from sam2.build_sam import build_sam2_video_predictor; from hmr2.models import load_hmr2, download_models; from hmr2.datasets.vitdet_dataset import ViTDetDataset; from hmr2.utils import recursive_to; print('sam2 + hmr2 import ok')"

st mocap_setup "Loading models (B2 cache, else download once)" 25 force
C4=$(python -c "from hmr2.configs import CACHE_DIR_4DHUMANS as c; print(c)")
mkdir -p "$C4" "$CK/sam2"
b2 sync --no-progress "b2://$B2_BUCKET/cache/4dhumans" "$C4" || true
b2 sync --no-progress "b2://$B2_BUCKET/cache/sam2" "$CK/sam2" || true
SAM2_CKPT=$CK/sam2/sam2.1_hiera_large.pt
[ -s "$SAM2_CKPT" ] || curl -sSL --retry 5 -o "$SAM2_CKPT" https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt
# The SMPL body model (the owner's own download, uploaded through the portal to B2 smpl/), made chumpy-free.
if [ ! -s "$C4/data/smpl/SMPL_NEUTRAL.pkl" ]; then
  SMPL_SRC=$(b2 ls "b2://$B2_BUCKET/smpl/" | grep -iE '\.(zip|pkl)$' | head -1)
  [ -n "$SMPL_SRC" ] || { st failed "No SMPL file in B2 smpl/ yet: upload it in the portal (Mocap: 4D-Humans)" "" force; exit 1; }
  b2 file download --no-progress "b2://$B2_BUCKET/$SMPL_SRC" "$W/in/smpl_download"
  mkdir -p "$C4/data/smpl"; python "$HERE/smpl_convert.py" "$W/in/smpl_download" "$C4/data/smpl/SMPL_NEUTRAL.pkl"
fi
python -c "from hmr2.configs import CACHE_DIR_4DHUMANS as c; from hmr2.models import download_models; download_models(c)"
b2 sync --no-progress "$C4" "b2://$B2_BUCKET/cache/4dhumans" || true
b2 sync --no-progress "$CK/sam2" "b2://$B2_BUCKET/cache/sam2" || true

st mocap_run "Preparing frames on the pod (temporary, never uploaded)" 40 force
mkdir -p $W/frames
ffmpeg -loglevel error -i $W/in/video.mp4 -vf "fps=$FPS" -q:v 2 -start_number 0 $W/frames/%05d.jpg
echo "frames: $(ls $W/frames | wc -l)"

st mocap_run "Following each person (SAM 2), then reading each body (4D-Humans)" 50 force
T0=$(date +%s)
python "$HERE/fourdh_track.py" --frames $W/frames --seeds $W/in/seeds.json --fps "$FPS" --out "$OUT" --sam2-ckpt "$SAM2_CKPT" 2>&1 | while IFS= read -r line; do
  echo "$line"; st mocap_run "Reading the bodies ($(( $(date +%s) - T0 ))s so far)" 60
done
rm -rf $W/frames

st mocap_run "Saving skeleton data and the numbers check" 90 force
b2 sync --no-progress "$OUT" "b2://$DEST"
b2 file upload --no-progress "$B2_BUCKET" /tmp/pipeline.log "jobs/$JOB_NAME/stage1/pipeline.log"
bash "$HERE/ledger.sh" add "$(cat /tmp/spent_usd 2>/dev/null || echo 0.05)" mocap-4dhumans
st mocap_done "Mocap finished (4D-Humans) — mocap pod deleted" 100 force; sleep 3
selfdestruct
