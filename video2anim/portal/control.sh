#!/bin/bash
# On/off for everything the owner runs on the phone (inside Ubuntu):
#   control.sh start   -> assistant app, video2anim portal and the pod guard (each only if not already running)
#   control.sh stop    -> deletes any video2anim GPU pod still running (nothing would watch it), then stops
#                         the portal and the pod guard. The assistant app is left running.
#   control.sh status  -> what's running
# Used by the home-screen buttons (Termux:Widget, portal/autostart/install-buttons.sh) and at phone start-up.
set -a; [ -f ~/.cloud-keys/credentials.env ] && . ~/.cloud-keys/credentials.env; set +a
HERE="$(cd "$(dirname "$0")" && pwd)"
up () { curl -s -m 3 -o /dev/null "$1"; }
pids () { ps -eo pid,args | awk -v re="$1" '$0 ~ re {print $1}'; }   # process ids whose command line matches
portal_re='^ *[0-9]+ python3 .*portal/server[.]py'
guard_re='^ *[0-9]+ bash .*portal/pod_guard[.]sh'

status () {
	echo "assistant app: $(up http://127.0.0.1:8400/api/system && echo running || echo stopped)"
	echo "video2anim portal: $(up http://127.0.0.1:8090/ && echo running || echo stopped)"
	echo "pod guard: $([ -n "$(pids "$guard_re")" ] && echo running || echo stopped)"
}

case "${1:-status}" in
start)
	if ! up http://127.0.0.1:8400/api/system && [ -x ~/assistant-app/controller/bin/keep-running.sh ]; then
		(setsid nohup ~/assistant-app/controller/bin/keep-running.sh >/dev/null 2>&1 &)
	fi
	up http://127.0.0.1:8090/ || bash "$HERE/start.sh" >/dev/null 2>&1
	[ -n "$(pids "$guard_re")" ] || (setsid nohup bash "$HERE/pod_guard.sh" 170 >> ~/v2a_pod_guard.log 2>&1 &)
	for i in $(seq 20); do up http://127.0.0.1:8090/ && up http://127.0.0.1:8400/api/system && break; sleep 2; done
	status ;;
stop)
	# a GPU pod with nobody watching would keep charging: delete video2anim pods first
	curl -s -m 30 -H "Authorization: Bearer $RUNPOD_API_KEY" https://api.runpod.io/v2/pods | python3 -c "
import json, sys
try: print('\n'.join(p['id'] for p in json.load(sys.stdin).get('pods', []) if str(p.get('name', '')).startswith('v2a-')))
except Exception: pass" | while read -r id; do
		[ -n "$id" ] && echo "deleting pod $id: $(curl -s -m 30 -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $RUNPOD_API_KEY" "https://api.runpod.io/v2/pods/$id")"
	done
	for p in $(pids "$guard_re") $(pids "$portal_re"); do kill "$p" 2>/dev/null; done
	sleep 1; status ;;
*) status ;;
esac
