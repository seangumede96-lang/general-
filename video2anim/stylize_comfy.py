"""Upscale (2x model) + Krea 2 LoRA style transfer for every rendered frame, via ComfyUI's API.

python stylize_comfy.py --frames /workspace/frames --comfy /workspace/ComfyUI --out /workspace/styled

Per frame: LoadImage -> RealESRGAN x2 -> resize to STYLE_W x STYLE_H -> VAE encode ->
Krea 2 Turbo + your LoRA (img2img, fixed seed, low denoise) -> save.
Runs a speed benchmark on the first frames and refuses to continue if the
projected cost would pass STAGE2_CAP_USD.
"""
import argparse, json, os, shutil, sys, time, urllib.request, glob

E = lambda k, d: type(d)(os.environ.get(k, d))
ap = argparse.ArgumentParser()
ap.add_argument("--frames", required=True); ap.add_argument("--comfy", required=True)
ap.add_argument("--out", required=True); ap.add_argument("--host", default="http://127.0.0.1:8188")
ap.add_argument("--bench", type=int, default=6)
ap.add_argument("--every", type=int, default=1, help="stylize every Nth frame only (cheap preview)")
ap.add_argument("--ref", default="", help="character reference image (copied into ComfyUI input)")
ap.add_argument("--template", default="", help="API-format workflow with {{FRAME}} {{REF}} {{PROMPT}} {{PREFIX}} ... placeholders")
a = ap.parse_args()

def get(path):
    return json.load(urllib.request.urlopen(a.host + path))

def post(path, data):
    req = urllib.request.Request(a.host + path, json.dumps(data).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))

# CLIPLoader "type" for Krea 2 differs by ComfyUI version: pick the one the server offers.
types = get("/object_info/CLIPLoader")["CLIPLoader"]["input"]["required"]["type"][0]
clip_type = next((t for t in types if "krea" in t.lower()), None) or next((t for t in types if "qwen" in t.lower()), None)
if not clip_type: sys.exit(f"No Krea/Qwen text-encoder type in this ComfyUI: {types}. Update ComfyUI.")

TEMPLATE = json.load(open(a.template)) if a.template and os.path.exists(a.template) else None
REF_NAME = ""
if a.ref and os.path.exists(a.ref):
    os.makedirs(os.path.join(a.comfy, "input", "v2a"), exist_ok=True)
    REF_NAME = "v2a/ref" + os.path.splitext(a.ref)[1]
    shutil.copy(a.ref, os.path.join(a.comfy, "input", REF_NAME))
print(f"style mode: {'reference-image workflow' if TEMPLATE and REF_NAME else 'img2img'}; reference image: {REF_NAME or 'none'}")


def fill_template(img_name, prefix):
    vals = {"{{FRAME}}": img_name, "{{REF}}": REF_NAME, "{{PROMPT}}": os.environ.get("STYLE_PROMPT", ""),
            "{{PREFIX}}": prefix, "{{SEED}}": E("SEED", 12345), "{{DENOISE}}": E("DENOISE", 0.4),
            "{{STEPS}}": E("STEPS", 8), "{{CFG}}": E("CFG", 1.0), "{{LORA}}": os.environ.get("LORA_FILE", ""),
            "{{LORA_STRENGTH}}": E("LORA_STRENGTH", 0.9), "{{W}}": E("STYLE_W", 1088), "{{H}}": E("STYLE_H", 1920)}
    def walk(o):
        if isinstance(o, dict): return {k: walk(v) for k, v in o.items()}
        if isinstance(o, list): return [walk(v) for v in o]
        if isinstance(o, str) and o in vals: return vals[o]
        return o
    return walk(TEMPLATE)


def workflow(img_name, prefix):
    if TEMPLATE and REF_NAME: return fill_template(img_name, prefix)
    return {
      "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "krea2_turbo_fp8_scaled.safetensors", "weight_dtype": "default"}},
      "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_4b_fp8_scaled.safetensors", "type": clip_type}},
      "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
      "4": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": os.environ["LORA_FILE"],
                                                             "strength_model": E("LORA_STRENGTH", 0.9)}},
      "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": os.environ.get("STYLE_PROMPT", "")}},
      "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": ""}},
      "7": {"class_type": "LoadImage", "inputs": {"image": img_name}},
      "8": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": "RealESRGAN_x2plus.pth"}},
      "9": {"class_type": "ImageUpscaleWithModel", "inputs": {"upscale_model": ["8", 0], "image": ["7", 0]}},
      "10": {"class_type": "ImageScale", "inputs": {"image": ["9", 0], "upscale_method": "lanczos",
                                                     "width": E("STYLE_W", 1088), "height": E("STYLE_H", 1920), "crop": "disabled"}},
      "11": {"class_type": "VAEEncode", "inputs": {"pixels": ["10", 0], "vae": ["3", 0]}},
      "12": {"class_type": "KSampler", "inputs": {"model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0],
              "latent_image": ["11", 0], "seed": E("SEED", 12345), "steps": E("STEPS", 8), "cfg": E("CFG", 1.0),
              "sampler_name": "euler", "scheduler": "simple", "denoise": E("DENOISE", 0.4)}},
      "13": {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["3", 0]}},
      "14": {"class_type": "SaveImage", "inputs": {"images": ["13", 0], "filename_prefix": prefix}},
    }

frames = sorted(glob.glob(os.path.join(a.frames, "*.png")))[::a.every]
if not frames: sys.exit("no frames")
in_dir = os.path.join(a.comfy, "input", "v2a"); os.makedirs(in_dir, exist_ok=True)
out_root = os.path.join(a.comfy, "output", "v2a"); os.makedirs(a.out, exist_ok=True)
done = {os.path.basename(p) for p in glob.glob(os.path.join(a.out, "*.png"))}   # resume support

def run(batch):
    ids = []
    for f in batch:
        name = os.path.basename(f)
        shutil.copy(f, os.path.join(in_dir, name))
        stem = name[:-4]
        ids.append((post("/prompt", {"prompt": workflow(f"v2a/{name}", f"v2a/{stem}")})["prompt_id"], stem))
    for pid, stem in ids:
        while True:
            h = get(f"/history/{pid}")
            if pid in h:
                st = h[pid].get("status", {})
                if st.get("status_str") == "error": sys.exit(f"ComfyUI error on {stem}: {json.dumps(st)[:800]}")
                if st.get("completed"): break
            time.sleep(0.5)
        made = sorted(glob.glob(os.path.join(out_root, stem + "_*.png")))
        shutil.move(made[-1], os.path.join(a.out, stem + ".png"))

todo = [f for f in frames if os.path.basename(f) not in done]
print(f"{len(todo)} frames to stylize ({len(done)} already done)")

# ---- benchmark + cost check ----
bench = todo[:a.bench]
run(bench[:1])                                  # warm-up (model load) not counted
t0 = time.time(); run(bench[1:]); per = (time.time() - t0) / max(1, len(bench) - 1)
rate, cap = E("STAGE2_RATE_USD_HR", 0.69), E("STAGE2_CAP_USD", 10.0)
spent = float(open("/tmp/spent_usd").read()) if os.path.exists("/tmp/spent_usd") else 0.0
remaining = len(todo) - len(bench)
projected = spent + remaining * per / 3600 * rate
print(f"BENCH {per:.2f}s/frame -> {remaining} frames ~{remaining*per/60:.1f} min, projected pod spend ${projected:.2f} (cap ${cap})")
if projected > cap:
    sys.exit("Projected cost over cap. Lower STYLE_W/H, STEPS or raise STAGE2_CAP_USD in config.env.")

for i in range(len(bench), len(todo), 8):
    run(todo[i:i + 8])
    print(f"styled {min(i+8, len(todo))}/{len(todo)}", flush=True)
print("STYLE_DONE")
