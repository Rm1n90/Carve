"""HTTP boundary tests for the VLM-FO1 integration on /sam/text-prompt
and /sam/status.

These cover the Phase 3 wiring:

  - ``TextPromptIn`` accepts an optional ``use_vlm_fo1`` flag (default
    False) and the router forwards it to the registered text predictor
    factory only when the flag is True. Existing factories that don't
    know the kwarg keep working.
  - ``/sam/status`` reports ``vlm_fo1_available`` so the editor UI can
    hide the toggle when the server has no filter wired.
"""

from __future__ import annotations

import base64
import io
from typing import Any

from fastapi.testclient import TestClient
from PIL import Image

from carve_model.main import create_app
from carve_model.sam import predictor as predictor_mod


def _png_b64(w: int = 16, h: int = 16) -> str:
    img = Image.new("RGB", (w, h), color=(8, 8, 8))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def teardown_function(_):
    predictor_mod.reset_text_predictor()
    predictor_mod.reset_vlm_fo1_filter()


# --- TextPromptIn ----------------------------------------------------------


def test_text_prompt_default_use_vlm_fo1_is_false_and_kwarg_not_forwarded(monkeypatch):
    """When the client doesn't send ``use_vlm_fo1``, the route must NOT
    pass that kwarg to the factory — preserves backward compat with any
    factory whose signature pre-dates this work."""
    monkeypatch.setenv("SAM_VARIANT", "sam3")

    received: dict[str, Any] = {}

    def fake_factory(*, image_b64: str, text: str) -> list[dict]:
        received["image_b64"] = image_b64
        received["text"] = text
        return []

    predictor_mod.set_text_predictor(fake_factory)
    client = TestClient(create_app())

    r = client.post(
        "/sam/text-prompt", json={"image_b64": _png_b64(), "text": "lion"},
    )

    assert r.status_code == 200
    assert received["text"] == "lion"


def test_text_prompt_forwards_use_vlm_fo1_when_true(monkeypatch):
    monkeypatch.setenv("SAM_VARIANT", "sam3")

    received: dict[str, Any] = {}

    def fake_factory(
        *, image_b64: str, text: str, use_vlm_fo1: bool = False,
    ) -> list[dict]:
        received["use_vlm_fo1"] = use_vlm_fo1
        return []

    predictor_mod.set_text_predictor(fake_factory)
    client = TestClient(create_app())

    r = client.post(
        "/sam/text-prompt",
        json={"image_b64": _png_b64(), "text": "lion", "use_vlm_fo1": True},
    )

    assert r.status_code == 200
    assert received["use_vlm_fo1"] is True


def test_text_prompt_does_not_forward_use_vlm_fo1_when_false(monkeypatch):
    """Explicit false from the client is equivalent to omitted."""
    monkeypatch.setenv("SAM_VARIANT", "sam3")

    forwarded: list[bool] = []

    def fake_factory(*, image_b64: str, text: str, **kwargs) -> list[dict]:
        forwarded.append("use_vlm_fo1" in kwargs)
        return []

    predictor_mod.set_text_predictor(fake_factory)
    client = TestClient(create_app())

    r = client.post(
        "/sam/text-prompt",
        json={"image_b64": _png_b64(), "text": "lion", "use_vlm_fo1": False},
    )

    assert r.status_code == 200
    assert forwarded == [False]


# --- /sam/status -----------------------------------------------------------


def test_status_reports_vlm_fo1_available_false_when_no_filter():
    predictor_mod.reset_vlm_fo1_filter()
    client = TestClient(create_app())

    r = client.get("/sam/status")

    assert r.status_code == 200
    body = r.json()
    assert body["vlm_fo1_available"] is False


def test_status_reports_vlm_fo1_available_true_when_filter_registered():
    predictor_mod.set_vlm_fo1_filter(lambda **kw: [])
    try:
        client = TestClient(create_app())
        r = client.get("/sam/status")

        assert r.status_code == 200
        body = r.json()
        assert body["vlm_fo1_available"] is True
    finally:
        predictor_mod.reset_vlm_fo1_filter()
