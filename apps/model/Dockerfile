# syntax=docker/dockerfile:1.7
FROM nvidia/cuda:12.6.0-cudnn-runtime-ubuntu22.04
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3.12 python3.12-venv python3.12-dev python3-pip \
        git ffmpeg libgl1 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
# Install runtime deps + GPU extras (Torch + Ultralytics + SAM-related libs).
RUN pip3 install --no-cache-dir -e ".[gpu]"
# SAM 2 from upstream (not on PyPI under that name).
RUN pip3 install --no-cache-dir git+https://github.com/facebookresearch/sam2.git

COPY src ./src
ENV PYTHONPATH=/app/src

EXPOSE 8100

# CUDA libraries are present in the base image; PyTorch will detect cuda:0 automatically.
CMD ["uvicorn", "vaa_model.main:app", "--host", "0.0.0.0", "--port", "8100"]
