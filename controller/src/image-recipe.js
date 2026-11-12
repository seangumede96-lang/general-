// The Characters page's image engine: Krea 2 Turbo in ComfyUI with a style LoRA and the
// same-face method. This is the recipe worked out by hand on 11 November 2026 (ComfyUI
// graph from gen.py / gen_reid.py in the pipeline notes), turned into code.
import { COMFY_PORT, LOG_PORT, downloadLines } from './video-recipe.js';

const HF = 'https://huggingface.co';
const REID_LORA = 'krea2_reid_rank32.safetensors';
// Public downloads. Text-to-image uses the fp8 model; the same-face method needs the int8 one.
const MODELS = [
	[`${HF}/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_fp8_scaled.safetensors`, 'diffusion_models/krea2_turbo_fp8_scaled.safetensors'],
	[`${HF}/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_int8_convrot.safetensors`, 'diffusion_models/krea2_turbo_int8_convrot.safetensors'],
	[`${HF}/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_bf16.safetensors`, 'text_encoders/qwen3vl_4b_bf16.safetensors'],
	[`${HF}/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors`, 'vae/qwen_image_vae.safetensors'],
	[`${HF}/yijunwang2/krea2-reid/resolve/main/${REID_LORA}`, `loras/${REID_LORA}`]
];

/** File name a LoRA gets on the pod: its own name, made safe for a shell and a path. */
export const loraFileName = (name) => name.split('/').pop().replace(/[^\w.-]/g, '_');

/** Pod start command. `loras` is [{ name, url }] with time-limited links made on the phone. */
export function imagePodSpec(loras = []) {
	const M = '/root/ComfyUI/models';
	const files = [...MODELS, ...loras.map((l) => [l.url, `loras/${loraFileName(l.name)}`])];
	const cmd = [
		`mkdir -p /srv/log && cd /srv/log && (python3 -m http.server ${LOG_PORT} >/dev/null 2>&1 &)`,
		'exec > /srv/log/setup.log 2>&1',
		'trap \'echo "SETUP FAILED"; sleep 900\' ERR',
		'set -eE',
		'echo "STEP 1/3 Installing the image engine"',
		'cd /root && git clone -q --depth 1 https://github.com/comfyanonymous/ComfyUI && cd ComfyUI',
		'pip install -q --break-system-packages -r requirements.txt && pip install -q --break-system-packages -U torchaudio torchvision pillow',
		'git clone -q https://github.com/ostris/ComfyUI-Krea2-Ostris-Edit custom_nodes/ComfyUI-Krea2-Ostris-Edit && git -C custom_nodes/ComfyUI-Krea2-Ostris-Edit checkout -q 7756566',
		...downloadLines(files, M, '2/3'),
		'echo "STEP 3/3 Starting the image engine"',
		`exec python3 main.py --listen 0.0.0.0 --port ${COMFY_PORT}`
	].join('\n');
	return { kind: 'image', name: 'assistant-images', image: 'runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2404', disk: 80, ports: [`${COMFY_PORT}/http`, `${LOG_PORT}/http`], cmd };
}

export const SIZES = { portrait: [1024, 1536], square: [1024, 1024], landscape: [1536, 1024] };

/** What each kind of reference picture is for, and how large the model gets to see it. */
export const REFERENCE_ROLES = {
	// The face is shown very small: enough for identity, too small to copy clothes or background.
	face: { megapixels: 0.140625, hint: (n) => `Keep the face of the person in image ${n}.` },
	body: { megapixels: 0.5, hint: (n) => `Use the body shape and proportions of the person in image ${n}.` },
	look: { megapixels: 0.5, hint: (n) => `Use the outfit, makeup and styling shown in image ${n}.` }
};

/**
 * The ComfyUI graph for one request. `refs` is up to three reference pictures already in
 * ComfyUI's input folder, [{ role, file }]; with any, the reference method is used (edit
 * nodes plus the re-identification LoRA), otherwise plain text-to-image. `loras` is a list
 * of [{ name, strength }] applied one after another.
 */
export function buildImageGraph({ prompt, negative = '', width, height, count, seed, loras = [], refs = [], prefix }) {
	const useRefs = refs.length > 0;
	const text = useRefs ? `${prompt} ${refs.map((r, i) => REFERENCE_ROLES[r.role].hint(i + 1)).join(' ')}` : prompt;
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
	if (useRefs) {
		const images = {};
		refs.forEach((r, i) => {
			g[20 + i * 2] = { class_type: 'LoadImage', inputs: { image: r.file } };
			g[21 + i * 2] = { class_type: 'ImageScaleToTotalPixels', inputs: { image: [String(20 + i * 2), 0], upscale_method: 'area', megapixels: REFERENCE_ROLES[r.role].megapixels, resolution_steps: 16 } };
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
	g[8].inputs.model = model;
	return g;
}
