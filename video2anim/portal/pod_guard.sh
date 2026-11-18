#!/bin/bash
# Phone-side backstop for video2anim pods, independent of Claude and of the portal.
# Every minute: any pod named v2a-* is deleted when
#   - the portal is no longer running (nothing else would delete it), or
#   - it has run longer than MAX_MIN minutes (default 170: the mocap step's $6 cap at ~$2.19/h).
# Usage: nohup bash pod_guard.sh [MAX_MIN] >> ~/v2a_pod_guard.log 2>&1 &
set -a; . ~/.cloud-keys/credentials.env 2>/dev/null; set +a
MAX_MIN=${1:-170}
echo "$(date '+%F %T') guard started (max ${MAX_MIN} min per pod)"
while true; do
	pods=$(curl -s -m 30 -H "Authorization: Bearer $RUNPOD_API_KEY" https://api.runpod.io/v2/pods)
	echo "$pods" | python3 -c "
import json, sys, datetime
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
now = datetime.datetime.now(datetime.timezone.utc)
for p in d.get('pods', []):
    if not str(p.get('name', '')).startswith('v2a-'): continue
    t = p.get('createdAt') or p.get('lastStartedAt') or ''
    try: age = (now - datetime.datetime.fromisoformat(t.replace('Z', '+00:00'))).total_seconds() / 60
    except Exception: age = 0
    print(p['id'], int(age))" | while read -r id age; do
		reason=""
		# the portal's process (python3 .../portal/server.py); matched on its own process list entry only
		if ! ps -eo args | grep -q "^python3 .*portal/server\.py"; then reason="portal not running"; fi
		[ "$age" -ge "$MAX_MIN" ] && reason="ran ${age} min (limit ${MAX_MIN})"
		if [ -n "$reason" ]; then
			code=$(curl -s -m 30 -o /dev/null -w "%{http_code}" -X DELETE -H "Authorization: Bearer $RUNPOD_API_KEY" "https://api.runpod.io/v2/pods/$id")
			echo "$(date '+%F %T') deleted pod $id ($reason) -> HTTP $code"
		fi
	done
	sleep 60
done
