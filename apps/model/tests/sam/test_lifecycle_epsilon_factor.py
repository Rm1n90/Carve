"""Auto-annotate paths must forward ``epsilon_factor`` to mask_to_polygon.

Pre-fix, ``Sam3p1Variant.predict_text``, ``predict_box`` and
``_run_visual_inference`` all called ``mask_to_polygon(mask)`` without
the user's ``epsilon_factor``, so the editor's "Polygon approximation
points" slider had no effect on auto-annotated polygons regardless of
position (25, 75, …). These tests pin the fix end-to-end at the
lifecycle layer and prove the kwarg is plumbed all the way through.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from carve_model.sam.lifecycle import (
    Sam3p1Variant,
    mask_to_polygon,
)


def test_module_mask_to_polygon_forwards_epsilon_factor() -> None:
    """The module-level wrapper used by the auto-annotate paths must
    forward ``epsilon_factor`` to the polygonize implementation."""
    seen: dict[str, object] = {}

    def fake_impl(mask, *, epsilon_factor=None):  # type: ignore[no-redef]
        seen["mask_shape"] = mask.shape
        seen["epsilon_factor"] = epsilon_factor
        return [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]]

    with patch(
        "carve_model.sam.polygonize.mask_to_polygon",
        side_effect=fake_impl,
    ):
        mask_to_polygon(np.zeros((5, 5), dtype=np.uint8))
        # No kwarg → polygonize default (the impl receives epsilon_factor
        # as its own default value, which is the polygonize module's
        # DEFAULT_EPSILON_FACTOR sentinel — but our fake captures the
        # raw kwarg passed by our wrapper, which is None.
        assert seen["epsilon_factor"] is None
        mask_to_polygon(
            np.zeros((5, 5), dtype=np.uint8), epsilon_factor=0.003,
        )
        assert seen["epsilon_factor"] == 0.003


@pytest.fixture
def sam3p1_variant_with_state():
    """Builds a Sam3p1Variant pre-wired with a stubbed adapter whose
    state dict has the masks/boxes shapes ``_extract_text_detections``
    expects. Returns (variant, adapter) so individual tests can patch
    the small bits they care about (predict_text path)."""
    adapter = MagicMock()
    adapter._device = "cpu"
    state = {
        "masks": MagicMock(),
        "scores": MagicMock(),
        "boxes": MagicMock(),
    }
    adapter._state = state
    adapter._processor = MagicMock()
    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=adapter,
    ):
        v = Sam3p1Variant()
        v.load(device="cpu")
    return v, adapter


def test_predict_text_forwards_epsilon_to_polygonizer(
    sam3p1_variant_with_state,
) -> None:
    """The text auto-annotate path is the most user-visible: a SAM 3
    multi-class run that ignored ``epsilon_factor`` produced polygons
    with the default vertex density regardless of the editor slider."""
    v, _ = sam3p1_variant_with_state

    fake_mask = np.zeros((20, 20), dtype=np.uint8)
    fake_mask[5:15, 5:15] = 1

    seen_epsilons: list[float | None] = []

    def fake_polygon(mask, *, epsilon_factor=None):  # type: ignore[no-redef]
        seen_epsilons.append(epsilon_factor)
        return [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]]

    with patch(
        "carve_model.sam.lifecycle._extract_text_detections",
        return_value=[(fake_mask, 0.9)],
    ), patch(
        "carve_model.sam.lifecycle._decode_image_b64_to_numpy",
        return_value=np.zeros((50, 50, 3), dtype=np.uint8),
    ), patch(
        "carve_model.sam.lifecycle.to_numpy_safe",
        return_value=np.array([[0.0, 0.0, 10.0, 10.0]]),
    ), patch(
        "carve_model.sam.lifecycle.encode_mask_rle",
        return_value=("0,5,5,5,...", [20, 20]),
    ), patch(
        "carve_model.sam.polygonize.mask_to_polygon",
        side_effect=fake_polygon,
    ):
        v.predict_text(
            image_b64="dGVzdA==",
            text="bus",
            epsilon_factor=0.0042,
        )
    assert seen_epsilons == [0.0042], (
        "predict_text must forward epsilon_factor to mask_to_polygon"
    )


def test_predict_text_default_epsilon_is_none(sam3p1_variant_with_state) -> None:
    """When the caller omits ``epsilon_factor`` (legacy callers), the
    wrapper still calls mask_to_polygon and gets the polygonize default
    — preserves behaviour for older deployments / tests."""
    v, _ = sam3p1_variant_with_state
    fake_mask = np.zeros((20, 20), dtype=np.uint8)
    fake_mask[5:15, 5:15] = 1
    seen: list[float | None] = []

    def fake_polygon(mask, *, epsilon_factor=None):  # type: ignore[no-redef]
        seen.append(epsilon_factor)
        return [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]]

    with patch(
        "carve_model.sam.lifecycle._extract_text_detections",
        return_value=[(fake_mask, 0.5)],
    ), patch(
        "carve_model.sam.lifecycle._decode_image_b64_to_numpy",
        return_value=np.zeros((50, 50, 3), dtype=np.uint8),
    ), patch(
        "carve_model.sam.lifecycle.to_numpy_safe",
        return_value=np.array([[0.0, 0.0, 10.0, 10.0]]),
    ), patch(
        "carve_model.sam.lifecycle.encode_mask_rle",
        return_value=("0,5,5,5,...", [20, 20]),
    ), patch(
        "carve_model.sam.polygonize.mask_to_polygon",
        side_effect=fake_polygon,
    ):
        v.predict_text(image_b64="dGVzdA==", text="bus")
    # No epsilon_factor in kwargs → wrapper passes None → polygonize default.
    assert seen == [None]


def test_run_visual_inference_forwards_epsilon(
    sam3p1_variant_with_state,
) -> None:
    """The visual-prompt batch path must also forward the slider —
    auto-visual is the second user-facing surface that was ignoring it."""
    v, adapter = sam3p1_variant_with_state

    fake_mask = np.zeros((20, 20), dtype=np.uint8)
    fake_mask[6:14, 6:14] = 1
    state_dict = {
        "masks": np.zeros((1, 20, 20), dtype=np.uint8),
        "boxes": np.array([[6, 6, 14, 14]], dtype=np.float32),
    }
    state_dict["masks"][0] = fake_mask
    adapter._state = state_dict

    seen: list[float | None] = []

    def fake_polygon(mask, *, epsilon_factor=None):  # type: ignore[no-redef]
        seen.append(epsilon_factor)
        return [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]]

    with patch(
        "carve_model.sam.lifecycle.to_numpy_safe",
        side_effect=lambda x: np.asarray(x),
    ), patch(
        "carve_model.sam.lifecycle.embed_image_batch",
        return_value=np.array([[1.0, 0.0]], dtype=np.float32),
    ), patch(
        "carve_model.sam.lifecycle._greedy_nms_indices",
        return_value=np.asarray([0], dtype=np.int64),
    ), patch(
        "carve_model.sam.lifecycle.encode_mask_rle",
        return_value=("rle", [20, 20]),
    ), patch(
        "carve_model.sam.polygonize.mask_to_polygon",
        side_effect=fake_polygon,
    ):
        v._run_visual_inference(
            target=np.zeros((20, 20, 3), dtype=np.uint8),
            ref_stack=np.array([[1.0, 0.0]], dtype=np.float32),
            threshold=0.0,
            epsilon_factor=0.0066,
        )
    assert seen == [0.0066], (
        "_run_visual_inference must forward epsilon_factor to mask_to_polygon"
    )
