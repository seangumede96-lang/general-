# The video engine, ready-made: ComfyUI with the add-ons Wan 2.2 Animate character replacement
# needs, installed once here instead of on every rented GPU. Models are not included (about
# 40 GB): they are downloaded at start. Built on RunPod's own PyTorch image, which RunPod
# machines usually already have, so only the layers added here need downloading, instead of
# the 14.6 GB third-party image the video GPU used to start from.
FROM runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2404

RUN apt-get update -qq && apt-get install -y -qq aria2 ffmpeg && rm -rf /var/lib/apt/lists/*

ENV PIP_BREAK_SYSTEM_PACKAGES=1
WORKDIR /
RUN git clone -q --depth 1 https://github.com/comfyanonymous/ComfyUI.git \
	&& cd /ComfyUI && pip install -q -r requirements.txt \
	&& pip install -q -U "huggingface_hub[hf_transfer]" websocket-client \
	&& rm -rf /root/.cache/pip

# The add-ons the replace workflow uses (the same set as the original setup script).
RUN cd /ComfyUI/custom_nodes \
	&& for r in kijai/ComfyUI-WanVideoWrapper kijai/ComfyUI-KJNodes Kosinkadink/ComfyUI-VideoHelperSuite kijai/ComfyUI-WanAnimatePreprocess; do \
		git clone -q --depth 1 https://github.com/$r && pip install -q -r ${r#*/}/requirements.txt || exit 1; done \
	&& for r in kijai/ComfyUI-segment-anything-2 eddyhhlure1Eddy/IntelligentVRAMNode eddyhhlure1Eddy/auto_wan2.2animate_freamtowindow_server eddyhhlure1Eddy/ComfyUI-AdaptiveWindowSize; do \
		git clone -q --depth 1 https://github.com/$r || exit 1; done \
	&& (cd ComfyUI-AdaptiveWindowSize/ComfyUI-AdaptiveWindowSize && mv * ../) \
	&& pip install -q onnxruntime-gpu==1.22 \
	&& rm -rf /root/.cache/pip

# SageAttention 1.x is pure Triton (no compiling); the GPU checks at start that it works and
# the job falls back to PyTorch's built-in attention if it does not.
RUN pip install -q sageattention==1.0.6 && rm -rf /root/.cache/pip

# Marks the image so the setup script knows it can skip installing.
RUN touch /ComfyUI/.ready-made-engine
LABEL org.opencontainers.image.source=https://github.com/seangumede96-lang/general-
LABEL org.opencontainers.image.description="Assistant video engine: ComfyUI with Wan 2.2 Animate add-ons, no models"
