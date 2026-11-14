// How motion capture runs on a pod: SAM-Body4D (MIT licence; github.com/gaomingqi/sam-body4d)
// at a pinned commit, made data-only by mocap-pod/patch_offline_app.py, so the pod writes joint
// numbers and never a picture or video of the result. Based on the owner's phone session's
// tested setup (2026-11-12: a 5 s clip took about 8 min on a 48 GB GPU, peak 33.7 GB).
//
// Inputs reach the pod as environment variables, never keys:
//   MOCAP_VIDEO_URL   one-hour Backblaze link to the clip
//   MOCAP_GATED       lines "<path under the checkpoint folder> <one-hour Hugging Face link>"
//   MOCAP_SMALL       JSON {"<path>": "<base64>"} for small gated files (no download link exists)
//   MOCAP_PROMPTS     base64 JSON of the owner's marks (people and points), or empty for automatic
//   MOCAP_TRIM        "<start> <length>" in seconds: the part of the clip to use (marks are timed from its start)
//   MOCAP_PATCH, MOCAP_QC   base64 of the two helper scripts in mocap-pod/
// Results are served on LOG_PORT from /srv/log: setup.log, out/joints.zip, out/qc.json.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LOG_PORT = 8189;
export const REPO_COMMIT = '21af1020979ef32ddf6be3597ef59a68bad2f1bf';
export const IMAGE = 'runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2404';
/** Peak 33.7 GB on the tested run, so a 48 GB card. */
export const MIN_VRAM_GB = 48;

const HF = 'https://huggingface.co';
/** Gated files (the owner's Hugging Face token is needed to make links for these). */
export const GATED_FILES = [
	{ repo: 'facebook/sam3', file: 'sam3.pt', dest: 'sam3/sam3.pt' },
	{ repo: 'facebook/sam-3d-body-dinov3', file: 'model.ckpt', dest: 'sam-3d-body-dinov3/model.ckpt' },
	{ repo: 'facebook/sam-3d-body-dinov3', file: 'model_config.yaml', dest: 'sam-3d-body-dinov3/model_config.yaml' },
	{ repo: 'facebook/sam-3d-body-dinov3', file: 'assets/mhr_model.pt', dest: 'sam-3d-body-dinov3/assets/mhr_model.pt' }
];
const PUBLIC_FILES = [
	[`${HF}/depth-anything/Depth-Anything-V2-Large/resolve/main/depth_anything_v2_vitl.pth`, 'depth_anything_v2_vitl.pth'],
	[`${HF}/Ruicheng/moge-2-vitl-normal/resolve/main/model.pt`, 'moge-2-vitl-normal/model.pt']
];

const here = (name) => readFileSync(fileURLToPath(new URL(`./mocap-pod/${name}`, import.meta.url)));
export const PATCH_SCRIPT = here('patch_offline_app.py');
export const QC_SCRIPT = here('qc_mocap.py');

/** Minutes to reserve for a clip: setup (about 6 min tested, with headroom) plus processing. */
export const SETUP_MINUTES = 15;
export const MINUTES_PER_CLIP_SECOND = 2;
export const minutesFor = (seconds) => Math.ceil(SETUP_MINUTES + seconds * MINUTES_PER_CLIP_SECOND + 8);

function script() {
	const CK = '/root/ckpt';
	return [
		`mkdir -p /srv/log/out && cd /srv/log && (python3 -m http.server ${LOG_PORT} >/dev/null 2>&1 &)`,
		'exec > /srv/log/setup.log 2>&1',
		// On failure the pod stays up briefly so the phone can read why; the log is text only.
		'trap \'echo "SETUP FAILED"; sleep 900\' ERR',
		'set -eE',
		'export DEBIAN_FRONTEND=noninteractive PIP_BREAK_SYSTEM_PACKAGES=1 PIP_NO_CACHE_DIR=1',
		'echo "STEP 1/5 Installing the motion capture tools"',
		'apt-get update -qq >/dev/null && apt-get install -y -qq ffmpeg git build-essential libegl1 libgl1 libgles2 libglib2.0-0 libosmesa6 zip >/dev/null',
		// Keep the PyTorch this image already has (no second copy pulled in by requirements).
		"python3 -m pip freeze | grep -iE '^(torch|torchvision|torchaudio|triton|nvidia-[a-z0-9-]+)==' > /root/pip-constraints.txt",
		'export PIP_CONSTRAINT=/root/pip-constraints.txt',
		`cd /root && git clone -q https://github.com/gaomingqi/sam-body4d && cd sam-body4d && git checkout -q ${REPO_COMMIT}`,
		`mkdir -p /root/x ${CK}/sam3 ${CK}/sam-3d-body-dinov3/assets ${CK}/moge-2-vitl-normal /root/video`,
		'echo "$MOCAP_PATCH" | base64 -d > /root/x/patch_offline_app.py',
		'echo "$MOCAP_QC" | base64 -d > /root/x/qc_mocap.py',
		'echo "STEP 2/5 Downloading the models and your clip"',
		// Downloads run alongside the installs; only their own process is waited on (the pod's
		// self-delete timer also runs in the background of this shell).
		'(',
		'  set +e',
		`  echo "$MOCAP_GATED" | while read -r f u; do [ -n "$f" ] || continue; mkdir -p "$(dirname "${CK}/$f")"; curl -sSL --retry 5 -o "${CK}/$f" "$u" && echo "OK $f $(stat -c %s "${CK}/$f")" || echo "MISSING $f"; done`,
		`  python3 -c 'import base64, json, os, sys; d = json.loads(os.environ.get("MOCAP_SMALL") or "{}")\nfor p, b in d.items():\n    path = os.path.join("${CK}", p); os.makedirs(os.path.dirname(path), exist_ok=True); open(path, "wb").write(base64.b64decode(b)); print("OK", p, os.path.getsize(path))'`,
		...PUBLIC_FILES.map(([url, dest]) => `  curl -sSL --retry 5 -o "${CK}/${dest}" "${url}" && echo "OK ${dest} $(stat -c %s "${CK}/${dest}")" || echo "MISSING ${dest}"`),
		'  curl -sSL --retry 5 -o /root/video/in "$MOCAP_VIDEO_URL" && echo "OK clip $(stat -c %s /root/video/in)" || echo "MISSING clip"',
		') > /root/x/downloads.log 2>&1 &',
		'DL=$!',
		'echo "STEP 3/5 Installing the models\' code"',
		"pip install -q 'git+https://github.com/facebookresearch/detectron2.git@a1ce2f9' --no-build-isolation --no-deps",
		'pip install -q -e models/sam3',
		'pip install -q -e .',
		'python3 -c "import torch; print(\'torch\', torch.__version__, torch.cuda.is_available())"',
		`python3 -c 'from huggingface_hub import snapshot_download\nfor r in ("diffusion-vas-amodal-segmentation", "diffusion-vas-content-completion"): snapshot_download(repo_id="kaihuac/" + r, local_dir="${CK}/" + r); print("OK", r)'`,
		`sed -i 's|ckpt_root: .*|ckpt_root: "${CK}"|' configs/body4d.yaml`,
		'python3 /root/x/patch_offline_app.py /root/sam-body4d',
		'while kill -0 $DL 2>/dev/null; do echo "STEP 3/5 Downloading the models and your clip ($(du -sh ' + CK + ' | cut -f1) so far)"; sleep 15; done',
		'wait $DL || true',
		'cat /root/x/downloads.log',
		'if grep -q MISSING /root/x/downloads.log; then echo "A download failed (see above)"; false; fi',
		// The tool needs .mp4; re-encoding also normalises odd phone formats. Sound is dropped.
		// Only the chosen part (MOCAP_TRIM "<start> <length>" in seconds), re-encoded so it starts on a frame.
		'read TSTART TLEN <<< "${MOCAP_TRIM:-0 0}"',
		'TRIM=""; if [ -n "$TLEN" ] && [ "$TLEN" != "0" ]; then TRIM="-ss $TSTART -t $TLEN"; fi',
		'ffmpeg -loglevel error -y $TRIM -i /root/video/in -an -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p /root/video/clip.mp4 && rm -f /root/video/in',
		'FRAMES=$(ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of csv=p=0 /root/video/clip.mp4)',
		"FPS=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 /root/video/clip.mp4 | awk -F/ '{ printf \"%.3f\", ($2 ? $1 / $2 : $1) }')",
		'echo "CLIP $FRAMES frames at $FPS fps"',
		'if [ -n "$MOCAP_PROMPTS" ]; then echo "$MOCAP_PROMPTS" | base64 -d > /root/x/prompts.json; export PROMPTS_FILE=/root/x/prompts.json; echo "PEOPLE marked by hand"; else echo "PEOPLE found automatically"; fi',
		'echo "STEP 4/5 Tracking the people and measuring their bodies"',
		'cd /root/sam-body4d',
		// Progress: joint files appear one per frame while the bodies are measured.
		'( while sleep 15; do echo "PROGRESS $(ls /root/out/joints 2>/dev/null | wc -l) of $FRAMES frames"; done ) & TICK=$!',
		'python3 scripts/offline_app_data.py --input_video /root/video/clip.mp4 --output_dir /root/out',
		'kill $TICK 2>/dev/null || true',
		'echo "STEP 5/5 Checking the results"',
		'python3 /root/x/qc_mocap.py /root/out/joints "$FPS" > /srv/log/out/qc.json',
		'cd /root/out && zip -q -r /srv/log/out/joints.zip joints',
		'rm -rf /root/video',
		'echo "MOCAP DONE $(ls /root/out/joints | wc -l) frames, $(stat -c %s /srv/log/out/joints.zip) bytes"',
		'sleep infinity'
	].join('\n');
}

/** The pod for one job; `env` carries the links, marks and helper scripts listed above. */
export const mocapPodSpec = (env) => ({
	// 60 GB holds the models (about 25 GB) and the install; asking for more often finds no free
	// machine when stock is low (RunPod could not place 100 GB on any listed 48 GB card).
	kind: 'mocap', name: 'assistant-mocap', image: IMAGE, disk: 60,
	ports: [`${LOG_PORT}/http`], cmd: script(),
	env: { MOCAP_PATCH: PATCH_SCRIPT.toString('base64'), MOCAP_QC: QC_SCRIPT.toString('base64'), ...env }
});
