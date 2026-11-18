# video2anim: notes for any Claude session working here

The owner isn't technical and doesn't want to relay messages between Claude sessions.
Two Claude sessions work on this folder: one in the Claude app (no access to the phone or the accounts)
and Claude Code on the phone (Termux, has the RunPod/B2/HF keys in ~/.cloud-keys/credentials.env).

How we stay in sync without the owner copy-pasting:
- **Code**: both sessions commit to the `video2anim` branch of this repo. The portal on the phone pulls it every
  3 minutes and restarts itself when nothing is running (`auto_update` in portal/server.py).
- **What happened on the phone**: the portal writes to the private B2 bucket (never to this public repo, since logs may hold private details):
  `reports/selftest_quick.json`, `reports/selftest_pod.json`, `reports/last_failure.json`.
- **Open tasks / messages between sessions**: `HANDOFF.md` in this folder. Read it at the start of a session and
  tick off or add to it before you finish.

Rules: never open or view the input videos (they stay sealed); never put keys in this repo (it's public);
never give pods the RunPod key or the main B2 key; ask the owner before anything that spends more than a few cents.
