"""YOLOE inference HTTP endpoints (v3.23).

Three predict endpoints (one per prompting mode), one capability
probe, and a best-effort unload. The endpoints accept base64-encoded
image bytes, decode + run Ultralytics, and return the same shape the
YOLO predict path produces so the api service's class-mapping +
persistence layer is reused.

A 503 is returned when the model service hasn't been configured (no
loader installed) or when the .pt file is missing on disk — the
operator must opt-in by shipping the weights to the container.
"""

from __future__ import annotations

import base64
import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from carve_model.gpu import get_device
from carve_model.yoloe.predict import (
    predict_prompt_free,
    predict_text,
    predict_visual,
)
from carve_model.yoloe.registry import REGISTRY, YoloeKey

log = logging.getLogger(__name__)

router = APIRouter(prefix="/yoloe", tags=["yoloe"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class TextPredictIn(BaseModel):
    image_b64: str = Field(..., min_length=1)
    classes: list[str] = Field(..., min_length=1, max_length=100)
    conf: float = Field(default=0.25, ge=0.0, le=1.0)
    iou: float = Field(default=0.7, ge=0.0, le=1.0)


class VisualPredictIn(BaseModel):
    target_b64: str = Field(..., min_length=1)
    refer_b64: str = Field(..., min_length=1)
    # v3.23.7 — bumped from 64 to 256. YOLOE has no real limit on the
    # number of visual prompts; the Pydantic cap is purely a guard
    # against a runaway client and shouldn't bother legitimate use.
    bboxes: list[list[float]] = Field(..., min_length=1, max_length=256)
    cls: list[int] = Field(..., min_length=1, max_length=256)
    class_names: list[str] = Field(default_factory=list, max_length=256)
    conf: float = Field(default=0.25, ge=0.0, le=1.0)
    iou: float = Field(default=0.7, ge=0.0, le=1.0)


class PromptFreePredictIn(BaseModel):
    image_b64: str = Field(..., min_length=1)
    conf: float = Field(default=0.25, ge=0.0, le=1.0)
    iou: float = Field(default=0.7, ge=0.0, le=1.0)
    max_detections: int | None = Field(default=None, ge=1, le=1000)


class StatusOut(BaseModel):
    available: bool
    text_available: bool
    pf_available: bool
    text_loaded: bool
    pf_loaded: bool
    device: str


class UnloadOut(BaseModel):
    evicted: list[str]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _decode_b64(value: str, *, label: str) -> bytes:
    """Decode a base64 image payload, mapping failures to a 422."""
    try:
        return base64.b64decode(value)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"bad_b64:{label}") from exc


def _get_model(key: YoloeKey) -> Any:
    """Load (lazily) and return the YOLOE model for ``key``.

    503 ``yoloe_not_configured`` — loader not installed (lifespan didn't run).
    503 ``yoloe_weight_missing`` — .pt file isn't on disk.
    """
    try:
        return REGISTRY.get(key)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="yoloe_not_configured") from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=f"yoloe_weight_missing:{key}") from exc


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/status", response_model=StatusOut)
def status() -> StatusOut:
    """Capability probe used by the api service + frontend.

    ``available`` is True when at least one checkpoint is on-disk —
    that's the gate the editor toolbar checks before showing the
    YOLOE button.
    """
    text_avail = REGISTRY.is_available("text")
    pf_avail = REGISTRY.is_available("pf")
    return StatusOut(
        available=bool(text_avail or pf_avail),
        text_available=text_avail,
        pf_available=pf_avail,
        text_loaded=REGISTRY.is_loaded("text"),
        pf_loaded=REGISTRY.is_loaded("pf"),
        device=get_device(),
    )


@router.post("/text-predict")
def text_predict(payload: TextPredictIn) -> dict:
    image_bytes = _decode_b64(payload.image_b64, label="image_b64")
    model = _get_model("text")
    try:
        return predict_text(
            model,
            image_bytes,
            payload.classes,
            conf=payload.conf,
            iou=payload.iou,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/visual-predict")
def visual_predict(payload: VisualPredictIn) -> dict:
    target = _decode_b64(payload.target_b64, label="target_b64")
    refer = _decode_b64(payload.refer_b64, label="refer_b64")
    if len(payload.bboxes) != len(payload.cls):
        raise HTTPException(status_code=422, detail="bboxes_cls_length_mismatch")
    model = _get_model("text")  # visual prompts use the same checkpoint
    try:
        return predict_visual(
            model,
            target,
            refer,
            payload.bboxes,
            payload.cls,
            payload.class_names,
            conf=payload.conf,
            iou=payload.iou,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/prompt-free-predict")
def prompt_free_predict(payload: PromptFreePredictIn) -> dict:
    image_bytes = _decode_b64(payload.image_b64, label="image_b64")
    model = _get_model("pf")
    return predict_prompt_free(
        model,
        image_bytes,
        conf=payload.conf,
        iou=payload.iou,
        max_detections=payload.max_detections,
    )


@router.post("/unload", response_model=UnloadOut)
def unload() -> UnloadOut:
    """Drop both YOLOE checkpoints from GPU memory.

    Best-effort: idempotent, never raises. Used by the System page's
    "Unload all models" button + the api worker's post-batch cleanup.
    """
    return UnloadOut(evicted=list(REGISTRY.evict_all()))
