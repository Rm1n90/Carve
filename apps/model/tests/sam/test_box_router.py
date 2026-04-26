"""Tests for /sam/box-prompt endpoint.

The endpoint is a thin shell over the SAM 3 box-prompt capability, mirroring
the existing /sam/text-prompt pattern. It gates on SAM_MODEL=sam3 (returns
409 ``sam3_box_prompt_requires_sam3`` otherwise), validates the request,
and delegates to the registered box predictor factory.

The actual SAM 3 model is not loaded here — these tests exercise the wiring
plus the input validation contract.
"""

import base64
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from carve_model.main import create_app
from carve_model.sam import predictor as p_mod


def _png_b64(w: int = 64, h: int = 48) -> str:
    img = Image.new("RGB", (w, h), color=(10, 20, 30))
    out = io.BytesIO()
    img.save(out, format="PNG")
    return base64.b64encode(out.getvalue()).decode("ascii")


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    monkeypatch.delenv("SAM_MODEL", raising=False)
    monkeypatch.delenv("SAM_VARIANT", raising=False)
    p_mod.reset_text_predictor()
    p_mod.reset_box_predictor()
    yield
    p_mod.reset_text_predictor()
    p_mod.reset_box_predictor()


def test_box_prompt_returns_409_when_sam_variant_is_sam2():
    r = TestClient(create_app()).post(
        "/sam/box-prompt",
        json={
            "image_b64": _png_b64(),
            "boxes": [[10, 10, 30, 30]],
            "box_labels": [1],
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "sam3_box_prompt_requires_sam3"


def test_box_prompt_returns_503_when_sam3_enabled_but_predictor_not_set(monkeypatch):
    monkeypatch.setenv("SAM_MODEL", "sam3")
    r = TestClient(create_app()).post(
        "/sam/box-prompt",
        json={
            "image_b64": _png_b64(),
            "boxes": [[10, 10, 30, 30]],
            "box_labels": [1],
        },
    )
    assert r.status_code == 503
    assert r.json()["detail"] == "sam3_box_predictor_not_loaded"


def test_box_prompt_calls_factory_when_sam3_enabled(monkeypatch):
    monkeypatch.setenv("SAM_MODEL", "sam3")
    captured: dict = {}

    def _fake(*, image_b64, boxes, box_labels, text=None):
        captured["called"] = True
        captured["boxes"] = boxes
        captured["labels"] = box_labels
        captured["text"] = text
        return [
            {"counts": "0,4", "size": [2, 2], "score": 0.9, "bbox": [10, 10, 30, 30]}
        ]

    p_mod.set_box_predictor(_fake)
    r = TestClient(create_app()).post(
        "/sam/box-prompt",
        json={
            "image_b64": _png_b64(),
            "boxes": [[10, 10, 30, 30], [50, 50, 60, 60]],
            "box_labels": [1, 0],
            "text": "handle",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body) == 1
    assert body[0]["score"] == 0.9
    assert captured["called"] is True
    assert captured["boxes"] == [[10, 10, 30, 30], [50, 50, 60, 60]]
    assert captured["labels"] == [1, 0]
    assert captured["text"] == "handle"


def test_box_prompt_works_without_text(monkeypatch):
    """Boxes-only call must succeed and pass text=None to the factory."""
    monkeypatch.setenv("SAM_MODEL", "sam3")
    captured: dict = {}

    def _fake(*, image_b64, boxes, box_labels, text=None):
        captured["text"] = text
        return [{"counts": "1,2", "size": [2, 2], "score": 0.5, "bbox": [0, 0, 4, 4]}]

    p_mod.set_box_predictor(_fake)
    r = TestClient(create_app()).post(
        "/sam/box-prompt",
        json={
            "image_b64": _png_b64(),
            "boxes": [[1, 1, 5, 5]],
            "box_labels": [1],
        },
    )
    assert r.status_code == 200, r.text
    assert captured["text"] is None


def test_box_prompt_validates_lengths_match(monkeypatch):
    monkeypatch.setenv("SAM_MODEL", "sam3")
    p_mod.set_box_predictor(lambda **kw: [])
    r = TestClient(create_app()).post(
        "/sam/box-prompt",
        json={
            "image_b64": _png_b64(),
            "boxes": [[10, 10, 30, 30], [40, 40, 50, 50]],
            "box_labels": [1],  # mismatch
        },
    )
    assert r.status_code == 422


def test_box_prompt_rejects_invalid_label(monkeypatch):
    monkeypatch.setenv("SAM_MODEL", "sam3")
    p_mod.set_box_predictor(lambda **kw: [])
    r = TestClient(create_app()).post(
        "/sam/box-prompt",
        json={
            "image_b64": _png_b64(),
            "boxes": [[10, 10, 30, 30]],
            "box_labels": [2],  # not 0 or 1
        },
    )
    assert r.status_code == 422


def test_box_prompt_validates_empty_boxes(monkeypatch):
    monkeypatch.setenv("SAM_MODEL", "sam3")
    p_mod.set_box_predictor(lambda **kw: [])
    r = TestClient(create_app()).post(
        "/sam/box-prompt",
        json={
            "image_b64": _png_b64(),
            "boxes": [],
            "box_labels": [],
        },
    )
    assert r.status_code == 422  # Pydantic min_length=1
