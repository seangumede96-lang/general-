// How the Video Studio's character replacement actually runs: which machine image, which
// add-ons and models are installed on the pod, and how the workflow is filled in.
//
// The setup mirrors the Dockerfile of github.com/wlsdml1114/Wan_Animate_Runpod_hub (a
// published RunPod template for Wan 2.2 Animate), and the workflow is that project's
// replace-mode ComfyUI workflow, fetched at a pinned commit instead of copied here because
// the project states no licence. Wan 2.2 Animate itself is Apache 2.0.

const REF_COMMIT = '46791944f96ed4c74be4d5f109935e994d2d394d';
export const WORKFLOW_URL = `https://raw.githubusercontent.com/wlsdml1114/Wan_Animate_Runpod_hub/${REF_COMMIT}/newWanAnimate_noSAM_api.json`;

export const COMFY_PORT = 8188;
export const LOG_PORT = 8189;
export const FPS = 16;

const HF = 'https://huggingface.co';

/**
 * Shell lines that download [url, path] pairs side by side and report progress. The first
 * real run showed why this matters: plain downloads were too slow to finish in the reserved
 * time and logged nothing. This uses a multi-connection downloader when it can be installed,
 * and writes "STEP n/m Downloading models (x of y files, z GB)" every 15 seconds.
 */
export function downloadLines(files, root, step) {
	const q = (u) => `'${u.replace(/'/g, '')}'`;
	const paths = files.map(([, d]) => `"${root}/${d}"`).join(' ');
	return [
		`echo "STEP ${step} Downloading models"`,
		'(apt-get install -y -qq aria2 >/dev/null 2>&1 || true)',
		`mkdir -p ${[...new Set(files.map(([, d]) => `${root}/${d.split('/').slice(0, -1).join('/')}`))].join(' ')}`,
		// Each file's full size is asked for first, so the app can show how far along each one is.
		'size() { curl -sIL --connect-timeout 20 "$1" | tr -d "\\r" | awk \'tolower($1)=="content-length:"{n=$2} END{print n+0}\'; }',
		'get() { size "$1" > "$2.total"; if command -v aria2c >/dev/null; then aria2c -q -x 16 -s 16 -k 1M --file-allocation=none --retry-wait 3 -m 5 --allow-overwrite=true -d "$(dirname "$2")" -o "$(basename "$2")" "$1" && touch "$2.done"; else curl -fsSL --retry 5 --connect-timeout 20 -o "$2" "$1" && touch "$2.done"; fi; }',
		// One line per file for the app: name, bytes so far, total bytes.
		`files() { for f in ${paths}; do echo "$(basename "$f") $(stat -c %s "$f" 2>/dev/null || echo 0) $(cat "$f.total" 2>/dev/null || echo 0)"; done > /srv/log/files.tmp && mv /srv/log/files.tmp /srv/log/files.txt; }`,
		...files.map(([url, dest]) => `get ${q(url)} "${root}/${dest}" &`),
		`while [ "$(ls ${root}/*/*.done 2>/dev/null | wc -l)" -lt ${files.length} ] && [ -n "$(jobs -r)" ]; do sleep 5; files; echo "STEP ${step} Downloading models ($(ls ${root}/*/*.done 2>/dev/null | wc -l) of ${files.length} files, $(du -sBG ${root} | cut -f1 | tr -d G) GB)"; done`,
		'wait',
		'files',
		...files.map(([, dest]) => `test -s "${root}/${dest}" || { echo "MISSING ${dest}"; false; }`)
	];
}
const MODELS = [
	[`${HF}/Kijai/WanVideo_comfy/resolve/main/Wan2_1_VAE_bf16.safetensors`, 'vae/Wan2_1_VAE_bf16.safetensors'],
	[`${HF}/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/clip_vision/clip_vision_h.safetensors`, 'clip_vision/clip_vision_h.safetensors'],
	[`${HF}/Kijai/WanVideo_comfy/resolve/main/umt5-xxl-enc-bf16.safetensors`, 'text_encoders/umt5-xxl-enc-bf16.safetensors'],
	[`${HF}/Kijai/WanVideo_comfy_fp8_scaled/resolve/main/Wan22Animate/Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors`, 'diffusion_models/Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors'],
	...['lightx2v_elite_it2v_animate_face', 'WAN22_MoCap_fullbodyCOPY_ED', 'FullDynamic_Ultimate_Fusion_Elite', 'Wan2.2-Fun-A14B-InP-Fusion-Elite']
		.map((n) => [`${HF}/eddy1111111/lightx2v_it2v_adaptive_fusionv_1.safetensors/resolve/main/${n}.safetensors`, `loras/${n}.safetensors`]),
	[`${HF}/Wan-AI/Wan2.2-Animate-14B/resolve/main/process_checkpoint/det/yolov10m.onnx`, 'detection/yolov10m.onnx'],
	[`${HF}/Kijai/vitpose_comfy/resolve/main/onnx/vitpose_h_wholebody_model.onnx`, 'detection/vitpose_h_wholebody_model.onnx'],
	[`${HF}/Kijai/vitpose_comfy/resolve/main/onnx/vitpose_h_wholebody_data.bin`, 'detection/vitpose_h_wholebody_data.bin']
];
const NODE_PACKS_WITH_REQUIREMENTS = ['kijai/ComfyUI-WanVideoWrapper', 'kijai/ComfyUI-KJNodes', 'Kosinkadink/ComfyUI-VideoHelperSuite', 'kijai/ComfyUI-WanAnimatePreprocess'];
const NODE_PACKS_PLAIN = ['kijai/ComfyUI-segment-anything-2', 'eddyhhlure1Eddy/IntelligentVRAMNode', 'eddyhhlure1Eddy/auto_wan2.2animate_freamtowindow_server', 'eddyhhlure1Eddy/ComfyUI-AdaptiveWindowSize'];

/**
 * The pod's start command. Everything is installed fresh on each run (there is no
 * persistent pod storage, by design), with progress written to a log the controller can
 * read over HTTP. On failure the pod stays up briefly so the log can still be fetched.
 */
function setupScript() {
	const M = '/ComfyUI/models';
	const lines = [
		`mkdir -p /srv/log && cd /srv/log && (python3 -m http.server ${LOG_PORT} >/dev/null 2>&1 &)`,
		'exec > /srv/log/setup.log 2>&1',
		'trap \'echo "SETUP FAILED"; sleep 900\' ERR',
		'set -eE',
		'echo "STEP 1/4 Installing the video engine"',
		'pip install -q -U "huggingface_hub[hf_transfer]" websocket-client',
		'cd / && git clone -q --depth 1 https://github.com/comfyanonymous/ComfyUI.git && cd /ComfyUI && pip install -q -r requirements.txt',
		'echo "STEP 2/4 Installing add-ons"',
		'cd /ComfyUI/custom_nodes',
		...NODE_PACKS_WITH_REQUIREMENTS.map((r) => `git clone -q --depth 1 https://github.com/${r} && pip install -q -r ${r.split('/')[1]}/requirements.txt`),
		...NODE_PACKS_PLAIN.map((r) => `git clone -q --depth 1 https://github.com/${r}`),
		'(cd ComfyUI-AdaptiveWindowSize/ComfyUI-AdaptiveWindowSize && mv * ../)',
		'pip install -q --upgrade onnxruntime-gpu==1.22',
		...downloadLines(MODELS.map(([url, dest]) => [url, dest]), M, '3/4'),
		'echo "STEP 4/4 Starting the video engine"',
		`cd /ComfyUI && exec python main.py --listen --port ${COMFY_PORT} --use-sage-attention`
	];
	return lines.join('\n');
}

export const comfyPodSpec = () => ({
	kind: 'comfy', name: 'assistant-video', image: 'wlsdml1114/multitalk-base:1.7', disk: 90,
	ports: [`${COMFY_PORT}/http`, `${LOG_PORT}/http`], cmd: setupScript()
});

/** Minutes of pod time to reserve: fresh setup, then generation, with headroom. All estimates until benchmarked. */
// The first real run needed 5 minutes just to boot and had not finished downloading after 21 more.
export const SETUP_MINUTES = 28;
export const MINUTES_PER_CLIP_SECOND = 2;
export const minutesFor = (seconds) => Math.ceil(SETUP_MINUTES + seconds * MINUTES_PER_CLIP_SECOND + 4);

/** Output size: about 480p in the clip's own orientation, sides divisible by 16 as the model requires. */
export function outputSize(width, height) {
	const ratio = width > 0 && height > 0 ? width / height : 9 / 16;
	if (ratio > 1.2) return { width: 832, height: 480 };
	if (ratio < 0.84) return { width: 480, height: 832 };
	return { width: 640, height: 640 };
}

/** Fill the reference workflow with this job's inputs. Node ids are those of the pinned file. */
export function buildWorkflow(template, { video, image, prompt, seed, width, height, seconds }) {
	const wf = structuredClone(template);
	const need = (id, cls) => {
		if (wf[id]?.class_type !== cls) throw new Error(`The workflow file is not the expected version (node ${id} should be ${cls}).`);
		return wf[id].inputs;
	};
	need('57', 'LoadImage').image = image;
	Object.assign(need('63', 'VHS_LoadVideo'), { video, force_rate: FPS, frame_load_cap: Math.round(seconds * FPS) });
	need('65', 'WanVideoTextEncodeCached').positive_prompt = prompt;
	Object.assign(need('27', 'WanVideoSampler'), { seed, steps: 4, cfg: 1 });
	need('150', 'INTConstant').value = width;
	need('151', 'INTConstant').value = height;
	Object.assign(need('30', 'VHS_VideoCombine'), { frame_rate: FPS, save_output: true, filename_prefix: 'assistant' });
	return wf;
}
