"""YOLO inference HTTP endpoints.

POST /yolo/load takes a presigned URL pointing at a .pt file stored in MinIO,
downloads it to a temp file, and registers the model in the LRU.

POST /yolo/predict takes a base64-encoded image and runs predict_image.
Returns 409 if the weight isn't loaded.
"""

import base64
import urllib.parse
import urllib.request
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from vaa_model.yolo.predict import predict_image
from vaa_model.yolo.registry import REGISTRY

# Hard cap on downloaded weight size to defend against disk-exhaustion attacks
# via attacker-supplied URLs. 2 GiB matches the api-side WEIGHT upload cap.
_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
_DOWNLOAD_TIMEOUT_SECONDS = 60.0

router = APIRouter(prefix="/yolo", tags=["yolo"])


class LoadIn(BaseModel):
    weight_id: str = Field(min_length=1, max_length=128)
    weights_url: str


class LoadOut(BaseModel):
    loaded: str


class PredictIn(BaseModel):
    weight_id: str = Field(min_length=1, max_length=128)
    image_b64: str
    conf: float = Field(default=0.25, ge=0.0, le=1.0)
    iou: float = Field(default=0.7, ge=0.0, le=1.0)


# Indirection so tests can monkeypatch
def _download(url: str, dest: str) -> None:
    """Stream-download a URL to dest. Rejects non-http(s) schemes to block
    file:// / ftp:// SSRF-style abuse. Caps body size and request timeout."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"scheme_not_allowed: {parsed.scheme}")
    written = 0
    with urllib.request.urlopen(url, timeout=_DOWNLOAD_TIMEOUT_SECONDS) as r:  # noqa: S310 — scheme guarded above
        with open(dest, "wb") as fh:
            while True:
                chunk = r.read(64 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > _MAX_DOWNLOAD_BYTES:
                    raise ValueError("download_too_large")
                fh.write(chunk)


@router.post("/load", response_model=LoadOut)
def load_weight(payload: LoadIn) -> LoadOut:
    with NamedTemporaryFile(suffix=".pt", delete=False) as fh:
        path = Path(fh.name)
    try:
        try:
            _download(payload.weights_url, str(path))
        except Exception as exc:  # noqa: BLE001 — wrap any URL/network failure as 502
            path.unlink(missing_ok=True)
            raise HTTPException(status_code=502, detail="weight_download_failed") from exc
        try:
            REGISTRY.load(payload.weight_id, path)
        except RuntimeError as exc:
            # Loader not configured — production should always have one set on startup.
            path.unlink(missing_ok=True)
            raise HTTPException(status_code=503, detail="loader_not_configured") from exc
    finally:
        # The LRU holds the loaded model object in memory; the on-disk .pt is
        # no longer needed once Ultralytics has parsed it. Unlink unconditionally
        # to avoid /tmp leaks across many /yolo/load calls.
        path.unlink(missing_ok=True)
    return LoadOut(loaded=payload.weight_id)


@router.post("/predict")
def predict(payload: PredictIn) -> dict:
    model = REGISTRY.get(payload.weight_id)
    if model is None:
        raise HTTPException(status_code=409, detail="weight_not_loaded")
    try:
        image_bytes = base64.b64decode(payload.image_b64)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="bad_image_b64") from exc
    return predict_image(model, image_bytes, conf=payload.conf, iou=payload.iou)
