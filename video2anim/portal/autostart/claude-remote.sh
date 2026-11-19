#!/data/data/com.termux/files/usr/bin/bash
# Home-screen button (Termux:Widget): start Claude Code Remote Control in Ubuntu, in the home folder
# (so the project's CLAUDE.md and master plan load). Connect from the Claude app or claude.ai/code.
# This window must stay open (it can be in the background); closing it or "Stop Claude remote" ends it.
termux-wake-lock
echo "Starting Claude Remote Control... (keep this window; connect from the Claude app -> Code)"
exec proot-distro login ubuntu -- bash -lc 'cd /root && exec /root/.local/bin/claude remote-control --name phone'
