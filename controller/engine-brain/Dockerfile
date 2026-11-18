# The private brain's machine: llama.cpp's own CUDA server image, plus two small tools:
#   busybox  - a tiny web server, started first, so the app hears from the machine within seconds
#   aria2    - downloads the model over many connections at once, and reports exact progress
# Built by .github/workflows/brain-engine-image.yml; each build freezes the llama.cpp version it got.
FROM docker.io/library/busybox:1.37-musl AS bb
FROM ghcr.io/ggml-org/llama.cpp:server-cuda
COPY --from=bb /bin/busybox /usr/local/bin/busybox
RUN apt-get update \
	&& apt-get install -y --no-install-recommends aria2 ca-certificates \
	&& apt-get clean && rm -rf /var/lib/apt/lists/* \
	&& busybox --help >/dev/null && aria2c --version | head -1
ENTRYPOINT []
