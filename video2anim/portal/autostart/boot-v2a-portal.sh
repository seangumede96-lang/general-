#!/data/data/com.termux/files/usr/bin/sh
# Termux:Boot runs this when the phone turns on. It keeps the phone awake enough for
# the portal, then starts the portal in the same place Claude Code runs (proot Ubuntu
# if you use it, plain Termux otherwise), loading your saved keys first.
termux-wake-lock
sleep 20                                   # give Wi-Fi a moment after boot
LOG=$HOME/v2a_boot.log
echo "boot $(date)" >> "$LOG"
RUN='bash ~/general-/video2anim/portal/control.sh start'   # assistant app + portal + pod guard (keys loaded inside)
if command -v proot-distro >/dev/null 2>&1 && proot-distro list 2>/dev/null | grep -qi "ubuntu.*installed\|Installed.*ubuntu" \
   || [ -d "$PREFIX/var/lib/proot-distro/installed-rootfs/ubuntu" ]; then
  nohup proot-distro login ubuntu -- bash -c "$RUN" >> "$LOG" 2>&1 &
else
  nohup bash -c "$RUN" >> "$LOG" 2>&1 &
fi
