# Armin Mehri — mehri.armin@gmail.com
"""App-side SAM proxy.

The api fetches the asset's bytes from MinIO and forwards a base64-encoded
copy to the model service. The model service returns
``{image_hash, shape, embedding_b64?}`` and is the *single* source of
truth for whether an embedding is currently loaded.

v3.5 Phase A2: the previous Redis ``sam:embed:<hash>`` cache (30-minute
TTL) was dropped because it could return a "successful" encode result
to the client without the model service ever performing one — which
caused the next ``/sam/decode`` to 409 (or worse, 500 pre-A1) because
the model worker didn't actually have the image loaded. SAM2 encode is
~hundreds of ms on a single image and the click-driven SAM tool caches
the ``image_hash`` on the SamTool, so repeated activations on the same
image are amortised by the tool itself; an API-layer cache traded
latency for correctness.
"""

import base64
import uuid

from carve_api.assets.models import Asset
from carve_api.errors import AppError
from carve_api.inference.autoannotate import fetch_asset_bytes
from carve_api.inference.model_client import (
    ModelServiceError,
    sam_box_prompt,
    sam_decode,
    sam_encode,
    sam_text_prompt,
)


class SamModelFailed(AppError):
    http_status = 502
    code = "sam_model_failed"


class SamModelUnreachable(AppError):
    """Model service is offline (DNS/connect/timeout) — distinct from 5xx.

    Raised when the carve api can't even open a connection to the model
    service (e.g. the docker-compose ``inference`` profile isn't running).
    Maps to a 503 response with ``error: model_service_unreachable`` so the
    SAM tool in the web app can show a clear "model service is offline"
    toast instead of treating it as a generic upstream error.
    """

    http_status = 503
    code = "model_service_unreachable"


class SamEmbeddingMissing(AppError):
    http_status = 409
    code = "sam_embedding_missing"


class Sam3NotEnabled(AppError):
    """Active SAM variant is not SAM 3 — text/box prompts require SAM 3.

    The model service's /sam/text-prompt and /sam/box-prompt endpoints
    return 409 when ``get_sam_variant() != "sam3"``. The carve api maps
    that to this error so the editor's mode picker can disable text +
    box modes (or surface a "switch to SAM 3" hint) instead of letting
    the user click into a guaranteed-fail flow.
    """

    http_status = 409
    code = "sam3_not_enabled"


def sam_encode_for_asset(
    asset: Asset, frame_id: uuid.UUID | None = None
) -> dict:
    """Encode the asset on the model service.

    Always round-trips to the model service so the returned ``image_hash``
    corresponds to a predictor that has actually called ``set_image()``.
    No API-side cache — see module docstring for rationale.

    v3.8 Phase 4-video step F4 — when ``frame_id`` is provided (video
    asset path), reads the per-frame JPEG instead of the original file.
    """
    body = fetch_asset_bytes(asset, frame_id=frame_id)
    b64 = base64.b64encode(body).decode("ascii")
    try:
        return sam_encode(b64)
    except ModelServiceError as exc:
        if exc.status_code == 503:
            raise SamModelUnreachable(f"encode: {exc.body!r}") from exc
        raise SamModelFailed(f"encode: {exc.body!r}") from exc


def sam_decode_with_hash(
    image_hash: str,
    points: list[list[int]],
    labels: list[int],
    box: list[float] | None = None,
) -> dict:
    if len(points) != len(labels):
        raise SamModelFailed("points and labels must have equal length")
    if not points and box is None:
        raise SamModelFailed("at least one of points or box must be provided")
    try:
        return sam_decode(image_hash, points, labels, box=box)
    except ModelServiceError as exc:
        if exc.status_code == 409:
            raise SamEmbeddingMissing("embedding not loaded; call /sam/encode first") from exc
        if exc.status_code == 503:
            raise SamModelUnreachable(f"decode: {exc.body!r}") from exc
        raise SamModelFailed(f"decode: {exc.body!r}") from exc


def sam_text_prompt_for_asset(
    asset: Asset, text: str, frame_id: uuid.UUID | None = None
) -> list[dict]:
    """SAM 3 text-prompt entry point.

    Encodes the asset's bytes once and forwards them to the model
    service alongside the supplied text concept. Maps the model
    service's 409 (sam3_not_enabled) and 503 (unreachable / predictor
    not loaded) onto AppErrors so the router/web layer can render a
    consistent error envelope.

    v3.8 Phase 4-video step F4 — ``frame_id`` selects a per-frame JPEG
    for video assets.
    """
    body = fetch_asset_bytes(asset, frame_id=frame_id)
    b64 = base64.b64encode(body).decode("ascii")
    try:
        return sam_text_prompt(b64, text)
    except ModelServiceError as exc:
        if exc.status_code == 409:
            raise Sam3NotEnabled(f"text-prompt: {exc.body!r}") from exc
        if exc.status_code == 503:
            raise SamModelUnreachable(f"text-prompt: {exc.body!r}") from exc
        raise SamModelFailed(f"text-prompt: {exc.body!r}") from exc


def sam_box_prompt_for_asset(
    asset: Asset,
    boxes: list[list[float]],
    box_labels: list[int],
    text: str | None = None,
    frame_id: uuid.UUID | None = None,
) -> list[dict]:
    """SAM 3 box-prompt entry point.

    ``boxes`` are xyxy floats and ``box_labels`` are 1=include, 0=exclude.
    Optionally combines with a text concept. Maps the same 409 / 503
    upstream signals onto the SAM AppErrors used elsewhere in the proxy.
    """
    if len(boxes) != len(box_labels):
        raise SamModelFailed("boxes and box_labels must have equal length")
    if any(label not in (0, 1) for label in box_labels):
        raise SamModelFailed("box_labels must be 0 or 1")
    body = fetch_asset_bytes(asset, frame_id=frame_id)
    b64 = base64.b64encode(body).decode("ascii")
    try:
        return sam_box_prompt(b64, boxes, box_labels, text=text)
    except ModelServiceError as exc:
        if exc.status_code == 409:
            raise Sam3NotEnabled(f"box-prompt: {exc.body!r}") from exc
        if exc.status_code == 503:
            raise SamModelUnreachable(f"box-prompt: {exc.body!r}") from exc
        raise SamModelFailed(f"box-prompt: {exc.body!r}") from exc
