#!/usr/bin/env python3
"""video2anim portal — runs on your phone (Termux), opens in the phone browser.

  python3 portal/server.py         then open http://127.0.0.1:8090

You press Start; this server uploads the code to B2, starts each RunPod pod in turn,
watches the live status each pod writes to B2, deletes pods that overrun, and shows
everything (stage, progress, spend, log, results) on one page. Standard library only.
Keys come from the environment you already set up in Termux:
  RUNPOD_API_KEY, B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, HF_TOKEN
"""
import json, os, re, shutil, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote
import socket

# ---- phone DNS sometimes can't find a host (e.g. rest.runpod.io) while others work.
# Fall back to DNS-over-HTTPS by IP (Cloudflare, Google), so no DNS lookup is needed for the fallback itself.
# TLS still checks the real hostname's certificate.
_orig_gai = socket.getaddrinfo
_doh_cache = {}


def _doh(host):
    for url in ("https://1.1.1.1/dns-query?name={}&type=A", "https://8.8.8.8/resolve?name={}&type=A"):
        try:
            req = urllib.request.Request(url.format(host), headers={"accept": "application/dns-json"})
            with urllib.request.urlopen(req, timeout=8) as r:
                ips = [a["data"] for a in json.load(r).get("Answer", []) if a.get("type") == 1]
            if ips: return ips
        except Exception:
            pass
    return []


def _gai(host, *a, **k):
    try:
        return _orig_gai(host, *a, **k)
    except socket.gaierror:
        if not host or re.match(r"^[\d.:]+$", str(host)): raise
        ips = _doh_cache.get(host) or _doh(host)
        if not ips: raise
        _doh_cache[host] = ips
        return _orig_gai(ips[0], *a, **k)


socket.getaddrinfo = _gai

HERE = os.path.dirname(os.path.abspath(__file__))
CODE = os.path.dirname(HERE)                       # the video2anim folder
STATE_FILE = os.path.expanduser("~/.v2a_portal_state.json")
PORT = int(os.environ.get("V2A_PORT", 8090))


def cfg():
    """Read config.env defaults (simple KEY=value / KEY="${KEY:-value}")."""
    out = {}
    for line in open(os.path.join(CODE, "config.env")):
        m = re.match(r'^([A-Z0-9_]+)=("?)(.*?)\2(\s+#.*)?$', line.strip())
        if m:
            v = m.group(3)
            d = re.match(r'^\$\{[A-Z0-9_]+:-(.*)\}$', v)
            out[m.group(1)] = d.group(1) if d else v
    return out


C = cfg()
BUCKET = C["B2_BUCKET"]
TOTAL = float(C["TOTAL_BUDGET_USD"])


def env(*names):
    for n in names:
        if os.environ.get(n): return os.environ[n]
    return ""


KEYS = {
    "RUNPOD_API_KEY": env("RUNPOD_API_KEY"),
    "B2_APPLICATION_KEY_ID": env("B2_APPLICATION_KEY_ID", "B2_KEY_ID"),
    "B2_APPLICATION_KEY": env("B2_APPLICATION_KEY", "B2_APP_KEY"),
    "HF_TOKEN": env("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"),
}
os.environ.setdefault("B2_APPLICATION_KEY_ID", KEYS["B2_APPLICATION_KEY_ID"])
os.environ.setdefault("B2_APPLICATION_KEY", KEYS["B2_APPLICATION_KEY"])

# ---------------- B2 helpers (b2 CLI) ----------------
def b2(*args, timeout=600):
    r = subprocess.run(["b2", *args], capture_output=True, text=True, timeout=timeout)
    if r.returncode: raise RuntimeError((r.stderr or r.stdout).strip()[-400:])
    return r.stdout


def b2_ls(prefix):
    try:
        out = b2("ls", f"b2://{BUCKET}/{prefix}")
        return [l.strip().rstrip("/").split("/")[-1] for l in out.splitlines() if l.strip()]
    except Exception:
        return []


def b2_read(path):
    fd, tmp = tempfile.mkstemp(); os.close(fd)
    try:
        b2("file", "download", "--no-progress", f"b2://{BUCKET}/{path}", tmp, timeout=60)
        return open(tmp, encoding="utf-8", errors="replace").read()
    except Exception:
        return None
    finally:
        os.path.exists(tmp) and os.remove(tmp)


def b2_write(path, text):
    fd, tmp = tempfile.mkstemp(); os.write(fd, text.encode()); os.close(fd)
    try: b2("file", "upload", "--no-progress", "--quiet", BUCKET, tmp, path, timeout=60)
    finally: os.remove(tmp)


# ---------------- RunPod REST ----------------
RUNPOD_API = "https://api.runpod.io/v2"   # RunPod's pod API (rest.runpod.io/v1 is gone: the name no longer exists)


class PodUnavailable(RuntimeError):
    """This GPU type has no free machine right now (RunPod answers 400/403): try the next type."""


def rp(method, path, body=None):
    req = urllib.request.Request(RUNPOD_API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {KEYS['RUNPOD_API_KEY']}",
                                          "Content-Type": "application/json"})
    for attempt in range(4):              # phone data drops out now and then: retry before giving up
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                t = r.read().decode(); return json.loads(t) if t else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:300]
            if method == "POST" and path == "/pods" and e.code in (400, 403): raise PodUnavailable(f"RunPod {e.code}: {detail}")
            raise RuntimeError(f"RunPod {e.code}: {detail}")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            never_sent = isinstance(getattr(e, "reason", None), socket.gaierror)   # name lookup failed: nothing reached RunPod
            if never_sent and attempt < 3:
                time.sleep(3 * (attempt + 1)); continue
            # Never repeat a pod start: the first request may have reached RunPod, and a second
            # would rent (and charge for) another GPU.
            if method == "POST" and path == "/pods":
                raise RuntimeError(f"Couldn't reach RunPod to start the pod (phone internet dropped?): {getattr(e, 'reason', e)}. Check the RunPod app for a v2a- pod before pressing Start again.")
            if attempt == 3:
                raise RuntimeError(f"Couldn't reach RunPod (phone internet dropped?): {getattr(e, 'reason', e)}")
            time.sleep(3 * (attempt + 1))


def create_pod(name, image, gpus, disk, env, cmd):
    """Start a pod on RunPod's own data centres (SECURE), trying the GPU types in order (v2 takes one
    type per request). cmd runs under bash. Returns the pod (id, cost = $/hr, status ...)."""
    last = None
    for g in gpus:
        try:
            return rp("POST", "/pods", {"name": name[:60], "image": image, "gpu": {"id": g, "count": 1},
                                        "cloud": "SECURE", "disk": disk, "env": env,
                                        "args": json.dumps({"entrypoint": ["bash", "-c"], "cmd": [cmd]})})
        except PodUnavailable as e:
            last = e
    raise RuntimeError(f"No free GPU of these types right now: {', '.join(gpus)} ({last})")


def list_pods():
    """Every pod on the account (the v2 list comes in pages)."""
    out, cursor = [], None
    for _ in range(20):
        r = rp("GET", "/pods" + (f"?cursor={urllib.parse.quote(cursor)}" if cursor else "")) or {}
        out += r.get("pods", []) if isinstance(r, dict) else r
        cursor = (r.get("pagination") or {}).get("nextCursor") if isinstance(r, dict) else None
        if not cursor: break
    return out


def runpod_balance():
    """Real account balance from RunPod (GraphQL `myself`)."""
    req = urllib.request.Request("https://api.runpod.io/graphql", method="POST",
                                 data=json.dumps({"query": "query { myself { clientBalance currentSpendPerHr } }"}).encode(),
                                 headers={"Authorization": f"Bearer {KEYS['RUNPOD_API_KEY']}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.load(r)
    me = (d.get("data") or {}).get("myself") or {}
    if "clientBalance" not in me: raise RuntimeError(str(d.get("errors") or d)[:200])
    return {"balance": round(float(me["clientBalance"]), 2), "spend_per_hr": round(float(me.get("currentSpendPerHr") or 0), 2)}


# Claude Code's default model (Fable 5.2) needs paid usage credits on the owner's plan; Sonnet is included.
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "sonnet")


def claude_bin():
    """Find Claude Code even when the portal was started at boot with a bare PATH."""
    cands = [os.environ.get("CLAUDE_BIN", ""), shutil.which("claude") or ""]
    home = os.path.expanduser("~"); pre = os.environ.get("PREFIX", "/data/data/com.termux/files/usr")
    cands += [f"{home}/.local/bin/claude", f"{home}/.claude/local/claude", f"{home}/.npm-global/bin/claude",
              "/usr/local/bin/claude", "/usr/bin/claude", f"{pre}/bin/claude", "/root/.local/bin/claude"]
    cands += sorted(__import__("glob").glob(f"{home}/.nvm/versions/node/*/bin/claude"))
    for c in cands:
        if c and os.path.isfile(c) and os.access(c, os.X_OK): return c
    try:   # last resort: ask a login shell, which loads the user's PATH
        out = subprocess.run(["bash", "-lc", "command -v claude"], capture_output=True, text=True, timeout=15).stdout.strip()
        if out: return out
    except Exception: pass
    raise RuntimeError("Claude Code ('claude') isn't installed where the portal can find it. "
                       "Set CLAUDE_BIN in ~/.cloud-keys/credentials.env to its full path.")


STAGE_POD = {
    "mocap":  {"script": "stage1_mocap.sh", "image": "runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2404", "gpus": ["NVIDIA A100 80GB PCIe", "NVIDIA A100-SXM4-80GB", "NVIDIA H100 PCIe"],
               "disk": 60, "rate": "STAGE1_RATE_USD_HR", "cap": "STAGE1_CAP_USD"},
    # The cheap mocap: SAM 2 follows each person the owner tapped, 4D-Humans reads each body (~$0.30-0.45 a run).
    "mocap4dh": {"script": "stage1_4dhumans.sh", "image": "runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2404",
                 "gpus": ["NVIDIA GeForce RTX 4090", "NVIDIA RTX A6000", "NVIDIA L40S", "NVIDIA RTX A5000"],
                 "disk": 40, "rate": "STAGE1B_RATE_USD_HR", "cap": "STAGE1B_CAP_USD"},
    "render": {"script": "stage2_render_style.sh", "gpus": ["NVIDIA GeForce RTX 4090", "NVIDIA RTX A6000", "NVIDIA L40S"],
               "disk": 80, "rate": "STAGE2_RATE_USD_HR", "cap": "STAGE2_CAP_USD"},
}
IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04"


def pod_keys(stage, job):
    """What a pod is given. Never the RunPod key (the phone deletes pods itself) and never the main
    Backblaze key: a new Backblaze key for this one bucket, without delete or key-management rights,
    that expires a little after the stage's spending cap would be reached. The Hugging Face token
    (read-only) only goes to the mocap stage, for the gated SAM models when they aren't cached in B2."""
    hours = float(C[STAGE_POD[stage]["cap"]]) / float(C[STAGE_POD[stage]["rate"]]) + 1
    out = b2("key", "create", "--bucket", BUCKET, "--duration", str(int(hours * 3600)),
             re.sub(r"[^A-Za-z0-9-]", "-", f"v2a-{stage}-{job}")[:50],   # B2 key names: letters, digits, '-' only
             "listBuckets,listFiles,readFiles,writeFiles", timeout=60).split()
    if len(out) < 2: raise RuntimeError("Couldn't make a limited Backblaze key for the pod")
    keys = {"B2_APPLICATION_KEY_ID": out[0], "B2_APPLICATION_KEY": out[1]}
    if stage == "mocap" and KEYS["HF_TOKEN"]: keys["HF_TOKEN"] = KEYS["HF_TOKEN"]
    return keys


def launch(stage, job_env):
    s = STAGE_POD[stage]
    cmd = (f"pip -q install b2 && b2 sync --no-progress b2://{BUCKET}/code/video2anim /workspace/v2a "
           f"&& bash /workspace/v2a/{s['script']}; sleep 30")
    # PIP_BREAK_SYSTEM_PACKAGES: newer (Ubuntu 24.04) images refuse system-wide pip installs without it.
    envs = {**pod_keys(stage, job_env["JOB_NAME"]), **job_env, "PIP_BREAK_SYSTEM_PACKAGES": "1"}
    # RunPod's own data centres only: community machines are run by strangers.
    try:
        return create_pod(f"v2a-{stage}-{job_env['JOB_NAME']}", s.get("image", IMAGE), s["gpus"], s["disk"], envs, cmd), "SECURE"
    except Exception as e:
        raise RuntimeError(f"Couldn't start a {stage} pod: {e}")


# ---------------- run state ----------------
lock = threading.Lock()
S = {"run": None, "status": None, "log": "", "lists": {}, "lists_ts": 0, "claude": None, "uploads": {}, "ref_desc": {}}
REF_DIR = os.path.expanduser("~/.v2a_refs"); os.makedirs(REF_DIR, exist_ok=True)
refresh_lock = threading.Lock()
IMG_EXT = (".png", ".jpg", ".jpeg", ".webp")
if os.path.exists(STATE_FILE):
    try: S["run"] = json.load(open(STATE_FILE))
    except Exception: pass


def save():
    with lock: json.dump(S["run"], open(STATE_FILE, "w"))


def note(msg, **kw):
    with lock:
        r = S["run"]; r["events"].append([int(time.time()), msg]); r.update(kw)
    save()


def ledger():
    txt = b2_read("ledger/ledger.csv") or "date,job,stage,usd\n"
    rows = [l.split(",") for l in txt.strip().splitlines()[1:] if l.count(",") >= 3]
    spent = round(sum(float(r[3]) for r in rows), 2)
    out = {"spent": spent, "remaining": round(TOTAL - spent, 2), "total": TOTAL, "rows": rows[-15:]}
    try:
        out.update(runpod_balance())                 # the real money in the RunPod account
    except Exception as e:
        out["balance_error"] = str(e)[:200]
    return out


def run_job(p):
    """Background thread: drives one run start to finish."""
    try:
        job = p["job"]
        char = p.get("character") or ""
        job_env = {"JOB_NAME": job, "INPUT_VIDEO": p.get("video", ""),
                   "CHARACTER_FILE": ("characters/" + char) if char else "",
                   "BONE_MAP": ("bone_maps/" + os.path.splitext(char)[0] + ".json") if char else "",
                   "REF_IMAGE": ("refs/" + p["ref"]) if p.get("ref") else "",
                   "LORA_FILE": p["lora"], "STYLE_PROMPT": p["prompt"], "STYLE_TAG": p["style_tag"],
                   "DENOISE": str(p["denoise"]), "PREVIEW_EVERY": str(p["preview_every"]),
                   "RESTYLE_ONLY": "1" if p["mode"] in ("restyle", "preview") else "0",
                   "PERSON_INDEX": str(p.get("person", 0))}
        for key in [k for k in (p.get("video"), ("refs/" + p["ref"]) if p.get("ref") else None) if k]:
            while (S["uploads"].get(key) or {}).get("state") == "uploading":
                if not S["run"]["events"] or "Waiting for" not in S["run"]["events"][-1][1]:
                    note(f"Waiting for {key.split('/')[-1]} to finish saving to B2", phase="prep")
                time.sleep(5)
            if (S["uploads"].get(key) or {}).get("state") == "error":
                raise RuntimeError(f"{key} didn't reach B2: {S['uploads'][key].get('error')}")
        note("Uploading the latest pipeline code to B2", phase="prep")
        b2("sync", "--no-progress", "--exclude-regex", r"(portal/.*|.*\.zip)", CODE, f"b2://{BUCKET}/code/video2anim")
        b2_write(f"jobs/{job}/status.json", json.dumps({"stage": "queued", "msg": "Waiting for first pod", "ts": int(time.time())}))
        mocap = "mocap4dh" if p.get("mocap") == "4dhumans" else "mocap"
        if p["mode"] == "full" and mocap == "mocap4dh":
            seeds = p.get("seeds") or {}
            if not [q for q in seeds.get("people", []) if q]:
                raise RuntimeError("4D-Humans needs each person marked: tap each person on the video first.")
            if not [f for f in b2_ls("smpl/") if f.lower().endswith((".zip", ".pkl"))]:
                raise RuntimeError("Upload the SMPL body file first (Mocap section, 'SMPL file').")
            b2_write(f"jobs/{job}/seeds.json", json.dumps({"t": float(seeds.get("t", 0)), "people": seeds["people"]}))
        stages = ([mocap] if p["mode"] == "full" else []) + ["render"]
        for stage in stages:
            if S["run"].get("cancel"): break
            led = ledger()
            cap_usd = float(C[STAGE_POD[stage]["cap"]])
            if led["spent"] + cap_usd > TOTAL:
                raise RuntimeError(f"Budget: ${led['spent']} spent of ${TOTAL}; this stage could pass it.")
            if "balance" in led and led["balance"] < cap_usd + 0.5:
                raise RuntimeError(f"RunPod balance is ${led['balance']:.2f}, less than this stage's ${cap_usd:.2f} cap. Top up first.")
            phase = "mocap" if stage.startswith("mocap") else stage
            note(f"Starting the {stage} pod on RunPod", phase=phase)
            pod, cloud = launch(stage, {**job_env, STAGE_POD[stage]["rate"]: str(C[STAGE_POD[stage]["rate"]])})
            pid = pod.get("id"); rate = float(pod.get("cost") or pod.get("costPerHr") or C[STAGE_POD[stage]["rate"]])
            note(f"{stage} pod {pid} started ({cloud.lower()} cloud, ${rate:.2f}/hr)", pod=pid, pod_rate=rate, pod_start=time.time())
            watch(job, stage, pid, rate)
        if S["run"].get("cancel"): note("Run stopped by you", phase="stopped")
        else: note("All done — your video is in Results", phase="done")
    except Exception as e:
        note(f"Problem: {e}", phase="failed", error=str(e), failed_at=S["run"].get("phase"))
        try:   # keep the details in your private B2 bucket, for Claude Code to read when fixing
            b2_write("reports/last_failure.json", json.dumps({"run": S["run"], "status": S["status"],
                     "log_tail": (S["log"] or "")[-6000:]}, indent=1, default=str))
        except Exception: pass
    finally:
        refresh_lists(force=True)


def watch(job, stage, pid, rate):
    cap = float(C[STAGE_POD[stage]["cap"]]) + 0.5          # phone-side backstop above the pod's own guard
    done_key = "mocap_done" if stage.startswith("mocap") else "done"
    gone = 0
    while True:
        time.sleep(15)
        st = b2_read(f"jobs/{job}/status.json")
        with lock:
            try: S["status"] = json.loads(st) if st else S["status"]
            except Exception: pass
            S["log"] = b2_read(f"jobs/{job}/log_tail.txt") or S["log"]
        stage_now = (S["status"] or {}).get("stage")
        # The phone deletes the pod itself (pods don't get the RunPod key).
        if stage_now == done_key: kill(pid); return
        if stage_now == "failed": kill(pid); raise RuntimeError((S["status"] or {}).get("msg", "pod reported a failure"))
        spent = (time.time() - S["run"]["pod_start"]) / 3600 * rate
        if S["run"].get("cancel") or spent > cap:
            kill(pid);
            if spent > cap: raise RuntimeError(f"{stage} pod passed its ${cap - 0.5:.2f} cap — deleted it")
            return
        try:
            info = rp("GET", f"/pods/{pid}"); gone = 0
            if (info.get("status") or info.get("desiredStatus")) in ("EXITED", "TERMINATED"): gone += 3
        except Exception:
            gone += 1
        if gone >= 3:
            time.sleep(20)       # let the final status upload land
            st = b2_read(f"jobs/{job}/status.json") or "{}"
            kill(pid)
            if json.loads(st).get("stage") == done_key: return
            raise RuntimeError(f"{stage} pod disappeared before finishing — check the log")


def kill(pid):
    try: rp("DELETE", f"/pods/{pid}"); note(f"Deleted pod {pid}")
    except Exception as e: note(f"Couldn't delete pod {pid}: {e} — delete it in the RunPod app!")


def refresh_lists(force=False):
    if not force and time.time() - S["lists_ts"] < 60: return
    if not refresh_lock.acquire(blocking=False): return          # one refresh at a time
    try: _refresh()
    finally: refresh_lock.release()


def _refresh():
    S["lists_ts"] = time.time()
    lists = {"results": results(S["run"]["job"]) if S["run"] else [],
             "refs": [f for f in b2_ls("refs/") if f.lower().endswith(IMG_EXT)],"characters": [f for f in b2_ls("characters/") if f.lower().endswith((".fbx", ".glb", ".gltf", ".blend"))],
             "bone_maps": b2_ls("bone_maps/"), "loras": [f for f in b2_ls("loras/") if f.endswith(".safetensors")],
             "smpl": [f for f in b2_ls("smpl/") if f.lower().endswith((".zip", ".pkl"))],
             "videos": b2_ls("input/"), "jobs": b2_ls("jobs/"), "ledger": ledger()}
    try:
        lists["pods"] = [{"id": x.get("id"), "name": x.get("name"), "status": x.get("status") or x.get("desiredStatus"),
                          "rate": x.get("cost") or x.get("costPerHr")} for x in list_pods()]
    except Exception as e:
        lists["pods"] = []; lists["pod_error"] = str(e)
    with lock: S["lists"], S["lists_ts"] = lists, time.time()


def results(job):
    out = []
    for sub in ("stage2",):
        for f in b2_ls(f"jobs/{job}/{sub}/"):
            if f.endswith(".mp4"): out.append(f"jobs/{job}/{sub}/{f}")
    return out


def ask_claude():
    r = S["run"] or {}
    log = (S["log"] or "")[-4000:]
    prompt = (f"The video2anim pipeline run '{r.get('job')}' failed. Error: {r.get('error')}\n"
              f"Last pod log lines:\n{log}\n\nThe code is in {CODE}. Find the cause, fix the scripts if it is a "
              "script bug (check with bash -n / python3 -m py_compile), and reply in 3-5 plain sentences a "
              "non-technical person understands: what went wrong, what you changed, and whether to press Start again. "
              "Do not start any pods yourself. Never open or view the input video.")
    S["claude"] = {"state": "running", "text": "Claude is looking at the log…"}
    try:
        res = subprocess.run([claude_bin(), "-p", "--model", CLAUDE_MODEL, prompt, "--permission-mode", "acceptEdits",
                              "--allowedTools", "Read,Edit,Write,Grep,Glob,Bash(bash -n:*),Bash(python3 -m py_compile:*)"],
                             cwd=CODE, capture_output=True, text=True, timeout=900)
        S["claude"] = {"state": "done", "text": (res.stdout or res.stderr).strip()[-3000:]}
    except Exception as e:
        S["claude"] = {"state": "done", "text": f"Couldn't run Claude Code here: {e}"}


def describe_ref(name, path):
    """Claude Code looks at the reference image and writes the character prompt the style step will use."""
    S["ref_desc"][name] = {"state": "running", "text": ""}
    prompt = (f"Read the image file at {path}. Write ONE image-generation prompt (under 90 words, plain text, no preamble) "
              "describing this character so an AI can redraw them the same way every frame: body type and build, skin tone, "
              "face, hair style and colour, every piece of clothing with colours and materials, accessories, and the art style. "
              "Output only the prompt.")
    try:
        r = subprocess.run([claude_bin(), "-p", "--model", CLAUDE_MODEL, prompt, "--allowedTools", "Read"], capture_output=True, text=True, timeout=300)
        text = (r.stdout or "").strip()
        if not text: raise RuntimeError((r.stderr or "no answer").strip()[-300:])
        S["ref_desc"][name] = {"state": "done", "text": text}
        b2_write(f"refs/{os.path.splitext(name)[0]}.txt", text)
    except Exception as e:
        S["ref_desc"][name] = {"state": "error", "text": f"Couldn't describe it automatically ({e}). Type a description instead."}


def push_upload(kind, name, tmp):
    key = f"{kind}/{name}"
    S["uploads"][key] = {"state": "uploading", "name": name, "kind": kind}
    try:
        b2("file", "upload", "--no-progress", "--quiet", BUCKET, tmp, key, timeout=7200)
        S["uploads"][key]["state"] = "done"
        if kind == "refs":
            keep = os.path.join(REF_DIR, name); shutil.copy(tmp, keep); describe_ref(name, keep)
    except Exception as e:
        S["uploads"][key].update(state="error", error=str(e)[-200:])
    finally:
        os.path.exists(tmp) and os.remove(tmp)
        refresh_lists(force=True)


# ---------------- self-test (real accounts, on this phone) ----------------
def selftest(pod_test=False, log=print):
    res = []
    def check(name, fn):
        t0 = time.time()
        try: detail = fn() or "ok"; ok = True
        except Exception as e: detail = str(e)[:300]; ok = False
        res.append({"name": name, "ok": ok, "detail": str(detail), "secs": round(time.time() - t0, 1)})
        log(("PASS " if ok else "FAIL ") + name + ": " + str(detail)); S["selftest"] = {"state": "running", "results": res}
    def keys():
        miss = [k for k, v in KEYS.items() if not v]
        if miss: raise RuntimeError("missing: " + ", ".join(miss))
    check("Keys loaded", keys)
    for host in ("api.runpod.io", "api.backblazeb2.com", "huggingface.co"):
        def dns(h=host):
            try: _orig_gai(h, 443); return "phone DNS ok"
            except socket.gaierror:
                ips = _doh(h)
                if not ips: raise RuntimeError("not found by phone DNS or the DNS-over-HTTPS fallback")
                return f"phone DNS failed; fallback found {ips[0]} (portal will use it)"
        check(f"Find {host}", dns)
    check("RunPod key works (list pods)", lambda: f"{len(list_pods())} pods on the account")
    check("RunPod balance", lambda: "${balance} left, spending ${spend_per_hr}/hr now".format(**runpod_balance()))
    def b2rw():
        name = f"selftest/{int(time.time())}.txt"; b2_write(name, "hello")
        got = b2_read(name); b2("rm", f"b2://{BUCKET}/{name}", timeout=60)
        if got != "hello": raise RuntimeError("wrote a test file but couldn't read it back")
        return "write, read and delete ok"
    check("Backblaze B2 read/write", b2rw)
    def b2key():
        out = b2("key", "create", "--bucket", BUCKET, "--duration", "600", "v2a-selftest",
                 "listBuckets,listFiles,readFiles,writeFiles", timeout=60).split()
        b2("key", "delete", out[0], timeout=60); return "made and deleted a limited pod key"
    check("Limited pod keys", b2key)
    check("SMPL body file in B2 (for 4D-Humans mocap)", lambda: ", ".join(f for f in b2_ls("smpl/") if f.lower().endswith((".zip", ".pkl"))) or (_ for _ in ()).throw(RuntimeError("not uploaded yet: Mocap section, 'SMPL body file'")))
    check("LoRAs in B2", lambda: ", ".join(b2_ls("loras/")) or (_ for _ in ()).throw(RuntimeError("no .safetensors in loras/")))
    def hf():
        if not KEYS["HF_TOKEN"]: return "no token (fine if SAM checkpoints are cached in B2)"
        req = urllib.request.Request("https://huggingface.co/api/whoami-v2", headers={"Authorization": f"Bearer {KEYS['HF_TOKEN']}"})
        with urllib.request.urlopen(req, timeout=30) as r: return "token ok for " + json.load(r).get("name", "?")
    check("Hugging Face token", hf)
    def cl():
        b = claude_bin()
        r = subprocess.run([b, "-p", "--model", CLAUDE_MODEL, "Reply with exactly: OK"], capture_output=True, text=True, timeout=180)
        if "OK" not in r.stdout: raise RuntimeError((r.stderr or r.stdout).strip()[-200:] or "no reply")
        return f"{b} answered"
    check("Claude Code runs headless", cl)
    if pod_test:
        def pod():
            pod = create_pod("v2a-selftest", "runpod/base:0.6.2-cpu",
                             ["NVIDIA RTX A4000", "NVIDIA RTX 2000 Ada Generation", "NVIDIA RTX A5000", "NVIDIA GeForce RTX 3090"],
                             10, {}, "sleep 300")
            pid = pod.get("id"); t0 = time.time()
            try:
                while time.time() - t0 < 240:
                    info = rp("GET", f"/pods/{pid}")
                    if (info.get("status") or info.get("desiredStatus")) == "RUNNING" and (info.get("runtime") or info.get("publicIp") or time.time() - t0 > 60):
                        break
                    time.sleep(10)
                return f"pod {pid} started in {int(time.time()-t0)}s at ${pod.get('cost', pod.get('costPerHr', '?'))}/hr"
            finally:
                rp("DELETE", f"/pods/{pid}")
                time.sleep(5)
                left = [p for p in list_pods() if p.get("id") == pid and (p.get("status") or p.get("desiredStatus")) != "TERMINATED"]
                if left: raise RuntimeError(f"pod {pid} may still exist: delete it in the RunPod app!")
        check("Start + delete a real GPU pod (~$0.01)", pod)
    S["selftest"] = {"state": "done", "results": res, "ts": int(time.time())}
    b2_write(f"reports/selftest_{'pod' if pod_test else 'quick'}.json", json.dumps(S["selftest"], indent=1))
    return res


# ---------------- auto-update from GitHub ----------------
REPO = os.path.dirname(CODE)


def git(*a):
    return subprocess.run(["git", "-C", REPO, *a], capture_output=True, text=True, timeout=120)


def auto_update():
    """Pull new code from GitHub every 3 minutes. When it changed and nothing is running, restart
    with it, so changes from any Claude session reach the phone without copy-pasting."""
    while True:
        time.sleep(180)
        try:
            if git("rev-parse", "--git-dir").returncode: continue
            before = git("rev-parse", "HEAD").stdout.strip()
            git("pull", "--ff-only", "-q")
            after = git("rev-parse", "HEAD").stdout.strip()
            S["version"] = git("log", "-1", "--format=%h %s (%cr)").stdout.strip()
            if after != before:
                with lock: busy = S["run"] and S["run"].get("phase") in ("prep", "mocap", "render")
                S["pending_restart"] = True
                while busy:
                    time.sleep(30)
                    with lock: busy = S["run"] and S["run"].get("phase") in ("prep", "mocap", "render")
                save(); os.execv(sys.executable, [sys.executable] + sys.argv)
        except Exception as e:
            S["update_error"] = str(e)[:200]


def page_version():
    """Short fingerprint of the portal page as it is on disk now."""
    import hashlib
    return hashlib.md5(open(os.path.join(HERE, "index.html"), "rb").read()).hexdigest()[:10]


# ---------------- HTTP ----------------
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def send(self, code, body, ctype="application/json"):
        b = body if isinstance(body, bytes) else (json.dumps(body) if ctype == "application/json" else body).encode()
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b))); self.send_header("Cache-Control", "no-store")
        self.end_headers(); self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("Content-Length", 0)); return self.rfile.read(n) if n else b""

    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == "/":
            # the page carries its own version, so an old copy (kept by the phone while the portal was off) reloads itself
            html = open(os.path.join(HERE, "index.html"), "rb").read()
            return self.send(200, html.replace(b"__PAGE_VERSION__", page_version().encode()), "text/html; charset=utf-8")
        static = {"/manifest.json": "application/manifest+json", "/sw.js": "application/javascript",
                  "/icon-192.png": "image/png", "/icon-512.png": "image/png", "/apple-touch-icon.png": "image/png"}
        if u.path in static:
            return self.send(200, open(os.path.join(HERE, u.path.lstrip("/")), "rb").read(), static[u.path])
        if u.path == "/api/state":
            threading.Thread(target=refresh_lists, daemon=True).start()
            r = S["run"]
            missing = [k for k, v in KEYS.items() if not v]
            return self.send(200, {"page": page_version(), "run": r, "status": S["status"], "log": S["log"], "lists": S["lists"],
                                   "results": S["lists"].get("results", []), "claude": S["claude"],
                                   "uploads": S["uploads"], "ref_desc": S["ref_desc"],
                                   "selftest": S.get("selftest"), "version": S.get("version"),
                                   "config": {k: C[k] for k in C if not k.startswith("B2_")}, "missing_keys": missing,
                                   "now": int(time.time())})
        if u.path == "/api/ref":                          # thumbnail of a reference image
            name = os.path.basename(q.get("name", [""])[0]); local = os.path.join(REF_DIR, name)
            if not os.path.exists(local):
                try: b2("file", "download", "--no-progress", f"b2://{BUCKET}/refs/{name}", local, timeout=120)
                except Exception: return self.send(404, {"error": "missing"})
            ext = os.path.splitext(name)[1].lower().strip(".")
            return self.send(200, open(local, "rb").read(), "image/" + ("jpeg" if ext == "jpg" else ext))
        if u.path == "/api/refdesc":
            name = os.path.basename(q.get("name", [""])[0])
            d = S["ref_desc"].get(name)
            if not d:
                t = b2_read(f"refs/{os.path.splitext(name)[0]}.txt")
                d = {"state": "done", "text": t} if t else {"state": "none", "text": ""}
                if t: S["ref_desc"][name] = d
            return self.send(200, d)
        if u.path == "/api/file":
            path = q.get("path", [""])[0]
            if not path.startswith("jobs/") or ".." in path: return self.send(400, {"error": "bad path"})
            cache = os.path.join(tempfile.gettempdir(), "v2a_" + path.replace("/", "_"))
            if not os.path.exists(cache): b2("file", "download", "--no-progress", f"b2://{BUCKET}/{path}", cache)
            size = os.path.getsize(cache); rng = self.headers.get("Range")
            start, end = 0, size - 1
            if rng:
                m = re.match(r"bytes=(\d*)-(\d*)", rng)
                if m and m.group(1): start = int(m.group(1))
                if m and m.group(2): end = int(m.group(2))
            self.send_response(206 if rng else 200); self.send_header("Content-Type", "video/mp4")
            self.send_header("Accept-Ranges", "bytes"); self.send_header("Content-Length", str(end - start + 1))
            if rng: self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            with open(cache, "rb") as f:
                f.seek(start); left = end - start + 1
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk: break
                    try: self.wfile.write(chunk)
                    except BrokenPipeError: break
                    left -= len(chunk)
            return
        self.send(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == "/api/upload":                       # raw file body -> B2 input/ characters/ loras/ bone_maps/
            kind = q.get("kind", ["input"])[0]; name = os.path.basename(q.get("name", ["upload.bin"])[0])
            if kind not in ("input", "characters", "loras", "bone_maps", "refs", "smpl"): return self.send(400, {"error": "bad kind"})
            name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
            n = int(self.headers.get("Content-Length", 0))
            tmp = os.path.join(tempfile.gettempdir(), f"up_{int(time.time()*1000)}_{name}")
            with open(tmp, "wb") as f:
                while n > 0:
                    chunk = self.rfile.read(min(1 << 20, n))
                    if not chunk: break
                    f.write(chunk); n -= len(chunk)
            # phone -> portal is instant; portal -> B2 carries on in the background
            threading.Thread(target=push_upload, args=(kind, name, tmp), daemon=True).start()
            return self.send(200, {"ok": True, "path": f"{kind}/{name}", "key": f"{kind}/{name}"})
        if u.path == "/api/start":
            if S["run"] and S["run"].get("phase") in ("prep", "mocap", "render"):
                return self.send(409, {"error": "A run is already going"})
            p = json.loads(self.body() or b"{}")
            p["job"] = re.sub(r"[^A-Za-z0-9_-]", "_", p.get("job") or time.strftime("clip_%m%d_%H%M"))
            if [k for k, v in KEYS.items() if not v]: return self.send(400, {"error": "Missing keys in Termux env"})
            with lock:
                S["run"] = {**p, "phase": "prep", "events": [], "started": int(time.time()), "cancel": False}
                S["status"] = None; S["log"] = ""; S["claude"] = None
            save(); threading.Thread(target=run_job, args=(p,), daemon=True).start()
            return self.send(200, {"ok": True})
        if u.path == "/api/stop":
            if S["run"]: S["run"]["cancel"] = True
            for pod in (S["lists"].get("pods") or []):
                if (pod.get("name") or "").startswith("v2a-"): kill(pod["id"])
            refresh_lists(force=True)
            return self.send(200, {"ok": True})
        if u.path == "/api/selftest":
            if (S.get("selftest") or {}).get("state") == "running": return self.send(409, {"error": "already running"})
            S["selftest"] = {"state": "running", "results": []}
            threading.Thread(target=selftest, kwargs={"pod_test": q.get("pod", ["0"])[0] == "1"}, daemon=True).start()
            return self.send(200, {"ok": True})
        if u.path == "/api/ask_claude":
            threading.Thread(target=ask_claude, daemon=True).start(); return self.send(200, {"ok": True})
        self.send(404, {"error": "not found"})


if __name__ == "__main__":
    if "--selftest" in sys.argv:          # python3 portal/server.py --selftest [--pod]
        r = selftest(pod_test="--pod" in sys.argv)
        sys.exit(0 if all(x["ok"] for x in r) else 1)
    S["version"] = git("log", "-1", "--format=%h %s (%cr)").stdout.strip() if os.path.isdir(os.path.join(REPO, ".git")) else ""
    threading.Thread(target=auto_update, daemon=True).start()
    if not shutil.which("b2"): sys.exit("Install the B2 CLI first: pip install b2")
    if S["run"] and S["run"].get("phase") in ("mocap", "render") and S["run"].get("pod"):
        # resume watching after a phone restart
        r = S["run"]
        def resume():
            try:
                watch(r["job"], r["phase"], r["pod"], r.get("pod_rate", 1.0))
                if r["phase"] == "mocap":
                    note("Resumed: mocap done — press Start with 'New character' to continue", phase="failed",
                         error="Portal restarted mid-run")
                else: note("All done — your video is in Results", phase="done")
            except Exception as e: note(f"Problem: {e}", phase="failed", error=str(e))
        threading.Thread(target=resume, daemon=True).start()
    print(f"video2anim portal → http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
