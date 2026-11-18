# sourced by the stage scripts on a pod.
# st <stage_key> "<what is happening>" [percent] [force]
# Writes jobs/<job>/status.json + log tail to B2 so the phone portal can show live progress.
ST_LAST=0
st () {
  local key="$1" msg="$2" pct="${3:-}" force="${4:-}"
  echo "== [$key] $msg ${pct:+($pct%)}"
  local now; now=$(date +%s)
  if [ -z "$force" ] && [ $(( now - ST_LAST )) -lt 20 ]; then return 0; fi
  ST_LAST=$now
  python3 - "$key" "$msg" "$pct" <<'PY' > /tmp/status.json
import json, sys, os, time
k, m, p = sys.argv[1:4]
spent = open("/tmp/spent_usd").read().strip() if os.path.exists("/tmp/spent_usd") else "0"
print(json.dumps({"stage": k, "msg": m, "pct": float(p) if p else None, "pod_spent": float(spent),
                  "pod": os.environ.get("RUNPOD_POD_ID"), "ts": int(time.time())}))
PY
  tail -n 60 /tmp/pipeline.log > /tmp/log_tail.txt 2>/dev/null || true
  ( b2 file upload --no-progress --quiet "$B2_BUCKET" /tmp/status.json "jobs/$JOB_NAME/status.json" >/dev/null 2>&1
    b2 file upload --no-progress --quiet "$B2_BUCKET" /tmp/log_tail.txt "jobs/$JOB_NAME/log_tail.txt" >/dev/null 2>&1 ) &
}
# any crash -> tell the portal, save the log, record spend, delete the pod (no idle billing)
on_fail () {
  trap - ERR
  st failed "Stopped with an error near line $1 — log saved" "" force; sleep 5
  b2 file upload --no-progress "$B2_BUCKET" /tmp/pipeline.log "jobs/$JOB_NAME/failed_$(date +%s).log" >/dev/null 2>&1 || true
  bash "$HERE/ledger.sh" add "$(cat /tmp/spent_usd 2>/dev/null || echo 0.05)" failed || true
  type selfdestruct >/dev/null 2>&1 && selfdestruct
  exit 1
}
trap 'on_fail $LINENO' ERR
