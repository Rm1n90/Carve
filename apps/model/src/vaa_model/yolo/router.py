"""YOLO inference HTTP endpoints.

POST /yolo/load takes a presigned URL pointing at a .pt file stored in MinIO,
downloads it to a temp file, and registers the model in the LRU.

POST /yolo/predict takes a base64-encoded image and runs predict_image.
Returns 409 if the weight isn't loaded.
"""

import base64
import urllib.request
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from vaa_model.yolo.predict import predict_image
from vaa_model.yolo.registry import REGISTRY

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
    urllib.request.urlretrieve(url, dest)  # noqa: S310 — internal MinIO presigned URL


@router.post("/load", response_model=LoadOut)
def load_weight(payload: LoadIn) -> LoadOut:
    with NamedTemporaryFile(suffix=".pt", delete=False) as fh:
        path = Path(fh.name)
    try:
        _download(payload.weights_url, str(path))
    except Exception as exc:  # noqa: BLE001 — wrap any URL/network failure as 502
        raise HTTPException(status_code=502, detail="weight_download_failed") from exc
    try:
        REGISTRY.load(payload.weight_id, path)
    except RuntimeError as exc:
        # Loader not configured — production should always have one set on startup.
        raise HTTPException(status_code=503, detail="loader_not_configured") from exc
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
