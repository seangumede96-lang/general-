#!/data/data/com.termux/files/usr/bin/bash
# Home-screen button (Termux:Widget): start the assistant app, video2anim portal and pod guard, then open the portal.
termux-wake-lock
echo "start $(date)" >> ~/v2a_widget.log
nohup proot-distro login ubuntu -- bash /root/general-/video2anim/portal/control.sh start >> ~/v2a_widget.log 2>&1 &
for i in $(seq 30); do curl -s -m 2 -o /dev/null http://127.0.0.1:8090/ && break; sleep 2; done
termux-open-url http://127.0.0.1:8090
