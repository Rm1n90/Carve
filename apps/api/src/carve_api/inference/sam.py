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
    sam_visual_prompt,
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


def _admission_payload(body) -> dict | None:
    """Mirror of ``inference/yoloe._admission_payload`` for SAM. Returns
    the structured GPU-admission body when the model service's 503 came
    from the admission gate; otherwise None."""
    if not isinstance(body, dict):
        return None
    inner = body.get("detail") if isinstance(body.get("detail"), dict) else body
    if not isinstance(inner, dict):
        return None
    code = inner.get("code") or inner.get("error")
    if code in ("gpu_oom_risk", "gpu_busy"):
        return inner
    return None


def _translate_model_error(exc: ModelServiceError, *, label: str) -> AppError:
    """Map a ``ModelServiceError`` from a SAM call onto the right AppError.

    Also raises ``GpuAdmissionError`` when the model service refused
    the call for GPU-capacity reasons (gpu_oom_risk / gpu_busy) so the
    frontend can surface a precise toast instead of a generic 503.
    Callers that need site-specific 409 handling (e.g. decode's
    ``embedding_not_loaded``) should branch on ``exc.status_code``
    BEFORE calling this helper.
    """
    admission = _admission_payload(exc.body)
    if admission is not None:
        from carve_api.errors import GpuAdmissionError

        return GpuAdmissionError(admission)
    if exc.status_code == 409:
        return Sam3NotEnabled(f"{label}: {exc.body!r}")
    if exc.status_code == 503:
        return SamModelUnreachable(f"{label}: {exc.body!r}")
    return SamModelFailed(f"{label}: {exc.body!r}")


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
        raise _translate_model_error(exc, label="encode") from exc


def sam_decode_with_hash(
    image_hash: str,
    points: list[list[int]],
    labels: list[int],
    box: list[float] | None = None,
    *,
    epsilon_factor: float | None = None,
) -> dict:
    if len(points) != len(labels):
        raise SamModelFailed("points and labels must have equal length")
    if not points and box is None:
        raise SamModelFailed("at least one of points or box must be provided")
    try:
        return sam_decode(
            image_hash, points, labels, box=box, epsilon_factor=epsilon_factor,
        )
    except ModelServiceError as exc:
        if exc.status_code == 409 and _admission_payload(exc.body) is None:
            raise SamEmbeddingMissing(
                "embedding not loaded; call /sam/encode first"
            ) from exc
        raise _translate_model_error(exc, label="decode") from exc


def sam_text_prompt_for_asset(
    asset: Asset,
    text: str,
    frame_id: uuid.UUID | None = None,
    *,
    use_vlm_fo1: bool = False,
    threshold: float | None = None,
) -> list[dict]:
    """SAM 3 text-prompt entry point.

    Encodes the asset's bytes once and forwards them to the model
    service alongside the supplied text concept. Maps the model
    service's 409 (sam3_not_enabled) and 503 (unreachable / predictor
    not loaded) onto AppErrors so the router/web layer can render a
    consistent error envelope.

    v3.8 Phase 4-video step F4 — ``frame_id`` selects a per-frame JPEG
    for video assets.

    v3.21+ — ``use_vlm_fo1`` opts into the VLM-FO1 precision filter
    on the model service side. Default False preserves byte-for-byte
    behavior for existing callers.
    """
    body = fetch_asset_bytes(asset, frame_id=frame_id)
    b64 = base64.b64encode(body).decode("ascii")
    try:
        return sam_text_prompt(
            b64, text, use_vlm_fo1=use_vlm_fo1, threshold=threshold,
        )
    except ModelServiceError as exc:
        raise _translate_model_error(exc, label="text-prompt") from exc


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
        raise _translate_model_error(exc, label="box-prompt") from exc


def sam_visual_prompt_for_asset(
    *,
    target_asset: Asset,
    refer_asset: Asset,
    regions: list[dict],
    threshold: float | None = None,
    text_hint: str | None = None,
    target_frame_id: uuid.UUID | None = None,
    refer_frame_id: uuid.UUID | None = None,
) -> list[dict]:
    """SAM 3.1 visual-prompt entry point.

    Fetches both the target and reference asset bytes once and forwards
    them to the model service's /sam/visual-prompt endpoint with the
    supplied region list (bbox or polygon, but not mixed). v3.28 — the
    ``threshold`` is now the cosine-similarity floor that the model
    applies before returning candidates.

    Maps the model service's error codes to the same SAM AppErrors used
    by the text-prompt path:
      - 409 sam3p1_not_enabled       → Sam3NotEnabled
      - 503 sam_visual_predictor_not_loaded / unreachable → SamModelUnreachable
      - other 4xx/5xx                → SamModelFailed
    """
    target_bytes = fetch_asset_bytes(target_asset, frame_id=target_frame_id)
    refer_bytes = fetch_asset_bytes(refer_asset, frame_id=refer_frame_id)
    target_b64 = base64.b64encode(target_bytes).decode("ascii")
    refer_b64 = base64.b64encode(refer_bytes).decode("ascii")
    try:
        return sam_visual_prompt(
            refer_b64=refer_b64,
            regions=regions,
            target_b64=target_b64,
            threshold=threshold,
            text_hint=text_hint,
        )
    except ModelServiceError as exc:
        raise _translate_model_error(exc, label="visual-prompt") from exc
