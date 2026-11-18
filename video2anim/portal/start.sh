#!/usr/bin/env bash
# Start the portal on the phone (run it from the same Termux/Ubuntu shell where your keys load).
cd "$(dirname "$0")"
command -v termux-wake-lock >/dev/null && termux-wake-lock
pip install -q b2 2>/dev/null || true
pkill -f "portal/server.py" 2>/dev/null; sleep 1
nohup python3 "$(pwd)/server.py" > ~/v2a_portal.log 2>&1 &
sleep 2
echo "Portal running → open http://127.0.0.1:8090 in Chrome, then menu ⋮ → 'Install app' (or 'Add to Home screen')"
(command -v termux-open-url >/dev/null && termux-open-url http://127.0.0.1:8090) || true
