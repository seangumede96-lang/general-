# Handoff between Claude sessions

## 2026-11-18 09:30, from the Claude app session → phone Claude Code

What the owner saw: run "1000218860" stopped with `Couldn't reach RunPod... [Errno -2] Name or service not known`,
the pods list showed the same error, and "Ask Claude to fix" said `No such file or directory: 'claude'`.
B2 kept working the whole time, so the phone's DNS seems to fail for rest.runpod.io specifically.

Changed in portal/server.py (pushed):
1. DNS fallback: if the phone can't look up a host, the portal asks Cloudflare/Google DNS-over-HTTPS by IP.
   A failed lookup never reached RunPod, so a pod start is retried in that case only. Your no-double-start rule is kept for other errors.
2. `claude_bin()` finds Claude Code even when the portal started at boot with a bare PATH. If it still can't,
   put `CLAUDE_BIN=/full/path/to/claude` in ~/.cloud-keys/credentials.env.
3. The budget card shows the **real RunPod balance** (GraphQL `myself { clientBalance currentSpendPerHr }`). A stage won't start if the balance is below its cap.
4. Self-test: a button in the portal, or `python3 portal/server.py --selftest [--pod]`. `--pod` starts and deletes a real cheap GPU pod (~$0.01).
5. Auto-update from this branch every 3 minutes.

Please do, in order:
- [ ] `git pull` in ~/general-, restart the portal once by hand (later updates restart it by themselves).
- [ ] Run `python3 video2anim/portal/server.py --selftest`. Fix anything that fails, commit and push.
      If `Find rest.runpod.io` fails even with the fallback, check `cat /etc/resolv.conf` (proot) and Android Private DNS.
- [ ] Run the `--selftest --pod` once (the owner has agreed to the ~$0.01 test).
- [ ] RunPod REST v1 is retired on 2026-12-01. Move `rp()`, `launch()`, `watch()`, `kill()` and the pods list to
      REST v2 (`https://api.runpod.io/v2`), which is on the same host as GraphQL. Mapping: gpuTypeIds→`gpu.id` (one type per request,
      loop the list), cloudType→`cloud`, imageName→`image`, containerDiskInGb→`disk`, dockerStartCmd→`cmd` (array),
      desiredStatus→`status`, list returns `{"pods":[...]}` and is paginated, unknown body fields give a 422. Test it live with `--pod`.
- [ ] Then start one real **Preview a look** run (cheapest) on the owner's last uploaded video and fix what breaks.
- [ ] Write what you found and changed below, under a new heading, and push.

## Replies from phone Claude Code

### 2026-11-18, phone Claude Code
Checked off:
- [x] Pulled and restarted the portal (by hand).
- [x] Self-test. Found and fixed:
  - **rest.runpod.io no longer exists.** Cloudflare and Google DNS-over-HTTPS both return NXDOMAIN for it, so the DNS fallback couldn't help; it's not the phone's DNS (resolv.conf is 8.8.8.8/8.8.4.4, and api.runpod.io resolves fine).
  - **Claude Code headless failed** because its default model (Fable 5.2) needs paid usage credits on this plan. Every `claude -p` call now passes `--model $CLAUDE_MODEL` (default `sonnet`); both sonnet and opus answer OK.
  - Also: the CLI sign-in ends between 2026-11-19 and 2026-11-22. Before then the owner has to run `claude auth login` or `claude setup-token` (interactive) so the portal's "Ask Claude" keeps working.
- [x] REST v2 migration (bbcba55):
  - `RUNPOD_API = https://api.runpod.io/v2`, the same pod API the assistant app uses.
  - `create_pod()` sends one GPU type per request and loops the list. Body: `{name, image, gpu:{id,count}, cloud:SECURE, disk, env, args: JSON{entrypoint:[bash,-c], cmd:[...]}}`. A 400 or 403 means that type isn't free, so it tries the next.
  - `list_pods()` follows `pagination.nextCursor`. `status`/`cost` replace `desiredStatus`/`costPerHr`.
  - The pod scripts' fallback delete URL was updated too.
  - GPU type ids are unchanged in v2.
- [x] `--selftest --pod`: everything PASS. The pod started in 68 s at $0.24/hr and was deleted, and no v2a pod is left.
  - (Seen at the time: the assistant app's own picture pod `assistant-images`, $0.59/h, started 09:35 by the app. Not touched.)
- [ ] Preview run: **not possible yet.** Neither job (`1000218860`, `Genesis_`) has stage-1 joints in B2. Both failed before any pod started, so Preview/Restyle has nothing to work on.
  - The cheapest real run is Full with preview-every-10: about $1.50-4 (mocap cap $6 + render cap $3, secure prices).
  - That's over the owner's $3-per-task "ask first" line, so I'm waiting for the owner's OK.

### 2026-11-18 later, phone Claude Code: first real run (owner approved)
- **Attempt 1 failed after ~2 min.** "Installing SAM-Body4D": the cu118 venv couldn't build detectron2 against the image's CUDA 12.4 compiler. Fixed in 975cf36: the image's own PyTorch, runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2404, plus PIP_BREAK_SYSTEM_PACKAGES for all pods.
- **Attempt 2: install and checkpoints OK** (23 GB, now cached in B2 cache/sam-body4d-ckpts). Tracking 783 frames took 51 s, but 4D generation ran at 8.7 min per 64-frame batch (6 of 13 batches in 52 min), so it would have passed the $6 cap. The owner chose to stop it at about $4.42.
- The person detector found one box covering most of the frame: [0,118,1126,713] on 1280x720. That's the same pattern as the 12 Nov video, so the tracks may merge.
- **Found while fixing:** the stock scripts/offline_app.py writes only .ply meshes (no .npz/.pkl), so export_joints.py would have found nothing at the end. It also renders overlay frames and an mp4 of the video.
- **Changed:**
  - stage1 now runs a data-only copy (patch_offline_app.py, from mocap-prep, 12 Nov): joints/<frame>.npz with pred_keypoints_3d per person, no overlay pictures or video, working frames deleted.
  - export_joints is checked on the 12 Nov joint files: 150 frames x 70 joints.
  - Occlusion completion is off in configs/body4d.yaml.
- Also added portal/pod_guard.sh (fa50b45): a phone-side backstop that deletes v2a-* pods if the portal stops, or after 170 min.
- Ledger corrected by hand: +$4.42 and +$0.08, total $4.55 of $45.

