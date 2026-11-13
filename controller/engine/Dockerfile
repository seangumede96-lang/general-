# The image engine, ready-made: ComfyUI with the add-ons the Characters page needs, installed
# once here instead of on every rented GPU. Models are not included: they are downloaded at
# start, because a fresh machine would have to download them as part of this image anyway.
# Built on RunPod's own PyTorch image, which RunPod machines usually already have, so only
# the layers added here need downloading.
FROM runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2404

RUN apt-get update -qq && apt-get install -y -qq aria2 && rm -rf /var/lib/apt/lists/*

WORKDIR /root
RUN git clone -q --depth 1 https://github.com/comfyanonymous/ComfyUI \
	&& cd ComfyUI \
	&& pip install -q --break-system-packages -r requirements.txt \
	&& pip install -q --break-system-packages -U torchaudio torchvision pillow \
	&& git clone -q https://github.com/ostris/ComfyUI-Krea2-Ostris-Edit custom_nodes/ComfyUI-Krea2-Ostris-Edit \
	&& git -C custom_nodes/ComfyUI-Krea2-Ostris-Edit checkout -q 7756566 \
	&& git clone -q https://github.com/facok/comfyui-krea2-controlnet custom_nodes/comfyui-krea2-controlnet \
	&& git -C custom_nodes/comfyui-krea2-controlnet checkout -q 79ebfd3 \
	&& rm -rf /root/.cache/pip

# Marks the image so the setup script knows it can skip installing.
RUN touch /root/ComfyUI/.ready-made-engine
LABEL org.opencontainers.image.source=https://github.com/seangumede96-lang/general-
LABEL org.opencontainers.image.description="Assistant image engine: ComfyUI with Krea 2 edit nodes, no models"
