# The private brain's start-up script, run on the rented machine (engine-brain image).
# Order matters: the tiny status server starts first, so the app hears from the machine within
# seconds of it booting, and the machine keeps reporting (every 2 s) until it is deleted.
#
# Inputs (environment, set by the app; never any of the owner's keys):
#   MODEL_URL MODEL_FILE MODEL_BYTES   the GGUF file to serve and its exact size
#   STORE                              "volume" (the owner's network volume at /workspace) or "disk"
#   CTX                                context length
#   LLAMA_API_KEY                      random per-pod key that chat requests must carry
#   POD_SECONDS                        lifetime: the machine deletes itself when it runs out
#   STATUS_KEY                         random per-pod key for extending that lifetime
# RunPod injects RUNPOD_POD_ID and a pod-scoped RUNPOD_API_KEY, used only to delete this pod.
#
# The status server (port 8081) serves:
#   /state    "stage done total speed time"   (stage: starting downloading loading ready failed)
#   /events   one line per event: "<unix time> <text>"
#   /cgi-bin/extend   POST "<STATUS_KEY> <unix time>" moves the self-delete time

W=/srv/www
mkdir -p "$W/cgi-bin"
: > "$W/events"
STAGE=starting DONE=0 TOTAL=${MODEL_BYTES:-0} SPEED=0
ev() { echo "$(date +%s) $*" >> "$W/events"; }
state() { echo "$STAGE $DONE $TOTAL $SPEED $(date +%s)" > "$W/state.tmp" && mv "$W/state.tmp" "$W/state"; }
state
busybox httpd -p 8081 -h "$W"

# Self-delete: at the deadline, or at once after a failure, so a broken start never keeps charging.
echo $(( $(date +%s) + ${POD_SECONDS:-1800} )) > /tmp/deadline
delete_me() {
	curl -s -m 20 -X DELETE "https://api.runpod.io/v2/pods/$RUNPOD_POD_ID" -H "Authorization: Bearer $RUNPOD_API_KEY" >/dev/null
	command -v runpodctl >/dev/null && runpodctl pod delete "$RUNPOD_POD_ID" >/dev/null 2>&1
}
( while [ "$(date +%s)" -lt "$(cat /tmp/deadline)" ]; do sleep 10; done; ev "Time limit reached: the machine is deleting itself"; delete_me ) &
cat > "$W/cgi-bin/extend" <<'CGI'
#!/bin/sh
read -r key until
echo "Content-Type: text/plain"; echo
if [ -n "$STATUS_KEY" ] && [ "$key" = "$STATUS_KEY" ] && [ "$until" -gt 0 ] 2>/dev/null; then
	echo "$until" > /tmp/deadline; echo "$(date +%s) Session extended on the machine too" >> /srv/www/events; echo ok
else echo refused; fi
CGI
chmod +x "$W/cgi-bin/extend"
fail() { STAGE=failed; state; ev "FAILED: $*"; ev "Deleting the machine so it stops charging"; sleep 20; delete_me; sleep infinity; }

GPU=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1)
ev "Machine is up: ${GPU:-GPU not visible}"
[ -n "$GPU" ] || fail "no GPU visible on this machine"

if [ "$STORE" = volume ]; then DIR=/workspace/models; else DIR=/root/models; fi
mkdir -p "$DIR" || fail "cannot write to $DIR"
F="$DIR/$MODEL_FILE"
GB=$(awk "BEGIN { printf \"%.1f\", $TOTAL / 1e9 }")

if [ -f "$F.done" ] && [ "$(stat -c %s "$F" 2>/dev/null)" = "$TOTAL" ]; then
	ev "Model already on your storage ($GB GB): no download needed"
	DONE=$TOTAL
else
	# A 25 GB volume holds one model: make room by removing any other.
	for g in "$DIR"/*.gguf; do
		[ -e "$g" ] || continue
		[ "$g" = "$F" ] && continue
		rm -f "$g" "$g.done" "$g.aria2"; ev "Removed $(basename "$g") from storage to make room"
	done
	[ -f "$F.aria2" ] && ev "Resuming an earlier partial download"
	[ "$STORE" = volume ] && ev "Downloading $GB GB to your storage (only needed once)" || ev "Downloading $GB GB"
	STAGE=downloading; state
	SECRET=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
	aria2c --enable-rpc --rpc-listen-port=6800 --rpc-secret="$SECRET" --quiet=true \
		-x 16 -s 16 -k 32M --file-allocation=none --continue=true --auto-file-renaming=false --allow-overwrite=true \
		--max-tries=20 --retry-wait=3 --connect-timeout=20 --timeout=60 -d "$DIR" -o "$MODEL_FILE" "$MODEL_URL" &
	ARIA=$!
	rpc() { curl -s -m 5 http://127.0.0.1:6800/jsonrpc -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"aria2.$1\",\"params\":[\"token:$SECRET\"$2]}"; }
	num() { grep -o "\"$1\":\"[0-9]*\"" | head -1 | grep -o '[0-9]*'; }
	LAST_NOTE=0
	while :; do
		r=$(rpc tellActive ',["completedLength","totalLength","downloadSpeed"]')
		if echo "$r" | grep -q completedLength; then
			DONE=$(echo "$r" | num completedLength); SPEED=$(echo "$r" | num downloadSpeed)
			t=$(echo "$r" | num totalLength); [ "${t:-0}" -gt 0 ] && TOTAL=$t
			state
			now=$(date +%s); if [ $((now - LAST_NOTE)) -ge 30 ]; then LAST_NOTE=$now; ev "Downloading $(awk "BEGIN { printf \"%.1f/%.1f GB at %.0f MB/s\", $DONE/1e9, $TOTAL/1e9, $SPEED/1e6 }")"; fi
		else
			s=$(rpc tellStopped ',0,1,["status","errorMessage","completedLength"]')
			if echo "$s" | grep -q '"status":"complete"'; then break; fi
			if echo "$s" | grep -q '"status":"error"'; then fail "download error: $(echo "$s" | grep -o '"errorMessage":"[^"]*"' | head -1)"; fi
			kill -0 $ARIA 2>/dev/null || fail "the downloader stopped unexpectedly"
		fi
		sleep 2
	done
	kill $ARIA 2>/dev/null
	[ "$(stat -c %s "$F")" = "$TOTAL" ] || fail "downloaded file has the wrong size"
	touch "$F.done"; DONE=$TOTAL; SPEED=0
	ev "Download finished: $GB GB"
fi

STAGE=loading; state
ev "Loading the model into the GPU"
LOAD_START=$(date +%s)
/app/llama-server -m "$F" --host 0.0.0.0 --port 8080 -ngl all -c "${CTX:-16384}" -a brain > /tmp/llama.log 2>&1 &
LP=$!
while :; do
	code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:8080/health)
	if [ "$code" = 200 ]; then break; fi
	kill -0 $LP 2>/dev/null || fail "the model did not load: $(grep -iE 'error|fail|out of memory' /tmp/llama.log | tail -2 | tr '\n' ' ' | cut -c1-200)"
	state; sleep 2
done
STAGE=ready; state
ev "Ready: loaded in $(( $(date +%s) - LOAD_START )) s"
while kill -0 $LP 2>/dev/null; do state; sleep 2; done
fail "the model server stopped: $(tail -2 /tmp/llama.log | tr '\n' ' ' | cut -c1-200)"
