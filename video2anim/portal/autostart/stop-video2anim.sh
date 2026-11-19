#!/data/data/com.termux/files/usr/bin/bash
# Home-screen button (Termux:Widget): delete any video2anim GPU pod still running, then stop the portal and pod guard.
echo "stop $(date)" >> ~/v2a_widget.log
proot-distro login ubuntu -- bash /root/general-/video2anim/portal/control.sh stop >> ~/v2a_widget.log 2>&1
command -v termux-toast >/dev/null && termux-toast "video2anim stopped" || true
