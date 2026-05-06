"""VLM-FO1 precision filter — HTTP client for the sidecar service.

Pipeline shape (image-only path; video out per spec):

  1. SAM 3 ``Sam3Model.post_process_instance_segmentation`` returns N
     candidate (mask, box, score) proposals for a text concept.
  2. The caller drops the lowest-confidence boxes by ``score`` and
     hands the survivors to this filter as ``(image, text, boxes)``.
  3. We base64-encode the PIL image and POST it with the text + boxes
     to the ``model-vlm-fo1`` sidecar's ``/filter`` endpoint.
  4. The sidecar runs FO1 (Qwen2.5-VL-3B + Hybrid Region Encoder) on
     its own ``transformers==4.50.1`` install and returns the matched
     box indexes.
  5. We pass those indexes back; the caller subsets masks/boxes/scores
     accordingly.

The sidecar split exists because upstream FO1 was authored against
``transformers==4.50.1`` and accumulating runtime shims to bridge it
onto our SAM-3 service's ``transformers==5.0.0`` proved too brittle —
each transformers internal API change (cache_utils, rope_utils, config
nesting, …) forced another patch. Splitting into separate processes
isolates the version pin without affecting SAM 3.
"""

from __future__ import annotations

import base64
import logging
import os
from io import BytesIO
from typing import Any, Protocol, runtime_checkable

logger = logging.getLogger(__name__)


# --- public surface ---------------------------------------------------------


DEFAULT_MODEL_PATH = "omlab/VLM-FO1_Qwen2.5-VL-3B-v01"
"""Hugging Face repo for the FO1 Qwen2.5-VL-3B checkpoint.

Kept here for backwards compatibility with code that still imports
this constant (e.g. ``carve_model.main:_maybe_register_vlm_fo1``).
The sidecar resolves its own model path from ``VLM_FO1_MODEL_PATH``;
the value sent on each ``/filter`` request is informational only.
"""

DEFAULT_MAX_BOXES = 64
"""Cap on box count sent to FO1 per call.

Higher values increase recall but also context length and inference
time. The FO1 reference (``inference_with_sam3.py``) uses 100; 64 is a
conservative default that keeps P95 latency reasonable on 24 GB GPUs.
"""

DEFAULT_SIDECAR_URL = "http://model-vlm-fo1:8101"
"""Sidecar service URL inside the docker-compose network.

Override via ``VLM_FO1_SIDECAR_URL`` for local dev (e.g. running the
sidecar on the host on a non-standard port).
"""

DEFAULT_FILTER_TIMEOUT = 600.0
"""HTTP timeout (seconds) for ``/filter`` calls.

Generous — first call lazy-loads ~9 GB of weights from HF and a single
inference takes 1–5 s on a 24 GB GPU. Subsequent calls usually return
in <2 s but we keep the same ceiling so a cold-start retry doesn't
prematurely 504.
"""


@runtime_checkable
class VlmFo1Filter(Protocol):
    """Callable contract for the VLM-FO1 precision filter."""

    def __call__(
        self,
        *,
        image: Any,
        text: str,
        boxes: list[list[float]],
    ) -> list[int]: ...


# --- helpers ----------------------------------------------------------------


def _resolve_sidecar_url() -> str:
    return (os.environ.get("VLM_FO1_SIDECAR_URL") or DEFAULT_SIDECAR_URL).rstrip("/")


def unload_sidecar(*, timeout: float = 5.0) -> bool:
    """POST ``/unload`` to the FO1 sidecar — best-effort.

    Returns True when the sidecar reports it actually evicted weights,
    False when nothing was loaded or the call failed. Never raises;
    HTTP / connection errors are swallowed because the sidecar's own
    idle sweeper is the safety net.

    Called from the API worker at the end of a batch auto-annotate
    that opted into FO1 so the 6 GB of GPU weights don't sit pinned
    until the idle timeout fires.
    """
    import httpx

    base = _resolve_sidecar_url()
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(f"{base}/unload")
            resp.raise_for_status()
            body = resp.json()
            return bool(body.get("evicted"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("vlm_fo1 sidecar /unload failed: %s", exc)
        return False


def _encode_image_to_b64(image: Any) -> str:
    """Encode a PIL ``Image`` (or already-encoded bytes) to base64 PNG.

    Accepting bytes directly is a small concession to the test surface:
    callers that don't want to import PIL can pass a PNG/JPEG byte
    blob and skip the round-trip.
    """
    if isinstance(image, (bytes, bytearray)):
        return base64.b64encode(bytes(image)).decode("ascii")

    buf = BytesIO()
    # PNG keeps the image lossless. The few-MB overhead vs. JPEG is
    # well worth not having FO1 see compression artifacts on small
    # objects, which the SAM 3 proposals can be.
    image.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


# --- filter factory ---------------------------------------------------------


def make_vlm_fo1_filter(
    *,
    model_path: str = DEFAULT_MODEL_PATH,
    quant: str | None = None,  # noqa: ARG001 — accepted for API compat
    max_boxes: int = DEFAULT_MAX_BOXES,
    max_new_tokens: int = 4096,
    sidecar_url: str | None = None,
    timeout: float = DEFAULT_FILTER_TIMEOUT,
) -> VlmFo1Filter:
    """Return a VLM-FO1 filter that posts to the sidecar.

    The closure caches an ``httpx.Client`` so repeated calls reuse the
    same connection. ``model_path`` and ``quant`` are kept in the
    signature for backwards compatibility but ignored — the sidecar
    chooses both from its own environment (``VLM_FO1_MODEL_PATH``,
    ``VLM_FO1_QUANT``).

    Failure handling — preserved from the in-process implementation:
      - ``boxes == []``         → return ``[]`` immediately, no HTTP.
      - blank ``text``          → degrade to passthrough (return
        ``list(range(len(boxes)))``) — SAM 3 already produced the
        proposals, dropping them all on missing query is worse UX.
      - sidecar 5xx / timeout / connect error → degrade to passthrough,
        log once. The caller still gets SAM 3 raw output.
      - sidecar returns 0 indexes → return ``[]`` (legitimate "no match").
    """
    import httpx

    base = (sidecar_url or _resolve_sidecar_url()).rstrip("/")
    client = httpx.Client(base_url=base, timeout=timeout)

    def _filter(
        *,
        image: Any,
        text: str,
        boxes: list[list[float]],
    ) -> list[int]:
        n = len(boxes)
        if n == 0:
            return []
        if not text or not text.strip():
            return list(range(n))

        try:
            image_b64 = _encode_image_to_b64(image)
            payload = {
                "image_b64": image_b64,
                "text": text,
                "boxes": [list(b) for b in boxes],
                "max_boxes": max_boxes,
                "max_new_tokens": max_new_tokens,
            }
            resp = client.post("/filter", json=payload)
            resp.raise_for_status()
            body = resp.json()
        except Exception as exc:  # noqa: BLE001 -- graceful degradation
            logger.warning(
                "vlm_fo1 sidecar filter failed (%s); degrading to passthrough",
                exc,
            )
            return list(range(n))

        indexes = body.get("indexes") or []
        # Defensive — sidecar already validates ranges, but make the
        # contract robust against future schema drift.
        return [i for i in indexes if isinstance(i, int) and 0 <= i < n]

    return _filter
