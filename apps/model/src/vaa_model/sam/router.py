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
                    ``sam3_not_enabled`` when ``SAM_VARIANT != "sam3"``;
                    503 ``sam3_predictor_not_loaded`` when SAM 3 is on
                    but no predictor factory has been registered.
"""

import base64
import os
from io import BytesIO
from typing import Any

import numpy as np
import xxhash
from fastapi import APIRouter, HTTPException
from PIL import Image
from pydantic import BaseModel, Field

from vaa_model.sam.codec import encode_mask_rle
from vaa_model.sam.predictor import get_predictor, get_text_predictor

router = APIRouter(prefix="/sam", tags=["sam"])

_LOADED_HASH: str | None = None  # the most recently encoded image's xxh3
_LOADED_SHAPE: list[int] = []     # [h, w]


def get_sam_variant() -> str:
    """Read the SAM_VARIANT env var on every call.

    Tests mutate the env via ``monkeypatch``; reading at request time keeps
    the toggle hot-swappable without re-importing the module.
    """
    return os.getenv("SAM_VARIANT", "sam2")


class EncodeIn(BaseModel):
    image_b64: str


class EncodeOut(BaseModel):
    image_hash: str
    shape: list[int]


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
    global _LOADED_HASH, _LOADED_SHAPE
    try:
        img_bytes = base64.b64decode(payload.image_b64)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="bad_image_b64") from exc

    h = xxhash.xxh3_128(img_bytes).hexdigest()
    img = np.array(Image.open(BytesIO(img_bytes)).convert("RGB"))
    p = get_predictor()
    p.set_image(img)
    _LOADED_HASH = h
    _LOADED_SHAPE = [int(img.shape[0]), int(img.shape[1])]
    return EncodeOut(image_hash=h, shape=_LOADED_SHAPE)


@router.post("/decode", response_model=DecodeOut)
def decode(payload: DecodeIn) -> DecodeOut:
    if _LOADED_HASH is None or _LOADED_HASH != payload.image_hash:
        raise HTTPException(
            status_code=409,
            detail="embedding_not_loaded; call /sam/encode again",
        )
    if len(payload.points) != len(payload.labels):
        raise HTTPException(status_code=422, detail="points and labels must have equal length")

    pts = np.asarray(payload.points)
    lbl = np.asarray(payload.labels)
    p = get_predictor()
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
    """Clear the cached image hash. Used in tests to guarantee independence."""
    global _LOADED_HASH, _LOADED_SHAPE
    _LOADED_HASH = None
    _LOADED_SHAPE = []


# --- SAM 3 text-prompt endpoint ---------------------------------------------
#
# The endpoint is a thin shell: it gates on ``SAM_VARIANT`` and delegates the
# real inference to a predictor factory the operator registers at container
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
