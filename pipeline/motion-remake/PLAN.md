# Motion remake module (user request 2026-11-16: "Build it yourself")
Goal: upload an adult video -> uncensored video-language model writes a per-piece motion description ->
an uncensored video model recreates that motion with a fictional character from the user's Krea LoRA.
Run BLIND (Claude never opens frames, results or the descriptions: user rule). User reviews in the app.
Rights tick box stays (consenting adults, footage the user may use). Fictional adult characters only.

## Design (agreed with the user)
1. App page "Motion remake" built on the Video module (src/video.js, video-recipe.js; ComfyUI + kijai WanVideoWrapper).
2. Pod cuts the clip into 5 s pieces (81 frames @16 fps).
3. Captioner: Qwen3-VL abliterated (prithivMLmods/Qwen3-VL-8B-Instruct-abliterated-v2 or -32B; 8B-Thinking GGUF says video support).
   Structured description per piece: positions, motion, tempo, camera. Shown to the USER (editable), not to Claude.
4. Motion guide: DWPose skeleton per frame (comfyui_controlnet_aux) -> Wan 2.2 Fun Control 14B (Comfy-Org/Wan_2.2_ComfyUI_Repackaged:
   wan2.2_fun_control_{high,low}_noise_14B_fp8_scaled, wan_2.1_vae, umt5_xxl_fp8_e4m3fn_scaled; optional Lightning LoRA).
5. Character: (a) start frame per piece from the Characters engine (Krea + GTA LoRA + keep-it-nude, depth from Pose mode),
   or (b) a Wan 2.2 character LoRA trained from ~20-30 Krea pictures (low-noise expert first; benchmark s/step before a full run).
6. Pieces chained (last frame -> next start), stitched, uploaded to the app + B2.
## Build steps
A. Standalone pod script, 1 x 5 s piece, paid test (~$0.15-0.25, ask first). B. App page + API. C. LoRA trainer (optional).
## Prices seen 2026-11-16 (RunPod live catalog, SECURE): H100 SXM $4.39 (HIGH), H200 SXM $5.29 (HIGH), RTX PRO 6000 96GB $2.69 (HIGH), A100 SXM $2.19, B200 $7.99 (LOW).

## Speed check DONE 2026-11-16 (H100 SXM secure $4.39/hr, pod qn8yo54peteana, ~18 min, ~$1.30)
- musubi-tuner f8a1b03, Wan 2.2 T2V low-noise 14B fp16 (Comfy-Org repackaged), wan_2.1_vae, umt5 bf16 .pth; 24 stills 768x1152, rank 32, adamw8bit, lr 1e-4, gradient checkpointing, no fp8.
- RESULT: 1.17 s/step. 1500 steps ~29 min, 2000 ~39 min. Downloads ~40 GB took 9.5 min (~70 MB/s).
- Gotchas: runpod/pytorch image lacks torchvision (install from the cu128 index; it upgrades torch to 2.11 -> then `pip uninstall torchaudio`);
  fp16 DiT needs --mixed_precision fp16 (both accelerate and script); never pkill/pgrep -f over ssh (matches the ssh command; use a script file).
- Full LoRA estimate on H100: setup ~12 min + training 30-40 min = ~45-55 min, ~$3.30-4.00. Faster: --fp8_base or fewer steps; or B200.
