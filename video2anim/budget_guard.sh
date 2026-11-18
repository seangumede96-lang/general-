#!/usr/bin/env bash
# Runs in the background on a pod. Kills the pod once its spend passes the cap,
# after pushing whatever results exist to B2 so nothing is lost.
# usage: budget_guard.sh <rate_usd_per_hr> <cap_usd> <local_dir_to_save> <b2_dest> <stage_name>
set -u
RATE="$1"; CAP="$2"; SAVE_DIR="$3"; DEST="$4"
START=$(date +%s)
while true; do
  sleep 60
  NOW=$(date +%s)
  SPENT=$(python3 -c "print(round(($NOW-$START)/3600*$RATE,2))")
  echo "$SPENT" > /tmp/spent_usd
  OVER=$(python3 -c "print(1 if $SPENT >= $CAP else 0)")
  if [ "$OVER" = "1" ]; then
    echo "[budget_guard] spent \$$SPENT >= cap \$$CAP — saving and removing pod" | tee -a /tmp/pipeline.log
    b2 sync --no-progress "$SAVE_DIR" "b2://$DEST" || true
    b2 file upload --no-progress "${DEST%%/*}" /tmp/pipeline.log "${DEST#*/}/pipeline.log" || true
    bash "$(dirname "$0")/ledger.sh" add "$SPENT" "${5:-stage}-CAPPED" || true
    runpodctl remove pod "$RUNPOD_POD_ID"
    exit 0
  fi
done
