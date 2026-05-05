# syntax=docker/dockerfile:1.7
# VLM-FO1 sidecar — runs the upstream om-ai-lab/VLM-FO1 package on its
# native transformers==4.50.1, isolated from the main model service
# which runs SAM 3 on transformers==5.0.0.
FROM nvidia/cuda:12.6.0-cudnn-runtime-ubuntu24.04
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3.12 python3.12-venv python3.12-dev python3-pip \
        git libgl1 curl \
        build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.12 /usr/local/bin/python

WORKDIR /app

COPY pyproject.toml ./
RUN pip3 install --no-cache-dir --break-system-packages -e ".[gpu]"

# Install the upstream vlm_fo1 package (source-only, no setup.py) by
# cloning and copying its package directory into site-packages.
RUN git clone --depth=1 https://github.com/om-ai-lab/VLM-FO1.git /tmp/vlm-fo1 \
    && SITE_PKG="$(python -c 'import site; print(site.getsitepackages()[0])')" \
    && cp -r /tmp/vlm-fo1/vlm_fo1 "$SITE_PKG/" \
    && rm -rf /tmp/vlm-fo1

COPY src ./src
ENV PYTHONPATH=/app/src
ENV HF_HOME=/root/.cache/huggingface \
    TRANSFORMERS_CACHE=/root/.cache/huggingface

EXPOSE 8101

CMD ["uvicorn", "model_vlm_fo1.main:app", "--host", "0.0.0.0", "--port", "8101"]
