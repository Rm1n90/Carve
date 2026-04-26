"""Tests for the SAM 3 text-prompt endpoint shell.

The actual SAM 3 model is gated on Hugging Face and is not loaded at test
time. These tests cover the env-driven toggle and the factory injection
point — when ``SAM_VARIANT != "sam3"`` the endpoint must short-circuit
with 409, and when SAM 3 is enabled it must delegate to a registered
predictor factory.
"""

import base64
import io

from fastapi.testclient import TestClient
from PIL import Image

from vaa_model.main import create_app
from vaa_model.sam import predictor as predictor_mod


def _png_b64(w: int = 16, h: int = 16) -> str:
    img = Image.new("RGB", (w, h), color=(8, 8, 8))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def teardown_function(_):
    # Always reset the text-predictor factory to avoid leaking between tests
    predictor_mod.reset_text_predictor()


def test_text_prompt_returns_409_when_sam_variant_is_sam2(monkeypatch) -> None:
    monkeypatch.delenv("SAM_VARIANT", raising=False)  # default is sam2
    client = TestClient(create_app())
    r = client.post(
        "/sam/text-prompt",
        json={"image_b64": _png_b64(), "text": "person"},
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "sam3_not_enabled"


def test_text_prompt_returns_409_when_sam_variant_is_anything_else(monkeypatch) -> None:
    monkeypatch.setenv("SAM_VARIANT", "foo")
    client = TestClient(create_app())
    r = client.post(
        "/sam/text-prompt",
        json={"image_b64": _png_b64(), "text": "person"},
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "sam3_not_enabled"


def test_text_prompt_returns_503_when_sam3_enabled_but_predictor_not_set(monkeypatch) -> None:
    monkeypatch.setenv("SAM_VARIANT", "sam3")
    predictor_mod.reset_text_predictor()
    client = TestClient(create_app())
    r = client.post(
        "/sam/text-prompt",
        json={"image_b64": _png_b64(), "text": "person"},
    )
    assert r.status_code == 503
    assert r.json()["detail"] == "sam3_predictor_not_loaded"


def test_text_prompt_calls_factory_when_sam3_enabled_and_factory_set(monkeypatch) -> None:
    monkeypatch.setenv("SAM_VARIANT", "sam3")

    canned = [
        {
            "counts": "abc",
            "size": [16, 16],
            "score": 0.92,
            "bbox": [0.0, 0.0, 10.0, 10.0],
        }
    ]
    received: dict = {}

    def fake_factory(*, image_b64: str, text: str) -> list[dict]:
        received["image_b64"] = image_b64
        received["text"] = text
        return canned

    predictor_mod.set_text_predictor(fake_factory)
    client = TestClient(create_app())
    r = client.post(
        "/sam/text-prompt",
        json={"image_b64": _png_b64(), "text": "a person"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body == canned
    assert received["text"] == "a person"
    assert received["image_b64"]  # non-empty


def test_text_prompt_validates_text_min_length(monkeypatch) -> None:
    monkeypatch.setenv("SAM_VARIANT", "sam3")
    predictor_mod.set_text_predictor(lambda image_b64, text: [])
    client = TestClient(create_app())
    r = client.post(
        "/sam/text-prompt",
        json={"image_b64": _png_b64(), "text": ""},
    )
    assert r.status_code == 422


def test_text_prompt_rejects_long_text(monkeypatch) -> None:
    monkeypatch.setenv("SAM_VARIANT", "sam3")
    predictor_mod.set_text_predictor(lambda image_b64, text: [])
    client = TestClient(create_app())
    r = client.post(
        "/sam/text-prompt",
        json={"image_b64": _png_b64(), "text": "x" * 201},
    )
    assert r.status_code == 422
