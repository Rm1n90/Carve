# Armin Mehri — mehri.armin@gmail.com
"""SAM 3.1 multiplex track HTTP endpoints (request-style API).

Mirrors the native multiplex predictor's verbs:
    POST   /track/sessions                          — start_session
    POST   /track/sessions/{sid}/prompts            — add_prompt
    POST   /track/sessions/{sid}/propagate          — propagate_in_video (chunked)
    DELETE /track/sessions/{sid}/objects/{obj_id}   — remove_object
    DELETE /track/sessions/{sid}/prompts            — reset_session
    DELETE /track/sessions/{sid}                    — close_session
"""
from __future__ import annotations

import logging
from typing import Any

import json

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from carve_model.sam import track_session as ts
from carve_model.sam.codec import encode_mask_rle
from carve_model.sam.polygonize import mask_to_polygon

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/track", tags=["track"])


# ---- request / response models --------------------------------------------


class OpenSessionIn(BaseModel):
    frame_urls: list[str] = Field(min_length=1)
    image_size: list[int] = Field(min_length=2, max_length=2)
    asset_hash: str = Field(min_length=1, max_length=64)


class OpenSessionOut(BaseModel):
    session_id: str
    frame_count: int


class PromptIn(BaseModel):
    frame_idx: int = Field(ge=0)
    obj_id: int | None = Field(default=None, ge=1, le=256)
    text: str | None = Field(default=None, max_length=200)
    points: list[list[float]] = Field(default_factory=list)
    labels: list[int] = Field(default_factory=list)
    box: list[float] | None = None  # [x1, y1, x2, y2]


class MaskOut(BaseModel):
    counts: str
    size: list[int]
    polygon: list[list[float]]


class FrameMasksOut(BaseModel):
    frame_idx: int
    masks: dict[int, MaskOut]


class PropagateIn(BaseModel):
    start_frame: int | None = Field(default=None, ge=0)
    end_frame: int | None = Field(default=None, ge=0)


class PropagateOut(BaseModel):
    frames: list[FrameMasksOut]


# ---- helpers --------------------------------------------------------------


def _encode_masks(masks: dict[int, Any]) -> dict[int, MaskOut]:
    out: dict[int, MaskOut] = {}
    for obj_id, mask in masks.items():
        counts, size = encode_mask_rle(mask)
        polygon = mask_to_polygon(mask)
        out[int(obj_id)] = MaskOut(counts=counts, size=size, polygon=polygon)
    return out


# ---- endpoints ------------------------------------------------------------


@router.post("/sessions", response_model=OpenSessionOut)
def open_session(payload: OpenSessionIn) -> OpenSessionOut:
    h, w = int(payload.image_size[0]), int(payload.image_size[1])
    if h <= 0 or w <= 0:
        raise HTTPException(status_code=422, detail="invalid_image_size")
    try:
        sess = ts.open_session(
            frame_urls=payload.frame_urls,
            image_size=(h, w),
            asset_hash=payload.asset_hash,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ts.TrackGpuExhausted as exc:
        logger.error("open_session_gpu_oom frames=%d", len(payload.frame_urls))
        raise HTTPException(status_code=507, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return OpenSessionOut(
        session_id=sess.session_id, frame_count=sess.frame_count,
    )


@router.post("/sessions/{sid}/prompts", response_model=FrameMasksOut)
def add_prompt(sid: str, payload: PromptIn) -> FrameMasksOut:
    points: list[tuple[float, float]] | None = None
    if payload.points:
        points = [(float(p[0]), float(p[1])) for p in payload.points]
    box: tuple[float, float, float, float] | None = None
    if payload.box is not None:
        if len(payload.box) != 4:
            raise HTTPException(status_code=422, detail="box_shape_invalid")
        box = (float(payload.box[0]), float(payload.box[1]),
               float(payload.box[2]), float(payload.box[3]))
    try:
        masks = ts.add_prompt(
            sid,
            frame_idx=payload.frame_idx,
            obj_id=payload.obj_id,
            text=payload.text,
            points=points,
            labels=payload.labels or None,
            box=box,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ts.TrackGpuExhausted as exc:
        logger.error("add_prompt_gpu_oom sid=%s", sid)
        raise HTTPException(status_code=507, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("add_prompt_failed sid=%s", sid)
        raise HTTPException(
            status_code=502, detail=f"add_prompt_failed: {exc!r}",
        ) from exc
    return FrameMasksOut(frame_idx=payload.frame_idx, masks=_encode_masks(masks))


@router.post("/sessions/{sid}/propagate", response_model=PropagateOut)
def propagate(sid: str, payload: PropagateIn) -> PropagateOut:
    try:
        frames = ts.propagate(
            sid, start_frame=payload.start_frame, end_frame=payload.end_frame,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("propagate_failed sid=%s", sid)
        raise HTTPException(
            status_code=502, detail=f"propagate_failed: {exc!r}",
        ) from exc
    return PropagateOut(
        frames=[
            FrameMasksOut(frame_idx=f["frame_idx"], masks=_encode_masks(f["masks"]))
            for f in frames
        ],
    )


@router.post("/sessions/{sid}/propagate/stream")
def propagate_stream(sid: str, payload: PropagateIn) -> StreamingResponse:
    """NDJSON streaming variant — one ``{"frame_idx", "masks"}`` JSON
    object per line as soon as the multiplex predictor yields it.

    Lets the browser drive a real progress bar (per-frame ticks) instead
    of buffering the entire 446-frame mask payload before any UI update.
    Each line ends in ``\n``; clients should split on newline and parse
    each non-empty line as one JSON record. The final ``200`` only
    arrives once the stream closes; HTTP-level errors that fire AFTER
    the headers are sent show up as a ``__error__`` line and a closed
    connection.
    """
    def gen():
        try:
            for entry in ts.propagate_stream(
                sid,
                start_frame=payload.start_frame,
                end_frame=payload.end_frame,
            ):
                encoded = _encode_masks(entry["masks"])
                line = {
                    "frame_idx": entry["frame_idx"],
                    "masks": {
                        str(oid): {
                            "counts": v.counts,
                            "size": v.size,
                            "polygon": v.polygon,
                        }
                        for oid, v in encoded.items()
                    },
                }
                yield (json.dumps(line) + "\n").encode()
        except LookupError as exc:
            yield (json.dumps({"__error__": str(exc), "code": 404}) + "\n").encode()
        except ts.TrackGpuExhausted as exc:
            logger.error("propagate_stream_gpu_oom sid=%s", sid)
            yield (json.dumps({
                "__error__": str(exc),
                "code": 507,
                "error_code": "track_gpu_exhausted",
            }) + "\n").encode()
        except Exception as exc:  # noqa: BLE001
            logger.exception("propagate_stream_failed sid=%s", sid)
            yield (json.dumps({"__error__": repr(exc), "code": 502}) + "\n").encode()
    return StreamingResponse(gen(), media_type="application/x-ndjson")


@router.delete("/sessions/{sid}/objects/{obj_id}")
def remove_object(sid: str, obj_id: int):
    try:
        ts.remove_object(sid, obj_id=obj_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("remove_object_failed sid=%s obj_id=%s", sid, obj_id)
        raise HTTPException(
            status_code=502, detail=f"remove_object_failed: {exc!r}",
        ) from exc
    return Response(status_code=204)


@router.delete("/sessions/{sid}/prompts")
def reset_prompts(sid: str):
    try:
        ts.reset_prompts(sid)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("reset_prompts_failed sid=%s", sid)
        raise HTTPException(
            status_code=502, detail=f"reset_prompts_failed: {exc!r}",
        ) from exc
    return Response(status_code=204)


@router.delete("/sessions/{sid}")
def close_session(sid: str):
    if not ts.close_session(sid):
        raise HTTPException(status_code=404, detail="session_not_found")
    return Response(status_code=204)
