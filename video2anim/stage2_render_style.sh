#!/usr/bin/env bash
# STAGE 2 — runs ON one RTX 4090 (24GB) pod: Blender + ComfyUI together.
# joints (B2) -> retarget -> fast low-res render -> 2x upscale + Krea 2 LoRA -> MP4 -> B2 -> pod deletes itself.
set -eEuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"; set -a; source ./config.env; set +a
W=/workspace; mkdir -p $W/job $W/frames $W/styled $W/final
exec > >(tee -a /tmp/pipeline.log) 2>&1
JOB="$B2_BUCKET/jobs/$JOB_NAME"

pip install -q --upgrade b2 huggingface_hub
source ./status.sh
selfdestruct () { st done "Finished: $NAME.mp4 — render pod deleted" 100 force; sleep 3
selfdestruct 2>/dev/null || curl -s -X DELETE "https://rest.runpod.io/v1/pods/$RUNPOD_POD_ID" -H "Authorization: Bearer $RUNPOD_API_KEY"; }
st render_setup "Render pod is up, checking budget" 0 force
bash ./ledger.sh check "$STAGE2_CAP_USD" || { st failed "Budget would run out — not starting" "" force; selfdestruct; exit 1; }
nohup bash ./budget_guard.sh "$STAGE2_RATE_USD_HR" "$STAGE2_CAP_USD" $W/final "$JOB/stage2" render-style >/dev/null 2>&1 &
RAW="$JOB/stage2/raw_frames_$(basename ${CHARACTER_FILE%.*})"

if [ "${RESTYLE_ONLY:-0}" = "1" ] && b2 ls "b2://$RAW/" | grep -q png; then
  st render "Reusing saved render frames (style-only run)" 100 force
  b2 sync --no-progress "b2://$RAW" $W/frames
  apt-get update -qq && apt-get install -y -qq ffmpeg >/dev/null
else
st render_setup "Fetching mocap, character and bone map" 5 force
b2 sync --no-progress "b2://$JOB/stage1" $W/job/stage1
b2 file download --no-progress "b2://$B2_BUCKET/$CHARACTER_FILE" "$W/job/$(basename $CHARACTER_FILE)"
b2 file download --no-progress "b2://$B2_BUCKET/$BONE_MAP" $W/job/bonemap.json

st render_setup "Getting Blender ready" 10 force
BL_VER=4.5.3; BL=$W/blender-$BL_VER-linux-x64
if [ ! -x $BL/blender ]; then
  b2 file download --no-progress "b2://$B2_BUCKET/cache/blender-$BL_VER-linux-x64.tar.xz" $W/bl.tar.xz \
   || { wget -q -O $W/bl.tar.xz "https://download.blender.org/release/Blender4.5/blender-$BL_VER-linux-x64.tar.xz" \
        && b2 file upload --no-progress "$B2_BUCKET" $W/bl.tar.xz "cache/blender-$BL_VER-linux-x64.tar.xz"; }
  tar -xf $W/bl.tar.xz -C $W
fi
apt-get update -qq && apt-get install -y -qq libegl1 libgl1 libxi6 libxkbcommon0 libsm6 libxrender1 libxxf86vm1 libxfixes3 ffmpeg >/dev/null

st retarget "Putting the mocap onto your character" 0 force
cd "$HERE"
$BL/blender -b -P blender_retarget.py -- --character "$W/job/$(basename $CHARACTER_FILE)" \
  --joints $W/job/stage1/joints_p${PERSON_INDEX}.npz --map $W/job/bonemap.json --out $W/job/scene.blend

st render "Testing whether Eevee can use the GPU here" 0 force
ENGINE=eevee
T0=$(date +%s)
if ! timeout 180 $BL/blender -b $W/job/scene.blend -P blender_render.py -- --out $W/frames_test --engine eevee --test 3 > /tmp/eevee_test.log 2>&1 \
   || grep -qiE "llvmpipe|software rasterizer|failed to create (gpu|opengl|egl)|unable to open a display" /tmp/eevee_test.log \
   || [ $(( $(date +%s) - T0 )) -gt 90 ]; then
  ENGINE=cycles; echo "Eevee not usable on this pod -> Cycles GPU 16spp + denoise"
fi

TOTAL=$(python3 -c "import numpy as np;print(len(np.load('$W/job/stage1/joints_p${PERSON_INDEX}.npz')['joints']))" 2>/dev/null || echo 1)
st render "Rendering $TOTAL frames ($ENGINE, low-res)" 0 force
$BL/blender -b $W/job/scene.blend -P blender_render.py -- --out $W/frames --engine $ENGINE | while IFS= read -r line; do
  case "$line" in *Saved:*) N=$(ls $W/frames | wc -l); st render "Rendered $N / $TOTAL frames ($ENGINE)" $(( N*100/TOTAL ));; *Error*|*RENDER_DONE*) echo "$line";; esac
done
b2 sync --no-progress $W/frames "b2://$RAW"    # saved so later style changes skip Blender entirely
ffmpeg -y -loglevel error -framerate $FPS -i $W/frames/f_%04d.png -c:v libx264 -crf 20 -pix_fmt yuv420p $W/final/raw_render.mp4
fi

st style_setup "Loading ComfyUI, Krea 2 and your LoRA" 0 force
cd $W
[ -d ComfyUI ] || git clone -q https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI && pip install -q -r requirements.txt
M=models; mkdir -p $M/diffusion_models $M/text_encoders $M/vae $M/loras $M/upscale_models
b2 sync --no-progress "b2://$B2_BUCKET/cache/comfy-models" $M || true
fetch_hf () { # repo file dest_dir
  [ -f "$3/$(basename $2)" ] || { hf download "$1" "$2" --local-dir /tmp/hf ${HF_TOKEN:+--token "$HF_TOKEN"} >/dev/null && mv "/tmp/hf/$2" "$3/"; }
}
fetch_hf Comfy-Org/Krea-2 split_files/diffusion_models/krea2_turbo_fp8_scaled.safetensors $M/diffusion_models \
  || fetch_hf Comfy-Org/Krea2 split_files/diffusion_models/krea2_turbo_fp8_scaled.safetensors $M/diffusion_models
fetch_hf Comfy-Org/Krea-2 split_files/text_encoders/qwen3vl_4b_fp8_scaled.safetensors $M/text_encoders \
  || fetch_hf Comfy-Org/Krea2 split_files/text_encoders/qwen3vl_4b_fp8_scaled.safetensors $M/text_encoders
fetch_hf Comfy-Org/Krea-2 split_files/vae/qwen_image_vae.safetensors $M/vae \
  || fetch_hf Comfy-Org/Krea2 split_files/vae/qwen_image_vae.safetensors $M/vae
[ -f "$M/loras/$LORA_FILE" ] || b2 file download --no-progress "b2://$B2_BUCKET/loras/$LORA_FILE" "$M/loras/$LORA_FILE" \
  || { [ -n "$LORA_HF_REPO" ] && fetch_hf "$LORA_HF_REPO" "$LORA_FILE" $M/loras; } \
  || { st failed "LoRA $LORA_FILE is not in B2 loras/" "" force; exit 1; }
[ -f $M/upscale_models/RealESRGAN_x2plus.pth ] || wget -q -P $M/upscale_models \
  https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth
b2 sync --no-progress $M "b2://$B2_BUCKET/cache/comfy-models"
nohup python main.py --listen 127.0.0.1 --port 8188 > /tmp/comfy.log 2>&1 &
until curl -s 127.0.0.1:8188/system_stats >/dev/null; do sleep 2; done

st style "Upscaling and applying your LoRA style" 0 force
cd "$HERE"
EVERY=${PREVIEW_EVERY:-1}
python stylize_comfy.py --frames $W/frames --comfy $W/ComfyUI --out $W/styled --every $EVERY | while IFS= read -r line; do
  echo "$line"
  case "$line" in styled*) A=${line#styled }; D=${A%%/*}; T=${A#*/}; st style "Styled $D / $T frames" $(( D*100/T ));;
                  BENCH*) st style "Speed test: ${line#BENCH }" 2 force;; esac
done
[ -n "$(ls $W/styled)" ] || { st failed "Style step stopped (see log — likely the cost forecast)" "" force; exit 1; }

st assemble "Making the final 1080x1920 video" 50 force
OUTFPS=$(python3 -c "print($FPS/$EVERY)")
NAME="${JOB_NAME}_${STYLE_TAG:-style}$([ "$EVERY" != "1" ] && echo _preview)"
ffmpeg -y -loglevel error -framerate $OUTFPS -pattern_type glob -i "$W/styled/*.png" \
  -vf "scale=1080:1920:flags=lanczos,deflicker=size=5:mode=pm" -r $FPS \
  -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p -movflags +faststart $W/final/$NAME.mp4

st assemble "Uploading results" 90 force
b2 sync --no-progress $W/final "b2://$JOB/stage2"
b2 file upload --no-progress "$B2_BUCKET" /tmp/pipeline.log "jobs/$JOB_NAME/stage2/pipeline_${NAME}.log"
bash ./ledger.sh add "$(cat /tmp/spent_usd 2>/dev/null || echo 0.05)" "render-style:$NAME"
runpodctl remove pod "$RUNPOD_POD_ID"
