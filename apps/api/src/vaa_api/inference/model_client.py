"""Synchronous HTTP client for the model service.

We use sync httpx (not async) because FastAPI route handlers run in a thread
pool when the function is plain ``def``, and our service calls are short
enough that a sync round-trip per call is fine. This keeps the wiring simple
and tests trivial via ``httpx.MockTransport``.
"""

from typing import Any

import httpx

from vaa_api.config import get_settings


class ModelServiceError(Exception):
    """Raised when the model service returns a non-2xx status."""

    def __init__(self, status_code: int, body: Any) -> None:
        self.status_code = status_code
        self.body = body
        super().__init__(f"model service returned {status_code}: {body!r}")


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
    with _client() as c:
        r = c.post("/yolo/load", json={"weight_id": weight_id, "weights_url": weights_url})
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def yolo_predict(weight_id: str, image_b64: str, *, conf: float = 0.25, iou: float = 0.7) -> dict:
    with _client() as c:
        r = c.post(
            "/yolo/predict",
            json={"weight_id": weight_id, "image_b64": image_b64, "conf": conf, "iou": iou},
        )
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def _safe_json(r: httpx.Response) -> Any:
    try:
        return r.json()
    except ValueError:
        return r.text
