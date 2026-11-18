#!/usr/bin/env bash
# Running total of RunPod spend across ALL runs, stored in B2 (ledger.csv), so the
# $45 lasts many renders instead of one.
#   ledger.sh check <stage_cap_usd>   -> exit 1 if total + this stage's cap would pass TOTAL_BUDGET_USD
#   ledger.sh add <usd> <note>        -> append a line after a pod finishes
#   ledger.sh show                    -> print total and remaining
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; set -a; source "$HERE/config.env"; set +a
L=/tmp/ledger.csv
b2 file download --no-progress "b2://$B2_BUCKET/ledger/ledger.csv" $L >/dev/null 2>&1 || echo "date,job,stage,usd" > $L
total () { python3 -c "import csv;print(round(sum(float(r['usd']) for r in csv.DictReader(open('$L'))),2))"; }
case "${1:-show}" in
  check)
    T=$(total); NEED="$2"
    if python3 -c "import sys; sys.exit(0 if $T + $NEED <= $TOTAL_BUDGET_USD else 1)"; then
      echo "[ledger] spent \$$T of \$$TOTAL_BUDGET_USD — ok to start (this stage capped at \$$NEED)"
    else
      echo "[ledger] spent \$$T of \$$TOTAL_BUDGET_USD — starting this stage could pass the budget. Stopping."; exit 1
    fi ;;
  add)
    echo "$(date -u +%F_%H:%M),$JOB_NAME,${3:-stage},$2" >> $L
    b2 file upload --no-progress "$B2_BUCKET" $L ledger/ledger.csv >/dev/null
    echo "[ledger] +\$$2 -> total \$$(total) of \$$TOTAL_BUDGET_USD" ;;
  show)
    T=$(total); echo "spent \$$T, remaining \$$(python3 -c "print(round($TOTAL_BUDGET_USD-$T,2))")" ;;
esac
