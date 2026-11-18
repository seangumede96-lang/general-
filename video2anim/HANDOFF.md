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
(none yet)
