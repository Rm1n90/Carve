"""Integration test: text-prompt followed by point-click reuses the SAME
sam3.1 adapter instance — proving the OOM fix is structurally complete.

Headline assertion for the Phase 3 SAM Lifecycle Manager refactor: counts
calls to ``_build_sam3p1_adapter`` and asserts exactly ONE was made
across both the /sam/text-prompt path AND the /sam/encode + /sam/decode
path. If this test ever regresses, the double-load OOM bug is back —
today's pre-refactor production code builds two
``Sam3p1NativeImagePredictorAdapter`` instances (one for
``_SESSION.predictor``, one for ``_NATIVE_IMAGE_PREDICTOR``), which
exceeds the 12 GB RTX 4070 budget and triggers CUDA OOM.

The refactor's invariant: ONE adapter, shared by all four
``predict_*`` methods of ``Sam3p1Variant``.
"""
import base64
from io import BytesIO
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from carve_model.main import create_app
from carve_model.sam.lifecycle import manager


def _b64_image() -> str:
    pil = Image.fromarray(np.zeros((4, 4, 3), dtype=np.uint8))
    buf = BytesIO()
    pil.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


@pytest.fixture(autouse=True)
def reset_manager():
    """Fresh manager state per test — drops any active variant or test fake
    so the next test sees a pristine lifecycle."""
    yield
    manager._reset_for_tests()


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def test_text_then_point_no_second_adapter_build(client: TestClient) -> None:
    """Critical: predict_text and predict_point share the SAME adapter.

    The OOM bug today: when sam3.1 is active, predict_text builds a SEPARATE
    Sam3p1NativeImagePredictorAdapter via
    _get_or_build_native_image_predictor while _SESSION.predictor holds a
    different one. That's ~10 GB of weights on the 12 GB RTX 4070, hence
    the OOM.

    The fix verified here: ONE adapter, shared across both predict paths.
    Asserted by counting calls to _build_sam3p1_adapter — expected exactly 1.
    """
    fake_adapter = MagicMock()
    fake_adapter._device = "cuda"
    fake_adapter._state = None

    # set_image mutates _state on the adapter — mirroring the real
    # Sam3p1NativeImagePredictorAdapter contract.
    def fake_set_image(image):
        fake_adapter._state = {
            "original_height": int(image.shape[0]),
            "original_width": int(image.shape[1]),
        }
    fake_adapter.set_image.side_effect = fake_set_image

    # predict() returns a 3-tuple matching predict_point's contract
    # (masks: (K, H, W) bool, scores: (K,) float, logits: (K, h, w) float).
    fake_adapter.predict.return_value = (
        np.zeros((1, 4, 4), dtype=bool),            # masks
        np.array([0.9], dtype=np.float32),          # scores
        np.zeros((1, 256, 256), dtype=np.float32),  # logits
    )

    # set_text_prompt populates state with mock tensors so the
    # Sam3p1Variant.predict_text helpers can iterate over a non-None state.
    def fake_set_text(text, state):
        state["masks"] = MagicMock()
        state["masks_logits"] = MagicMock()
        state["boxes"] = MagicMock()
        state["scores"] = MagicMock()
    fake_adapter._processor.set_text_prompt.side_effect = fake_set_text
    fake_adapter._processor.confidence_threshold = 0.5

    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=fake_adapter,
    ) as build:
        # Eagerly load sam3.1 so the manager.lease_or_load() inside the
        # routers finds a ready variant and does NOT trigger a second build.
        manager.ensure_loaded("sam3.1")

        # 1. Text-prompt path — exercises predict_text → uses self._adapter.
        with patch(
            "carve_model.sam.lifecycle._extract_text_detections",
            return_value=[(np.zeros((4, 4), dtype=np.uint8), 0.7)],
        ), patch(
            "carve_model.sam.lifecycle.encode_mask_rle",
            return_value=("rle", [4, 4]),
        ), patch(
            "carve_model.sam.lifecycle.mask_to_polygon",
            return_value=[],
        ), patch(
            "carve_model.sam.lifecycle.to_numpy_safe",
            return_value=np.array([[0, 0, 1, 1]]),
        ):
            r = client.post(
                "/sam/text-prompt",
                json={"image_b64": _b64_image(), "text": "hat"},
            )
            assert r.status_code == 200, r.json()

        # 2. Point-prompt path (encode + decode) — exercises predict_point →
        #    uses self._adapter. Same instance as the text path above.
        r2 = client.post("/sam/encode", json={"image_b64": _b64_image()})
        assert r2.status_code == 200, r2.json()
        image_hash = r2.json()["image_hash"]

        r3 = client.post(
            "/sam/decode",
            json={
                "image_hash": image_hash,
                "points": [[2, 2]],
                "labels": [1],
            },
        )
        assert r3.status_code == 200, r3.json()

        # THE CRITICAL ASSERTION — the OOM-fix invariant.
        assert build.call_count == 1, (
            f"_build_sam3p1_adapter was called {build.call_count} times — "
            "the OOM bug is back. text-prompt and point-prompt must share "
            "ONE sam3.1 adapter instance."
        )
