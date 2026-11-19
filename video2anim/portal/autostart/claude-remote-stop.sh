#!/data/data/com.termux/files/usr/bin/bash
# Home-screen button (Termux:Widget): stop Claude Code Remote Control (and the sessions it runs).
proot-distro login ubuntu -- bash -c 'for p in $(ps -eo pid,args | awk "\$2 ~ /claude\$/ && \$3 == \"remote-control\" {print \$1}"); do kill "$p" 2>/dev/null; done; echo stopped'
command -v termux-toast >/dev/null && termux-toast "Claude remote stopped" || true
