"""Tests for the SAM 3 text-prompt endpoint shell.

The actual SAM 3 model is gated on Hugging Face and is not loaded at test
time. These tests cover the capability gate and the factory injection
point — when the active variant does not advertise ``supports_text`` the
endpoint must 409 with a capability-based detail, and when a text
predictor is registered it must delegate to that factory via the
manager's lease.

Task 3.4 replaced the old variant-name 409 gate (``sam3_not_enabled``)
with a capability flag check on the leased variant. Tests now install a
point-impl on the ``_LegacyTestVariant`` so the manager's lease yields
that variant (without a text impl) instead of trying to load the real
SAM model at test time, then assert on the new
``text_prompt_not_supported_for_variant`` detail.
"""

import base64
import io

from fastapi.testclient import TestClient
from PIL import Image

from carve_model.main import create_app
from carve_model.sam import predictor as predictor_mod


def _png_b64(w: int = 16, h: int = 16) -> str:
    img = Image.new("RGB", (w, h), color=(8, 8, 8))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _install_point_stub() -> None:
    """Install a no-op point predictor so the manager's lease yields the
    LegacyTestVariant (without a text/box/visual impl) instead of trying
    to load the real SAM model at test time."""
    predictor_mod.set_test_predictor(lambda **_: ([], [], None))


def teardown_function(_):
    # Always reset the text-predictor factory + point stub to avoid leaking
    # between tests.
    predictor_mod.reset_text_predictor()
    predictor_mod.set_test_predictor(None)


def test_text_prompt_returns_409_when_variant_lacks_text_capability(monkeypatch) -> None:
    monkeypatch.delenv("SAM_VARIANT", raising=False)  # default is sam2
    _install_point_stub()
    client = TestClient(create_app())
    r = client.post(
        "/sam/text-prompt",
        json={"image_b64": _png_b64(), "text": "person"},
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "text_prompt_not_supported_for_variant"


def test_text_prompt_returns_409_when_variant_is_anything_else(monkeypatch) -> None:
    monkeypatch.setenv("SAM_VARIANT", "foo")
    _install_point_stub()
    client = TestClient(create_app())
    r = client.post(
        "/sam/text-prompt",
        json={"image_b64": _png_b64(), "text": "person"},
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "text_prompt_not_supported_for_variant"


def test_text_prompt_returns_409_when_text_predictor_not_registered(monkeypatch) -> None:
    """With no text impl on the leased variant, capability is False → 409.

    Pre-Task-3.4 this returned 503 ``sam3_predictor_not_loaded``; the new
    contract treats absent capability as 409 because the manager already
    knows what each variant supports."""
    monkeypatch.setenv("SAM_VARIANT", "sam3")
    predictor_mod.reset_text_predictor()
    _install_point_stub()  # keep the real loader out of the test path
    client = TestClient(create_app())
    r = client.post(
        "/sam/text-prompt",
        json={"image_b64": _png_b64(), "text": "person"},
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "text_prompt_not_supported_for_variant"


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
    # v3.8 Phase 1 -- TextPromptOut now declares an optional ``polygon``
    # field with default []. Pydantic serializes it on the response
    # even when the factory's payload omits it. Assert each field
    # individually so legacy factory payloads keep passing.
    assert len(body) == 1
    assert body[0]["counts"] == canned[0]["counts"]
    assert body[0]["size"] == canned[0]["size"]
    assert body[0]["score"] == canned[0]["score"]
    assert body[0]["bbox"] == canned[0]["bbox"]
    assert body[0]["polygon"] == []
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
