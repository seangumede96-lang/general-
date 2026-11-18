#!/bin/bash
# Keeps the assistant controller running inside the Linux environment (Ubuntu in Termux).
# If the app stops for any reason it is started again within a few seconds, and every stop
# is written to restarts.log with the time and exit code, so causes can be found later.
# Only one copy of this script can run at a time; starting it again does nothing.
cd "$(dirname "$0")/.." || exit 1
DATA="${ASSISTANT_DATA_DIR:-$HOME/.assistant-controller}"
PORT="${PORT:-8400}"
mkdir -p "$DATA"
exec 9>"$DATA/keep-running.lock"
if ! flock -n 9; then echo "The app is already being kept running."; exit 0; fi
echo "Keeping the app running on port $PORT. Log: $DATA/controller.log"
while true; do
	# Another copy already answering (for example one started by hand): leave it alone.
	if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/system"; then sleep 15; continue; fi
	echo "$(date '+%F %T') starting" >> "$DATA/restarts.log"
	node src/cli.js >> "$DATA/controller.log" 2>&1
	code=$?
	echo "$(date '+%F %T') stopped, exit code $code" >> "$DATA/restarts.log"
	sleep 3
done
