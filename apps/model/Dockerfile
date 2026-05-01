# syntax=docker/dockerfile:1.7
# v3.4 — bumped base from ubuntu22.04 → ubuntu24.04 so python3.12 is available
# from the default apt repo. Ubuntu 22.04 only ships python3.10 by default,
# making the previous Dockerfile unbuildable.
FROM nvidia/cuda:12.6.0-cudnn-runtime-ubuntu24.04
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive

# Ubuntu 24.04 ships python3.12 natively. PEP 668 protects the system env,
# so pip install uses --break-system-packages below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3.12 python3.12-venv python3.12-dev python3-pip \
        git ffmpeg libgl1 curl \
        build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.12 /usr/local/bin/python

WORKDIR /app

COPY pyproject.toml ./
# Install runtime deps + GPU extras (Torch + Ultralytics + SAM-related libs).
# --break-system-packages: container is isolated, no risk of breaking the host.
RUN pip3 install --no-cache-dir --break-system-packages -e ".[gpu]"

# Plan 11 (SAM 3.1 migration) — install the native sam3 git package separately
# with --no-deps so its `numpy<2` upstream pin does not conflict with the
# project's `numpy==2.2.1`. sam3's other runtime deps (timm, tqdm, regex,
# huggingface_hub, typing_extensions) are already satisfied by the [gpu]
# resolve above; only ftfy + iopath are net-new and installed loose. The
# multi-GB multiplex checkpoint is downloaded lazily at first use.
RUN pip3 install --no-cache-dir --break-system-packages \
        "ftfy==6.1.1" "iopath>=0.1.10" "einops>=0.7" "timm>=1.0.17" \
    && pip3 install --no-cache-dir --break-system-packages --no-deps \
        "git+https://github.com/facebookresearch/sam3.git"

COPY src ./src
ENV PYTHONPATH=/app/src
ENV HF_HOME=/root/.cache/huggingface \
    TRANSFORMERS_CACHE=/root/.cache/huggingface

EXPOSE 8100

# CUDA libraries are present in the base image; PyTorch will detect cuda:0 automatically.
CMD ["uvicorn", "carve_model.main:app", "--host", "0.0.0.0", "--port", "8100"]
