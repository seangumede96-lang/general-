#!/usr/bin/env bash
# STAGE 1 — runs ON the A100 80GB pod.
# Video (from B2) -> SAM-Body4D -> joints_pN.npz -> B2. Then the pod deletes itself.
# Nobody needs to look at the video: everything runs headless.
set -eEuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"; set -a; source ./config.env; set +a
W=/workspace; OUT=$W/out; CK=$W/ckpts; mkdir -p "$OUT" "$CK" $W/in
exec > >(tee -a /tmp/pipeline.log) 2>&1
DEST="$B2_BUCKET/jobs/$JOB_NAME/stage1"
pip install -q --upgrade b2 huggingface_hub uv
source "$HERE/status.sh"
selfdestruct () { runpodctl remove pod "$RUNPOD_POD_ID" 2>/dev/null || curl -s -X DELETE "https://api.runpod.io/v2/pods/$RUNPOD_POD_ID" -H "Authorization: Bearer $RUNPOD_API_KEY"; }

st mocap_setup "Mocap pod is up, checking budget" 0 force
bash "$HERE/ledger.sh" check "$STAGE1_CAP_USD" || { st failed "Budget would run out — not starting" "" force; selfdestruct; exit 1; }
nohup bash "$HERE/budget_guard.sh" "$STAGE1_RATE_USD_HR" "$STAGE1_CAP_USD" "$OUT" "$DEST" mocap >/dev/null 2>&1 &
if b2 ls "b2://$DEST/" | grep -q "joints_p0.npz"; then
  st mocap_done "Mocap for this video already exists — reusing it" 100 force; selfdestruct; exit 0
fi

st mocap_setup "Downloading video from B2 (kept sealed, not viewed)" 5 force
b2 file download --no-progress "b2://$B2_BUCKET/$INPUT_VIDEO" $W/in/video.mp4

st mocap_setup "Installing SAM-Body4D" 10 force
cd $W
[ -d sam-body4d ] || git clone --recursive https://github.com/gaomingqi/sam-body4d.git
cd sam-body4d
# Into the image's own Python and PyTorch (the recipe that worked on 2026-11-12): a separate env with
# CUDA 11.8 wheels can't build detectron2 against the image's CUDA 12 compiler.
export PIP_BREAK_SYSTEM_PACKAGES=1 DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq ffmpeg build-essential libegl1 libgl1 libgles2 libglib2.0-0 libosmesa6 >/dev/null 2>&1 || true
command -v python >/dev/null || ln -sf "$(command -v python3)" /usr/local/bin/python
python -c "import torch; print('torch', torch.__version__, 'cuda', torch.version.cuda, torch.cuda.is_available())"
pip install -q 'git+https://github.com/facebookresearch/detectron2.git@a1ce2f9' --no-build-isolation --no-deps
pip install -q -e models/sam3
pip install -q -e .

st mocap_setup "Loading model checkpoints (B2 cache, else Hugging Face)" 30 force
if b2 ls "b2://$B2_BUCKET/cache/sam-body4d-ckpts/" | grep -q .; then
  b2 sync --no-progress "b2://$B2_BUCKET/cache/sam-body4d-ckpts" "$CK"
fi
hf auth login --token "$HF_TOKEN" >/dev/null 2>&1 || huggingface-cli login --token "$HF_TOKEN"
python scripts/setup.py --ckpt-root "$CK"
b2 sync --no-progress "$CK" "b2://$B2_BUCKET/cache/sam-body4d-ckpts"

st mocap_run "Extracting body motion from the video" 45 force
T0=$(date +%s)
python scripts/offline_app.py --input_video $W/in/video.mp4 2>&1 | while IFS= read -r line; do
  echo "$line"; st mocap_run "Extracting body motion ($(( $(date +%s) - T0 ))s so far)" 60
done
st mocap_run "Saving skeleton data" 90 force
python "$HERE/export_joints.py" --search . --inspect > "$OUT/inspect.txt" || true
python "$HERE/export_joints.py" --search . --out "$OUT" --fps "$FPS"

b2 sync --no-progress "$OUT" "b2://$DEST"
b2 file upload --no-progress "$B2_BUCKET" /tmp/pipeline.log "jobs/$JOB_NAME/stage1/pipeline.log"
bash "$HERE/ledger.sh" add "$(cat /tmp/spent_usd 2>/dev/null || echo 0.05)" mocap
st mocap_done "Mocap finished — mocap pod deleted" 100 force; sleep 3
selfdestruct
