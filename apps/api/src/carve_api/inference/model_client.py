"""Synchronous HTTP client for the model service.

We use sync httpx (not async) because FastAPI route handlers run in a thread
pool when the function is plain ``def``, and our service calls are short
enough that a sync round-trip per call is fine. This keeps the wiring simple
and tests trivial via ``httpx.MockTransport``.
"""

from contextlib import contextmanager
from typing import Any, Iterator

import httpx

from carve_api.config import get_settings


class ModelServiceError(Exception):
    """Raised when the model service returns a non-2xx status.

    A ``status_code`` of ``503`` with body ``{"error":
    "model_service_unreachable", ...}`` is reserved for the case where the
    model service hostname doesn't resolve / connection refuses / read times
    out — i.e. the model service itself is down. The carve api translates
    that into a 503 so users see "the model service is offline" rather than
    a generic 500.
    """

    def __init__(self, status_code: int, body: Any) -> None:
        self.status_code = status_code
        self.body = body
        super().__init__(f"model service returned {status_code}: {body!r}")


# httpx exceptions that mean "we never got a real HTTP response from the
# model service" — DNS failure, connection refused, connect/read timeout.
# Treat these as a 503 (Service Unavailable) signalling that the model
# service is offline rather than a 5xx from inside the model service.
_UNREACHABLE_EXCEPTIONS: tuple[type[Exception], ...] = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadTimeout,
)


@contextmanager
def _wrap_unreachable(label: str) -> Iterator[None]:
    """Translate connection-level failures into a 503 ModelServiceError.

    The model service is opt-in via the ``inference`` docker-compose profile.
    When it's not running, the api previously raised raw ``httpx.ConnectError``
    which FastAPI converted to a 500 — masking the real cause from operators
    and confusing the SAM tool's UI. We now re-raise as a structured 503 so
    callers (sam.py / sam_track.py / autoannotate.py adapters) can map it to
    a clear ``model_service_unreachable`` user-facing error.
    """
    try:
        yield
    except _UNREACHABLE_EXCEPTIONS as exc:
        raise ModelServiceError(
            503,
            {
                "error": "model_service_unreachable",
                "detail": f"{label}: {exc.__class__.__name__}: {exc}",
            },
        ) from exc


def _build_client() -> httpx.Client:
    s = get_settings()
    return httpx.Client(
        base_url=s.model_base_url,
        timeout=s.model_timeout_seconds,
    )


# Hook for tests to swap the transport without monkeypatching base_url
_TEST_TRANSPORT: httpx.BaseTransport | None = None


def set_test_transport(transport: httpx.BaseTransport | None) -> None:
    global _TEST_TRANSPORT
    _TEST_TRANSPORT = transport


def _client() -> httpx.Client:
    s = get_settings()
    if _TEST_TRANSPORT is not None:
        return httpx.Client(
            base_url=s.model_base_url,
            timeout=s.model_timeout_seconds,
            transport=_TEST_TRANSPORT,
        )
    return _build_client()


def yolo_load(weight_id: str, weights_url: str) -> dict:
    with _wrap_unreachable("yolo_load"), _client() as c:
        r = c.post("/yolo/load", json={"weight_id": weight_id, "weights_url": weights_url})
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def yolo_predict(weight_id: str, image_b64: str, *, conf: float = 0.25, iou: float = 0.7) -> dict:
    with _wrap_unreachable("yolo_predict"), _client() as c:
        r = c.post(
            "/yolo/predict",
            json={"weight_id": weight_id, "image_b64": image_b64, "conf": conf, "iou": iou},
        )
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def yolo_inspect(file_bytes: bytes, *, filename: str = "weight.pt") -> dict:
    """POST /yolo/inspect — returns ``{class_names: [...], task_kind: "..."}``.

    Used by ``WeightService.upload`` to populate ``Weight.class_names`` from
    the actual checkpoint instead of trusting the form-supplied ``[]``. The
    model service runs torch.load — keeping that off the api container is
    the entire point of delegating here.
    """
    with _wrap_unreachable("yolo_inspect"), _client() as c:
        r = c.post(
            "/yolo/inspect",
            files={"file": (filename, file_bytes, "application/octet-stream")},
        )
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def sam_encode(image_b64: str) -> dict:
    """POST /sam/encode — returns {image_hash, shape}."""
    with _wrap_unreachable("sam_encode"), _client() as c:
        r = c.post("/sam/encode", json={"image_b64": image_b64})
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def sam_decode(image_hash: str, points: list[list[int]], labels: list[int]) -> dict:
    """POST /sam/decode — returns {counts, size, score}."""
    with _wrap_unreachable("sam_decode"), _client() as c:
        r = c.post(
            "/sam/decode",
            json={"image_hash": image_hash, "points": points, "labels": labels},
        )
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def sam_track_start(
    video_url: str,
    frame_idx: int,
    points: list[list[int]],
    labels: list[int],
    text: str | None = None,
) -> dict:
    """POST /sam-track/start — returns {session_id, mask_at_start}.

    Multi-object workflow: ``points`` and ``labels`` may be empty (objects are
    added afterward via :func:`sam_track_add_object`). ``text`` is forwarded
    for SAM 3 text-prompt callers.
    """
    payload: dict = {
        "video_url": video_url,
        "frame_idx": frame_idx,
        "points": points,
        "labels": labels,
    }
    if text is not None:
        payload["text"] = text
    with _wrap_unreachable("sam_track_start"), _client() as c:
        r = c.post("/sam-track/start", json=payload)
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def sam_track_add_object(
    session_id: str,
    frame_idx: int,
    obj_id: int,
    points: list[list[int]],
    labels: list[int],
    boxes: list[list[float]],
) -> dict:
    """POST /sam-track/{session_id}/objects — returns {obj_id, frame_idx}."""
    with _wrap_unreachable("sam_track_add_object"), _client() as c:
        r = c.post(
            f"/sam-track/{session_id}/objects",
            json={
                "frame_idx": frame_idx,
                "obj_id": obj_id,
                "points": points,
                "labels": labels,
                "boxes": boxes,
            },
        )
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def sam_track_step(session_id: str, frames: int) -> dict:
    """POST /sam-track/{session_id}/step?frames=N — returns {steps: [...]}"""
    with _wrap_unreachable("sam_track_step"), _client() as c:
        r = c.post(f"/sam-track/{session_id}/step", params={"frames": frames})
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def sam_track_release(session_id: str) -> None:
    """DELETE /sam-track/{session_id}."""
    with _wrap_unreachable("sam_track_release"), _client() as c:
        r = c.delete(f"/sam-track/{session_id}")
        if r.status_code not in (204, 404):
            raise ModelServiceError(r.status_code, _safe_json(r))


def _safe_json(r: httpx.Response) -> Any:
    try:
        return r.json()
    except ValueError:
        return r.text
