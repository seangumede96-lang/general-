# The image engine, ready-made: ComfyUI with the add-ons the Characters page needs, installed
# once here instead of on every rented GPU. Models are not included: they are downloaded at
# start, because a fresh machine would have to download them as part of this image anyway.
# Built on RunPod's own PyTorch image, which RunPod machines usually already have, so only
# the layers added here need downloading.
FROM runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2404

RUN apt-get update -qq && apt-get install -y -qq aria2 && rm -rf /var/lib/apt/lists/*

ENV PIP_BREAK_SYSTEM_PACKAGES=1
# Keep the PyTorch that RunPod's base image (and so usually the machine) already has: pin it,
# add the matching torchvision from the same CUDA 12.8 index, and keep pip's cache out of the
# image (the base points it at /workspace/.cache/pip, which a plain cleanup misses). Without
# this a second PyTorch and its CUDA libraries end up in the image: 7.8 GB more to download.
ENV PIP_NO_CACHE_DIR=1
RUN python -m pip freeze | grep -iE '^(torch|torchaudio|triton|nvidia-[a-z0-9-]+)==' > /etc/pip-constraints.txt \
	&& python -m pip install -q -c /etc/pip-constraints.txt torchvision --index-url https://download.pytorch.org/whl/cu128 \
	&& python -m pip freeze | grep -iE '^(torch|torchvision|torchaudio)==' >> /etc/pip-constraints.txt \
	&& rm -rf /workspace/.cache
ENV PIP_CONSTRAINT=/etc/pip-constraints.txt

WORKDIR /root
RUN git clone -q --depth 1 https://github.com/comfyanonymous/ComfyUI \
	&& cd ComfyUI \
	&& pip install -q -r requirements.txt \
	&& pip install -q -U pillow \
	&& git clone -q https://github.com/ostris/ComfyUI-Krea2-Ostris-Edit custom_nodes/ComfyUI-Krea2-Ostris-Edit \
	&& git -C custom_nodes/ComfyUI-Krea2-Ostris-Edit checkout -q 7756566 \
	&& git clone -q https://github.com/facok/comfyui-krea2-controlnet custom_nodes/comfyui-krea2-controlnet \
	&& git -C custom_nodes/comfyui-krea2-controlnet checkout -q 79ebfd3

# Shown in the build log, to check only one PyTorch is installed.
RUN python -m pip list 2>/dev/null | grep -iE '^(torch|torchvision|torchaudio|nvidia-cublas)' ; du -sh /workspace 2>/dev/null; true
# Marks the image so the setup script knows it can skip installing.
RUN touch /root/ComfyUI/.ready-made-engine
LABEL org.opencontainers.image.source=https://github.com/seangumede96-lang/general-
LABEL org.opencontainers.image.description="Assistant image engine: ComfyUI with Krea 2 edit nodes, no models"
