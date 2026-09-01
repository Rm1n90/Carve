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

# v3.23.3 — YOLOE text-prompt mode requires OpenAI CLIP (Ultralytics'
# text encoder imports the ``clip`` module). Without this, every
# /yoloe/text-predict call 502s with ``ModuleNotFoundError: clip``.
# Installed with --no-deps so torch/torchvision pins from the [gpu]
# extra are preserved. The mobileclip2_b.ts text encoder weights
# (~242 MB) are auto-downloaded by Ultralytics on first use.
RUN pip3 install --no-cache-dir --break-system-packages --no-deps \
        "git+https://github.com/openai/CLIP.git"

# YOLOv5 compatibility.
#
# Classic YOLOv5 checkpoints (from the ultralytics/yolov5 repo, as opposed
# to the anchor-free "v5u" weights the ultralytics package ships) pickle
# their layer classes from that repo's TOP-LEVEL ``models`` and ``utils``
# packages. Unpickling therefore needs those modules importable, which the
# ultralytics package alone cannot provide — it only remaps its own legacy
# module paths. Without this, such a weight fails to load with
# ``ModuleNotFoundError: No module named 'models'``, which surfaced as a
# weight uploading fine but reporting "0 classes" and failing every predict.
#
# Pinned to the v7.0 tag rather than tracking master so a checkpoint that
# loads today keeps loading. Installed to /opt/yolov5 and deliberately NOT
# added to PYTHONPATH: ``utils`` is far too generic a name to put on the
# global path, so carve_model.yolo.yolov5_compat inserts it only for the
# duration of a load. Same AGPL-3.0 licence as the ultralytics package
# already vendored here.
#
# The repo's models/common.py imports pandas and IPython at module level,
# and utils/plots.py imports seaborn, so unpickling pulls all three in even
# though none of their features are used. They are the only pieces of
# yolov5's requirements.txt this image does not already satisfy — torch,
# torchvision, opencv, matplotlib, scipy, tqdm, PyYAML, psutil, requests
# and thop all come from the ultralytics install above.
RUN git clone --depth 1 --branch v7.0 https://github.com/ultralytics/yolov5.git /opt/yolov5 && rm -rf /opt/yolov5/.git && pip3 install --no-cache-dir --break-system-packages "pandas>=2.0,<3" "seaborn>=0.13" "ipython>=8,<10"
ENV CARVE_YOLOV5_DIR=/opt/yolov5

# NOTE: VLM-FO1 was extracted into a separate sidecar service
# (apps/model-vlm-fo1) when it became clear the upstream package
# requires transformers==4.50.1, incompatible with this image's
# transformers==5.0.0 used by SAM 3. The model service now calls the
# sidecar over HTTP — see carve_model.vlm_fo1.adapter.

COPY src ./src
ENV PYTHONPATH=/app/src
ENV HF_HOME=/root/.cache/huggingface \
    TRANSFORMERS_CACHE=/root/.cache/huggingface

EXPOSE 8100

# CUDA libraries are present in the base image; PyTorch will detect cuda:0 automatically.
CMD ["uvicorn", "carve_model.main:app", "--host", "0.0.0.0", "--port", "8100"]
