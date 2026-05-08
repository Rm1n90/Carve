import numpy as np
import pytest

from carve_model.sam.visual_prompt_preprocess import (
    expand_region_with_padding,
    rasterise_polygon,
    square_pad_replicate,
    min_size_guard,
)


def test_expand_region_with_padding_15pct() -> None:
    region = {"kind": "bbox", "xyxy": [40.0, 40.0, 60.0, 60.0]}
    out = expand_region_with_padding(region, image_h=100, image_w=100, pad_ratio=0.15)
    assert out["kind"] == "bbox"
    assert out["xyxy"] == [37.0, 37.0, 63.0, 63.0]


def test_expand_region_with_padding_clips_to_image() -> None:
    region = {"kind": "bbox", "xyxy": [0.0, 0.0, 20.0, 20.0]}
    out = expand_region_with_padding(region, image_h=100, image_w=100, pad_ratio=0.5)
    assert out["xyxy"][0] == 0.0
    assert out["xyxy"][1] == 0.0
    assert out["xyxy"][2] == 30.0
    assert out["xyxy"][3] == 30.0


def test_expand_region_polygon_carries_crop_xyxy() -> None:
    region = {"kind": "polygon", "points": [[40.0, 40.0], [60.0, 40.0], [60.0, 60.0], [40.0, 60.0]]}
    out = expand_region_with_padding(region, image_h=100, image_w=100, pad_ratio=0.15)
    assert out["kind"] == "polygon"
    assert "crop_xyxy" in out
    assert out["crop_xyxy"] == [37.0, 37.0, 63.0, 63.0]


def test_rasterise_polygon_square() -> None:
    pts = [[10.0, 10.0], [20.0, 10.0], [20.0, 20.0], [10.0, 20.0]]
    mask = rasterise_polygon(pts, h=30, w=30)
    assert mask.dtype == bool
    assert bool(mask[15, 15]) is True
    assert bool(mask[5, 5]) is False


def test_rasterise_polygon_too_few_points_returns_zero_mask() -> None:
    mask = rasterise_polygon([[0.0, 0.0], [1.0, 1.0]], h=10, w=10)
    assert mask.sum() == 0


def test_square_pad_replicate_pads_with_edge_pixels() -> None:
    crop = np.zeros((10, 20, 3), dtype=np.uint8)
    crop[:, 0, :] = 99
    crop[:, -1, :] = 11
    out = square_pad_replicate(crop)
    assert out.shape == (20, 20, 3)
    assert (out[0, :, :] == out[5, :, :]).all()


def test_square_pad_replicate_returns_same_array_when_already_square() -> None:
    crop = np.zeros((15, 15, 3), dtype=np.uint8)
    out = square_pad_replicate(crop)
    assert out.shape == (15, 15, 3)


def test_min_size_guard_expands_tiny_region() -> None:
    out = min_size_guard([40.0, 40.0, 56.0, 56.0], min_side=64)
    assert out == [16.0, 16.0, 80.0, 80.0]


def test_min_size_guard_no_op_when_already_large() -> None:
    out = min_size_guard([10.0, 10.0, 80.0, 80.0], min_side=64)
    assert out == [10.0, 10.0, 80.0, 80.0]
