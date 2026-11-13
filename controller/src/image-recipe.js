// The Characters page's image engine: Krea 2 Turbo in ComfyUI with a style LoRA and the
// same-face method. This is the recipe worked out by hand on 11 November 2026 (ComfyUI
// graph from gen.py / gen_reid.py in the pipeline notes), turned into code.
import { COMFY_PORT, LOG_PORT, downloadLines } from './video-recipe.js';

const HF = 'https://huggingface.co';
const REID_LORA = 'krea2_reid_rank32.safetensors';
export const DEPTH_LORA = 'krea2_depth_control.safetensors';
// Krea 2 depth control: LoRA by Patil (Krea 2 Community licence); ComfyUI nodes by facok, pinned.
const DEPTH_NODES = { repo: 'https://github.com/facok/comfyui-krea2-controlnet', commit: '79ebfd3', dir: 'custom_nodes/comfyui-krea2-controlnet' };
// Public downloads. Text-to-image uses the fp8 model; the same-face method needs the int8 one.
const MODELS = [
	[`${HF}/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_fp8_scaled.safetensors`, 'diffusion_models/krea2_turbo_fp8_scaled.safetensors'],
	[`${HF}/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_int8_convrot.safetensors`, 'diffusion_models/krea2_turbo_int8_convrot.safetensors'],
	[`${HF}/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_bf16.safetensors`, 'text_encoders/qwen3vl_4b_bf16.safetensors'],
	[`${HF}/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors`, 'vae/qwen_image_vae.safetensors'],
	[`${HF}/yijunwang2/krea2-reid/resolve/main/${REID_LORA}`, `loras/${REID_LORA}`],
	[`${HF}/Patil/Krea-2-depth-controlnet/resolve/main/depth-control-lora.safetensors`, `loras/${DEPTH_LORA}`]
];

/** File name a LoRA gets on the pod: its own name, made safe for a shell and a path. */
export const loraFileName = (name) => name.split('/').pop().replace(/[^\w.-]/g, '_');

/** Pod start command. `loras` is [{ name, url }] with time-limited links made on the phone. */
export const STOCK_IMAGE = 'runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2404';

export function imagePodSpec(loras = [], engineImage = '') {
	const M = '/root/ComfyUI/models';
	const files = [...MODELS, ...loras.map((l) => [l.url, `loras/${loraFileName(l.name)}`])];
	const cmd = [
		`mkdir -p /srv/log && cd /srv/log && (python3 -m http.server ${LOG_PORT} >/dev/null 2>&1 &)`,
		'exec > /srv/log/setup.log 2>&1',
		'trap \'echo "SETUP FAILED"; sleep 900\' ERR',
		'set -eE',
		'echo "STEP 1/3 Installing the image engine"',
		// With the ready-made engine image everything below is already installed and skipped.
		'if [ -f /root/ComfyUI/.ready-made-engine ]; then echo "Ready-made engine: nothing to install"; cd /root/ComfyUI; else',
		'cd /root && git clone -q --depth 1 https://github.com/comfyanonymous/ComfyUI && cd ComfyUI',
		'pip install -q --break-system-packages -r requirements.txt && pip install -q --break-system-packages -U torchaudio torchvision pillow',
		'git clone -q https://github.com/ostris/ComfyUI-Krea2-Ostris-Edit custom_nodes/ComfyUI-Krea2-Ostris-Edit && git -C custom_nodes/ComfyUI-Krea2-Ostris-Edit checkout -q 7756566',
		'fi',
		// The depth-control nodes, in case the ready-made engine predates them.
		`[ -d ${DEPTH_NODES.dir} ] || { git clone -q ${DEPTH_NODES.repo} ${DEPTH_NODES.dir} && git -C ${DEPTH_NODES.dir} checkout -q ${DEPTH_NODES.commit}; }`,
		...downloadLines(files, M, '2/3'),
		'echo "STEP 3/3 Starting the image engine"',
		`exec python3 main.py --listen 0.0.0.0 --port ${COMFY_PORT}`
	].join('\n');
	return { kind: 'image', name: 'assistant-images', image: engineImage || STOCK_IMAGE, disk: 80, ports: [`${COMFY_PORT}/http`, `${LOG_PORT}/http`], cmd };
}

export const SIZES = { portrait: [1024, 1536], square: [1024, 1024], landscape: [1536, 1024] };

/** What each kind of reference picture is for, and how large the model gets to see it. */
export const REFERENCE_ROLES = {
	// The face is shown small: enough for identity, too small to copy clothes or background.
	face: { megapixels: 0.140625, one: 'Keep the face of the person in', many: (n) => `shows ${n} pictures of the same person's face; keep that face` },
	body: { megapixels: 0.5, one: 'Use the body shape and proportions of the person in', many: (n) => `shows ${n} pictures of the same body; use that body shape and proportions` },
	look: { megapixels: 0.5, one: 'Use the outfit, makeup and styling shown in', many: (n) => `shows ${n} pictures of the outfit, makeup and styling to use` }
};
/** The edit nodes take at most three pictures per generation: one per role. Several pictures for a role arrive as one sheet. */
export const MAX_REFERENCES = 3;
export const MAX_PER_ROLE = 3;

/** One sentence per reference, saying what it is for and, for a sheet, how many pictures it holds. */
function referenceHints(refs) {
	return refs.map((r, i) => {
		const role = REFERENCE_ROLES[r.role];
		return (r.count || 1) > 1 ? `Image ${i + 1} ${role.many(r.count)}.` : `${role.one} image ${i + 1}.`;
	}).join(' ');
}

/** A sheet of several pictures keeps each picture at the size a single one would have. */
export const referenceMegapixels = (r) => REFERENCE_ROLES[r.role].megapixels * Math.min(MAX_PER_ROLE, r.count || 1);

/**
 * The ComfyUI graph for one request. `refs` is up to three reference pictures already in
 * ComfyUI's input folder, [{ role, file }]; with any, the reference method is used (edit
 * nodes plus the re-identification LoRA), otherwise plain text-to-image. `loras` is a list
 * of [{ name, strength }] applied one after another.
 */
export function buildImageGraph({ prompt, negative = '', width, height, count, seed, loras = [], refs = [], prefix, shape = null, shapeDenoise = 0.72, depth = null, depthStrength = 0.9 }) {
	const useRefs = refs.length > 0;
	const text = useRefs ? `${prompt} ${referenceHints(refs)}` : prompt;
	const g = {
		1: { class_type: 'UNETLoader', inputs: { unet_name: useRefs ? 'krea2_turbo_int8_convrot.safetensors' : 'krea2_turbo_fp8_scaled.safetensors', weight_dtype: 'default' } },
		2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_4b_bf16.safetensors', type: 'krea2', device: 'default' } },
		3: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
		5: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text } },
		6: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: negative } },
		7: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: count } },
		8: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0], seed, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
		9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
		10: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: prefix } }
	};
	let model = ['1', 0];
	if (useRefs) {
		g[30] = { class_type: 'LoraLoaderModelOnly', inputs: { model, lora_name: REID_LORA, strength_model: 1 } };
		model = ['30', 0];
	}
	loras.forEach((l, i) => {
		const id = i === 0 ? '4' : `4${String.fromCharCode(96 + i)}`; // 4, 4a, 4b
		g[id] = { class_type: 'LoraLoaderModelOnly', inputs: { model, lora_name: loraFileName(l.name), strength_model: l.strength } };
		model = [id, 0];
	});
	// Depth control from the body editor: the picture follows the mannequin's 3D shape.
	if (depth) {
		g[50] = { class_type: 'LoadImage', inputs: { image: depth } };
		g[51] = { class_type: 'Krea2ControlImageEncode', inputs: { control_image: ['50', 0], vae: ['3', 0], resize: 'match_latent_size', upscale_method: 'lanczos', crop: 'center', channel_mode: 'grayscale', normalize: 'per_image_minmax', invert: false, batch_mode: 'independent_images', latent: ['7', 0] } };
		g[52] = { class_type: 'Krea2ControlLoRALoader', inputs: { model, lora_name: DEPTH_LORA, strength: depthStrength } };
		g[53] = { class_type: 'Krea2ControlApply', inputs: { model: ['52', 0], control_latent: ['51', 0] } };
		model = ['53', 0];
	}
	if (useRefs) {
		const images = {};
		refs.forEach((r, i) => {
			g[20 + i * 2] = { class_type: 'LoadImage', inputs: { image: r.file } };
			g[21 + i * 2] = { class_type: 'ImageScaleToTotalPixels', inputs: { image: [String(20 + i * 2), 0], upscale_method: 'area', megapixels: referenceMegapixels(r), resolution_steps: 16 } };
			images[`image${i + 1}`] = [String(21 + i * 2), 0];
		});
		g[31] = { class_type: 'Krea2OstrisEditModelPatch', inputs: { model, kv_cache: true } };
		model = ['31', 0];
		for (const [k, t] of [[5, text], [6, negative]]) {
			g[k] = { class_type: 'TextEncodeKrea2OstrisEdit', inputs: { clip: ['2', 0], vae: ['3', 0], ...images, prompt: t } };
			g[`4${k}`] = { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: [String(k), 0], reference_latents_method: 'index_timestep_zero' } };
		}
		Object.assign(g[8].inputs, { positive: ['45', 0], negative: ['46', 0] });
	}
	// A body shape from the body editor: the picture starts from that render instead of from
	// noise, and only part of it is repainted, so the proportions carry over.
	if (shape) {
		g[40] = { class_type: 'LoadImage', inputs: { image: shape } };
		g[41] = { class_type: 'ImageScale', inputs: { image: ['40', 0], upscale_method: 'lanczos', width, height, crop: 'center' } };
		g[42] = { class_type: 'VAEEncode', inputs: { pixels: ['41', 0], vae: ['3', 0] } };
		g[43] = { class_type: 'RepeatLatentBatch', inputs: { samples: ['42', 0], amount: count } };
		Object.assign(g[8].inputs, { latent_image: ['43', 0], denoise: shapeDenoise });
		delete g[7];
	}
	g[8].inputs.model = model;
	return g;
}
