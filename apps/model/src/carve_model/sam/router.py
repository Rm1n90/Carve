"""SAM 2 HTTP endpoints.

POST /sam/encode  — accepts {image_b64} → returns {image_hash, shape}.
                    The encoder runs once per image; the predictor is sticky
                    to a single instance (SAM 2 keeps embedded state inside
                    the predictor object, not externally serialisable).

POST /sam/decode  — accepts {image_hash, points, labels} → returns
                    {counts, size, score}. Returns 409 if the embedding for
                    image_hash isn't currently loaded (caller must re-encode).

POST /sam/text-prompt — SAM 3 only. Accepts {image_b64, text} → returns
                    [{counts, size, score, bbox}]. Returns 409
                    ``sam3_not_enabled`` when the configured SAM model is
                    not ``sam3``; 503 ``sam3_predictor_not_loaded`` when
                    SAM 3 is on but no predictor factory has been
                    registered.

POST /sam/box-prompt — SAM 3 only (one-shot). Accepts
                    {image_b64, boxes, box_labels, text?} → returns
                    [{counts, size, score, bbox}]. Boxes are xyxy floats;
                    box_labels are 1 (positive include) or 0 (negative
                    exclude). The optional ``text`` field combines with
                    boxes to refine a concept (e.g., text + negative
                    box). Returns 409 ``sam3_box_prompt_requires_sam3``
                    when SAM 3 is not the active model; 503
                    ``sam3_box_predictor_not_loaded`` when SAM 3 is on
                    but no box predictor factory has been registered.
"""

import base64
from io import BytesIO
from typing import Any, Literal

import numpy as np
import xxhash
from fastapi import APIRouter, Body, HTTPException
from PIL import Image
from pydantic import BaseModel, Field

from carve_model.sam.codec import encode_mask_rle
from carve_model.sam.predictor import (
    ALLOWED_SAM_MODELS,
    _reset_singleton,
    autocast_ctx,
    extract_embedding,
    force_evict_predictor,
    get_box_predictor,
    get_predictor,
    get_sam_model,
    get_sam_variant,
    get_session,
    get_text_predictor,
    load_predictor,
    set_loaded_image,
)
from carve_model.sam.tracker import force_evict_all_sessions

router = APIRouter(prefix="/sam", tags=["sam"])


class EncodeIn(BaseModel):
    image_b64: str


class EncodeOut(BaseModel):
    image_hash: str
    shape: list[int]
    # Base64-encoded float16 image embedding when the active predictor
    # exposes one. ``None`` for the test fake or predictors without
    # ``_features``; callers fall back to server-side decode in that case.
    embedding_b64: str | None = None


class DecodeIn(BaseModel):
    image_hash: str
    points: list[list[int]] = Field(min_length=1)
    labels: list[int] = Field(min_length=1)


class DecodeOut(BaseModel):
    counts: str
    size: list[int]
    score: float


@router.post("/encode", response_model=EncodeOut)
def encode(payload: EncodeIn) -> EncodeOut:
    try:
        img_bytes = base64.b64decode(payload.image_b64)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="bad_image_b64") from exc

    h = xxhash.xxh3_128(img_bytes).hexdigest()
    img = np.array(Image.open(BytesIO(img_bytes)).convert("RGB"))
    p = get_predictor()
    p.set_image(img)
    shape = [int(img.shape[0]), int(img.shape[1])]
    # Record the loaded image's hash + shape on the active session so a
    # subsequent /sam/decode can verify the predictor still holds these
    # encoded features. Lifecycle ops (evict, force-evict, switch) drop
    # the session as a unit — preventing the v3.4 desync where the hash
    # gate passed but the predictor's _raw_image had been cleared.
    set_loaded_image(h, shape)
    embedding_bytes = extract_embedding(p)
    embedding_b64 = (
        base64.b64encode(embedding_bytes).decode("ascii")
        if embedding_bytes is not None
        else None
    )
    return EncodeOut(image_hash=h, shape=shape, embedding_b64=embedding_b64)


@router.post("/decode", response_model=DecodeOut)
def decode(payload: DecodeIn) -> DecodeOut:
    session = get_session()
    if session is None or session.loaded_hash != payload.image_hash:
        raise HTTPException(
            status_code=409,
            detail="embedding_not_loaded; call /sam/encode again",
        )
    if len(payload.points) != len(payload.labels):
        raise HTTPException(status_code=422, detail="points and labels must have equal length")

    pts = np.asarray(payload.points)
    lbl = np.asarray(payload.labels)
    p = get_predictor()
    with autocast_ctx():
        masks, scores, _ = p.predict(point_coords=pts, point_labels=lbl, multimask_output=True)

    masks_np = _to_numpy(masks)
    scores_np = _to_numpy(scores)
    if masks_np.ndim != 3 or scores_np.ndim < 1:
        raise HTTPException(status_code=500, detail="unexpected_predictor_output")
    best = int(np.argmax(scores_np))
    counts, size = encode_mask_rle(masks_np[best])
    return DecodeOut(counts=counts, size=size, score=float(scores_np[best]))


def _to_numpy(arr: Any) -> np.ndarray:
    if hasattr(arr, "cpu"):
        return arr.cpu().numpy()
    return np.asarray(arr)


def _reset_for_test() -> None:
    """Clear the cached image hash. Used in tests to guarantee independence.

    The image hash now lives on ``predictor._SESSION``, so resetting the
    router's view of "what's loaded" is the same as resetting the
    predictor's session.
    """
    _reset_singleton()


# --- SAM 3 text-prompt endpoint ---------------------------------------------
#
# The endpoint is a thin shell: it gates on the configured SAM model
# (``SAM_MODEL`` with legacy ``SAM_VARIANT`` fallback — see
# ``carve_model.sam.predictor.get_sam_model``) and delegates the real
# inference to a predictor factory the operator registers at container
# start. The actual SAM 3 model loading (gated HF repo, license, HF token)
# happens outside this module — see ``apps/docs/admin.md``.


class TextPromptIn(BaseModel):
    image_b64: str
    text: str = Field(..., min_length=1, max_length=200)


class TextPromptOut(BaseModel):
    counts: str
    size: list[int]
    score: float
    bbox: list[float]  # xyxy


@router.post("/text-prompt", response_model=list[TextPromptOut])
def sam_text_prompt(payload: TextPromptIn) -> list[dict]:
    if get_sam_variant() != "sam3":
        raise HTTPException(status_code=409, detail="sam3_not_enabled")
    try:
        factory = get_text_predictor()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=503,
            detail="sam3_predictor_not_loaded",
        ) from exc
    return factory(image_b64=payload.image_b64, text=payload.text)


# --- SAM 3 box-prompt endpoint ----------------------------------------------
#
# One-shot endpoint: takes image_b64 + boxes (+ optional text) and returns
# the masks. Mirrors the /sam/text-prompt pattern (no per-image cache; the
# image is encoded each call). The /sam/encode → /sam/decode flow remains
# the click-driven path; box prompts are typically used in single
# interactive selections in the editor UI, so a sticky cache is not worth
# the lifecycle complexity.


class BoxPromptIn(BaseModel):
    image_b64: str
    boxes: list[list[float]] = Field(min_length=1)  # each [x1, y1, x2, y2]
    box_labels: list[int] = Field(min_length=1)     # 1=positive, 0=negative
    text: str | None = Field(default=None, max_length=200)


class BoxPromptOut(BaseModel):
    counts: str
    size: list[int]
    score: float
    bbox: list[float]  # xyxy


@router.post("/box-prompt", response_model=list[BoxPromptOut])
def sam_box_prompt(payload: BoxPromptIn) -> list[dict]:
    if get_sam_variant() != "sam3":
        raise HTTPException(status_code=409, detail="sam3_box_prompt_requires_sam3")
    if len(payload.boxes) != len(payload.box_labels):
        raise HTTPException(
            status_code=422,
            detail="boxes and box_labels must have equal length",
        )
    if any(label not in (0, 1) for label in payload.box_labels):
        raise HTTPException(
            status_code=422,
            detail="box_labels must be 0 or 1",
        )
    try:
        factory = get_box_predictor()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=503,
            detail="sam3_box_predictor_not_loaded",
        ) from exc
    return factory(
        image_b64=payload.image_b64,
        boxes=payload.boxes,
        box_labels=payload.box_labels,
        text=payload.text,
    )


# --- /sam/unload (admin force-evict) ----------------------------------------
#
# Only reachable on the internal Docker network — Caddy does not proxy
# ``/model/*``. The idle sweeper runs in main.py's lifespan; this endpoint
# lets the operator unload immediately (e.g. before a YOLO training run).


class UnloadIn(BaseModel):
    which: Literal["image", "tracker", "all"] = "all"


class UnloadOut(BaseModel):
    evicted: list[str]
    sessions_released: int


@router.post("/unload", response_model=UnloadOut)
def unload(payload: UnloadIn = Body(default_factory=UnloadIn)) -> UnloadOut:
    """Force-unload SAM models from GPU memory. Idempotent."""
    evicted: list[str] = []
    sessions_released = 0
    if payload.which in ("image", "all"):
        if force_evict_predictor():
            evicted.append("image")
    if payload.which in ("tracker", "all"):
        sessions_released = force_evict_all_sessions()
        if sessions_released > 0:
            evicted.append("tracker")
    return UnloadOut(evicted=evicted, sessions_released=sessions_released)


# --- /sam/switch (variant hot-swap) -----------------------------------------
#
# v3.0 Bug 7 — replaces the old "edit SAM_MODEL in .env and restart" flow.
# Loading a variant takes 5-30s; the endpoint blocks the calling worker
# for the full duration so failures surface synchronously with the right
# HTTP status. The API service proxies this with a 60s httpx timeout.


class SwitchIn(BaseModel):
    variant: str = Field(..., min_length=1)


class SwitchOut(BaseModel):
    active_variant: str


@router.post("/switch", response_model=SwitchOut)
def switch(payload: SwitchIn) -> SwitchOut:
    """Hot-swap the active SAM variant. 422 on unknown variant; 503 on load failure."""
    if payload.variant not in ALLOWED_SAM_MODELS:
        raise HTTPException(
            status_code=422,
            detail=f"unknown_variant; allowed: {', '.join(ALLOWED_SAM_MODELS)}",
        )
    try:
        load_predictor(payload.variant)
    except ValueError as exc:
        # Defensive: ALLOWED_SAM_MODELS check above should already cover this,
        # but ``load_predictor`` re-validates and we want the same 422 response.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — model load can fail many ways
        raise HTTPException(
            status_code=503,
            detail="sam_variant_load_failed",
        ) from exc
    return SwitchOut(active_variant=get_sam_model())
