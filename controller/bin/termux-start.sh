#!/data/data/com.termux/files/usr/bin/bash
# Run from Termux itself (not inside Ubuntu). Starts the assistant app if it is not already
# answering, and keeps the phone from putting Termux to sleep. Safe to run any number of times.
#
# Hook it up once so it runs by itself:
#   - when Termux opens:  echo 'bash ~/termux-start.sh' >> ~/.bashrc
#   - when the phone starts (needs the Termux:Boot app, opened once):
#       mkdir -p ~/.termux/boot && cp ~/termux-start.sh ~/.termux/boot/start-assistant
DISTRO="${ASSISTANT_DISTRO:-ubuntu}"
APP_DIR="${ASSISTANT_APP_DIR:-/root/assistant-app/controller}"
termux-wake-lock 2>/dev/null
if curl -s -m 2 -o /dev/null http://127.0.0.1:8400/api/system 2>/dev/null; then exit 0; fi
nohup proot-distro login "$DISTRO" -- bash "$APP_DIR/bin/keep-running.sh" >/dev/null 2>&1 &
echo "Assistant app starting. Open http://127.0.0.1:8400 in a few seconds."
