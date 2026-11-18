# video2anim — video → mocap → Blender → fast render → upscale + Krea 2 style

Written for Claude Code (phone, Termux) to run end to end on RunPod. Files pass through
Backblaze B2 (`Runpodmodels2099`); every pod deletes itself when finished or when it hits its cap.

```
 Your video (B2)
   │  STAGE 1  A100 80GB pod  (~$1.20–1.40/hr)      stage1_mocap.sh
   ▼  SAM-Body4D → 3D joints per frame → joints_p0.npz, joints_p1.npz …  → B2
   │  STAGE 2  RTX 4090 24GB pod (~$0.34/hr community)   stage2_render_style.sh
   ▼  Blender: joints drive your rigged character (bake) → Eevee 540x960 low-quality render
      ComfyUI: RealESRGAN 2x → Krea 2 Turbo + your LoRA img2img (fixed seed, denoise 0.4)
      ffmpeg: 1080x1920 MP4 with light deflicker  → B2
```

## The portal (start runs and watch them from your phone)
`bash portal/start.sh` starts a small web app on the phone at http://127.0.0.1:8090. Add it to the home screen for an app icon.
- **Budget**: what's left of the $45 and about how many runs that buys.
- **New run**: pick the mode (new video, new character, new look, or preview), upload the video (sent to B2 without being opened),
  then choose the character, LoRA, prompt and style strength. It lists **what Claude will do**, step by step, with a cost for each step.
- **Now running**: a live step-by-step timeline, the current action, progress %, pod spend, Claude's action log, the live pod log, and a Stop button that deletes the pods.
- **If something fails**: the pod saves its log and deletes itself. **Ask Claude to find & fix the problem** runs Claude Code on the phone
  against the log; it fixes the scripts and explains in plain words.
- **Results**: play or save each finished MP4.
- **Pods**: every pod on the account, so you can see that nothing is billing.
Pods report progress by writing `jobs/<job>/status.json` and `log_tail.txt` to B2 (`status.sh`), so the phone never connects to a pod directly.
If the phone sleeps, pods still finish or hit their caps and delete themselves. When the portal starts again, it picks up the run where it left off.

## The $45 covers many runs
`ledger.sh` keeps a running total of every pod's spend in `B2/ledger/ledger.csv`.
Before any pod starts work it checks: *total so far + this stage's cap ≤ $45*. If not, it refuses and deletes itself.
`bash ledger.sh show` prints what's left.

Ways the scripts keep each run cheap:
| What you change | What runs | Rough cost (41 s clip) |
|---|---|---|
| New video | Stage 1 + Stage 2 | ~$1.50–3 |
| Same video, new character | Stage 2 only (mocap is reused from B2) | ~$0.80–1.50 |
| Same render, new look/LoRA/prompt | Stage 2 with `RESTYLE_ONLY=1` (skips Blender) | ~$0.60–1.20 |
| Testing a look | add `PREVIEW_EVERY=10` (styles 1 in 10 frames) | ~$0.10–0.20 |

So roughly 15–30 full runs, or many more re-styles, from $45. The first run costs more because it downloads
the models (SAM checkpoints, Krea 2, Blender) once and caches them in B2. That cache is ~30 GB, which is over
B2's free 10 GB, so expect a few US cents a month. These are estimates until the first real run:
`stylize_comfy.py` times 5 frames and stops before spending if its forecast passes the stage cap.

## One-time setup (Claude Code does this)
1. **Hugging Face**: request access to SAM 3 and SAM 3D Body on huggingface.co (the user has to click "agree"
   on each model page). Put `HF_TOKEN` in RunPod Secrets.
2. RunPod Secrets: `HF_TOKEN`, `B2_APPLICATION_KEY_ID`, `B2_APPLICATION_KEY`.
3. Edit `config.env`: LoRA repo/file + trigger word, character file, prices.
4. Upload this folder to B2 at `code/video2anim/`, the video to `input/`, the rigged character to `characters/`.
5. **Bone map (once per character skeleton)**: run Stage 1 once, open `jobs/<job>/stage1/inspect.txt`, read the joint
   order from sam-3d-body's keypoint metadata, and write `bone_maps/<char>.json` (format at the top of
   `blender_retarget.py`). Only joint indices and bone names are needed; no one has to look at the video.

## Each run (Claude Code)
Start a pod with these commands: `bash -c "pip -q install b2 && b2 sync b2://Runpodmodels2099/code/video2anim /workspace/v2a && bash /workspace/v2a/<stage>.sh"`
- Stage 1: A100 80GB PCIe/SXM, community, 40 GB container disk.
- Stage 2: RTX 4090, community, 60 GB container disk. Pass `JOB_NAME`, `STYLE_TAG`, `RESTYLE_ONLY`, `PREVIEW_EVERY` as pod env vars.
- Result: `B2/jobs/<job>/stage2/<job>_<style>.mp4` (+ `raw_render.mp4` for comparison).

## Known limits / first-run checks
- **SAM-Body4D's output layout isn't documented.** `export_joints.py` searches for joint arrays and writes `inspect.txt`; check it on the first run.
- **Eevee needs GPU OpenGL.** Many RunPod containers only expose CUDA. The script tests Eevee on 3 frames and,
  if it can't use the GPU, switches to Cycles GPU at 16 samples + denoise (about as fast at 540x960).
- **Retarget is aim-based** (body, arms, legs, head). Fingers and fine wrist twist aren't captured.
- **Flicker**: frame-by-frame img2img always shimmers a little. Fixed seed + low denoise + ffmpeg deflicker keep it down;
  lower `DENOISE` (0.30) for steadier video, raise it (0.50) for a stronger style.
- If the Krea 2 output looks off, compare the sampler settings with ComfyUI's official Krea 2 template (it may add a model-sampling/shift node).
- Pod spend is timed from when the script starts, so the 1–3 min of boot time isn't counted. The caps leave room for it.
