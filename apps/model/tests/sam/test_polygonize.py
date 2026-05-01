"""Tests for mask -> polygon conversion."""

from __future__ import annotations

import numpy as np
import pytest

from carve_model.sam.polygonize import (
    DEFAULT_EPSILON_FACTOR,
    mask_to_polygon,
)


def _square_mask(side: int, x: int = 0, y: int = 0, canvas: int | None = None) -> np.ndarray:
    """Build a binary mask with a filled axis-aligned square."""
    canvas = canvas if canvas is not None else side + max(x, y) + 4
    m = np.zeros((canvas, canvas), dtype=np.uint8)
    m[y : y + side, x : x + side] = 1
    return m


def test_empty_mask_returns_empty() -> None:
    assert mask_to_polygon(np.zeros((10, 10), dtype=np.uint8)) == []


def test_rejects_non_2d() -> None:
    with pytest.raises(ValueError):
        mask_to_polygon(np.zeros((1, 2, 3), dtype=np.uint8))


def test_single_blob_returns_quad() -> None:
    """A 50x50 axis-aligned square should simplify to 4 vertices."""
    mask = _square_mask(side=50, x=10, y=10, canvas=80)
    poly = mask_to_polygon(mask)
    assert len(poly) == 4
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    # Bounding box of the returned polygon should match the input square
    # (within 1px slack for cv2's contour edge sampling).
    assert min(xs) <= 11 and max(xs) >= 58
    assert min(ys) <= 11 and max(ys) >= 58


def test_largest_blob_wins() -> None:
    """When two blobs are present, only the larger one is kept."""
    mask = np.zeros((100, 100), dtype=np.uint8)
    mask[2:7, 2:7] = 1
    mask[40:80, 40:80] = 1
    poly = mask_to_polygon(mask)
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    assert min(xs) >= 38 and max(xs) >= 78
    assert min(ys) >= 38 and max(ys) >= 78


def test_degenerate_pixel_returns_empty() -> None:
    """A single foreground pixel cannot become a usable >=3 vertex polygon."""
    mask = np.zeros((10, 10), dtype=np.uint8)
    mask[5, 5] = 1
    assert mask_to_polygon(mask) == []


def test_treats_nonzero_as_one() -> None:
    """Non-binary masks (e.g. float scores) must still produce a polygon."""
    mask = (_square_mask(side=20, x=5, y=5, canvas=40) * 0.7).astype(np.float32)
    poly = mask_to_polygon(mask)
    assert len(poly) >= 3


def test_epsilon_scales_with_size() -> None:
    """A small square and a large square should both simplify to 4 vertices.

    With a fixed-pixel epsilon, the small square would lose vertices and
    the large one would keep noise. The arc-length-relative epsilon used
    by mask_to_polygon should produce 4 for both.
    """
    small = _square_mask(side=10, x=2, y=2, canvas=20)
    large = _square_mask(side=400, x=10, y=10, canvas=440)
    assert len(mask_to_polygon(small)) == 4
    assert len(mask_to_polygon(large)) == 4


def test_higher_epsilon_factor_simplifies_more() -> None:
    """A circle approximated with a tighter epsilon yields more vertices."""
    mask = np.zeros((200, 200), dtype=np.uint8)
    yy, xx = np.ogrid[:200, :200]
    mask[(xx - 100) ** 2 + (yy - 100) ** 2 <= 60 * 60] = 1
    tight = mask_to_polygon(mask, epsilon_factor=0.0005)
    loose = mask_to_polygon(mask, epsilon_factor=0.01)
    assert len(tight) > len(loose) >= 3


def test_default_epsilon_constant_exposed() -> None:
    """Other modules import the constant; guard against accidental rename."""
    assert DEFAULT_EPSILON_FACTOR == 0.0015
