# SAM Visual Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Visual Prompt mode to Auto-Annotate that uses native SAM 3.1 Promptable Concept Segmentation to find objects similar to user-picked bbox/polygon references across the current asset or every asset in the task.

**Architecture:** New tab in `AutoAnnotateDialog`, shared `VisualReferencePicker` component extracted from `YoloeDialog`, new `/sam/visual-prompt` model endpoint backed by a new `set_visual_prompt` method on `Sam3p1NativeImagePredictorAdapter` that pools dense + global features, new `/sam/auto-visual{,-batch}` API endpoints reusing the auto-text RQ batch shape.

**Tech Stack:** TypeScript/React (web), FastAPI/Python (api + model), SAM 3.1 native (`sam3` package), PyTorch, RQ, Redis, MinIO, Pydantic, Vitest, pytest, Playwright.

**Source spec:** [`docs/superpowers/specs/2026-05-08-sam-visual-prompt-design.md`](../specs/2026-05-08-sam-visual-prompt-design.md)

---

## Phase A — Model service: visual prompt encoder + endpoint

Phase outcome: `POST /model/sam/visual-prompt` returns mask candidates given `(refer_b64, region, target_b64)`. All on-by-default accuracy levers active. Ships behind the existing SAM 3.1 variant gate.

### Task A1: Preprocessing helpers (crop padding, polygon raster, square pad)

**Files:**
- Create: `apps/model/src/carve_model/sam/visual_prompt_preprocess.py`
- Test: `apps/model/tests/sam/test_visual_prompt_preprocess.py`

- [ ] **Step 1: Write failing test for `expand_region_with_padding`**

```python
# apps/model/tests/sam/test_visual_prompt_preprocess.py
import numpy as np
import pytest

from carve_model.sam.visual_prompt_preprocess import (
    expand_region_with_padding,
    rasterise_polygon,
    square_pad_replicate,
    min_size_guard,
)


def test_expand_region_with_padding_15pct():
    region = {"kind": "bbox", "xyxy": [40.0, 40.0, 60.0, 60.0]}
    out = expand_region_with_padding(region, image_h=100, image_w=100, pad_ratio=0.15)
    assert out["kind"] == "bbox"
    assert out["xyxy"] == [37.0, 37.0, 63.0, 63.0]


def test_expand_region_with_padding_clips_to_image():
    region = {"kind": "bbox", "xyxy": [0.0, 0.0, 20.0, 20.0]}
    out = expand_region_with_padding(region, image_h=100, image_w=100, pad_ratio=0.5)
    assert out["xyxy"][0] == 0.0
    assert out["xyxy"][1] == 0.0
    assert out["xyxy"][2] == 30.0
    assert out["xyxy"][3] == 30.0


def test_expand_region_polygon_carries_crop_xyxy():
    region = {"kind": "polygon", "points": [[40.0, 40.0], [60.0, 40.0], [60.0, 60.0], [40.0, 60.0]]}
    out = expand_region_with_padding(region, image_h=100, image_w=100, pad_ratio=0.15)
    assert out["kind"] == "polygon"
    assert "crop_xyxy" in out
    assert out["crop_xyxy"] == [37.0, 37.0, 63.0, 63.0]
```

Run: `pytest apps/model/tests/sam/test_visual_prompt_preprocess.py::test_expand_region_with_padding_15pct -v`
Expected: FAIL — `ModuleNotFoundError: carve_model.sam.visual_prompt_preprocess`.

- [ ] **Step 2: Implement preprocessing module**

```python
# apps/model/src/carve_model/sam/visual_prompt_preprocess.py
"""Preprocessing helpers for SAM visual prompt encoding.

See docs/superpowers/specs/2026-05-08-sam-visual-prompt-design.md §5.6.
"""
from __future__ import annotations

import numpy as np


def expand_region_with_padding(region, *, image_h, image_w, pad_ratio=0.15):
    if region["kind"] == "bbox":
        x1, y1, x2, y2 = (float(v) for v in region["xyxy"])
        w = x2 - x1
        h = y2 - y1
    elif region["kind"] == "polygon":
        pts = np.asarray(region["points"], dtype=float)
        x1, y1 = pts[:, 0].min(), pts[:, 1].min()
        x2, y2 = pts[:, 0].max(), pts[:, 1].max()
        w = x2 - x1
        h = y2 - y1
    else:
        raise ValueError(f"unknown region kind: {region['kind']!r}")

    pad_x = w * pad_ratio
    pad_y = h * pad_ratio
    nx1 = max(0.0, x1 - pad_x)
    ny1 = max(0.0, y1 - pad_y)
    nx2 = min(float(image_w), x2 + pad_x)
    ny2 = min(float(image_h), y2 + pad_y)

    if region["kind"] == "bbox":
        return {"kind": "bbox", "xyxy": [nx1, ny1, nx2, ny2]}
    return {
        "kind": "polygon",
        "points": [list(p) for p in region["points"]],
        "crop_xyxy": [nx1, ny1, nx2, ny2],
    }


def min_size_guard(crop_xyxy, min_side=64):
    x1, y1, x2, y2 = (float(v) for v in crop_xyxy)
    w = x2 - x1
    h = y2 - y1
    cx = (x1 + x2) / 2
    cy = (y1 + y2) / 2
    nw = max(w, float(min_side))
    nh = max(h, float(min_side))
    return [cx - nw / 2, cy - nh / 2, cx + nw / 2, cy + nh / 2]


def rasterise_polygon(points, h, w):
    try:
        import cv2  # type: ignore[import-not-found]
        mask = np.zeros((h, w), dtype=np.uint8)
        pts = np.asarray(points, dtype=np.int32).reshape(-1, 1, 2)
        cv2.fillPoly(mask, [pts], color=1)
        return mask.astype(bool)
    except ImportError:
        return _numpy_polygon_raster(points, h, w)


def _numpy_polygon_raster(points, h, w):
    pts = np.asarray(points, dtype=float)
    n = len(pts)
    mask = np.zeros((h, w), dtype=bool)
    if n < 3:
        return mask
    ys = np.arange(h)[:, None]
    xs = np.arange(w)[None, :]
    inside = np.zeros((h, w), dtype=bool)
    j = n - 1
    for i in range(n):
        yi, xi = pts[i, 1], pts[i, 0]
        yj, xj = pts[j, 1], pts[j, 0]
        cond = ((yi > ys) != (yj > ys)) & (
            xs < (xj - xi) * (ys - yi) / (yj - yi + 1e-12) + xi
        )
        inside ^= cond
        j = i
    return inside


def square_pad_replicate(crop):
    h, w = crop.shape[:2]
    if h == w:
        return crop
    side = max(h, w)
    pad_top = (side - h) // 2
    pad_bot = side - h - pad_top
    pad_left = (side - w) // 2
    pad_right = side - w - pad_left
    return np.pad(
        crop,
        ((pad_top, pad_bot), (pad_left, pad_right), (0, 0)),
        mode="edge",
    )
```

- [ ] **Step 3: Add tests for `rasterise_polygon`, `square_pad_replicate`, `min_size_guard`**

```python
def test_rasterise_polygon_square():
    pts = [[10.0, 10.0], [20.0, 10.0], [20.0, 20.0], [10.0, 20.0]]
    mask = rasterise_polygon(pts, h=30, w=30)
    assert mask.dtype == bool
    assert bool(mask[15, 15]) is True
    assert bool(mask[5, 5]) is False


def test_rasterise_polygon_too_few_points_returns_zero_mask():
    mask = rasterise_polygon([[0.0, 0.0], [1.0, 1.0]], h=10, w=10)
    assert mask.sum() == 0


def test_square_pad_replicate_pads_with_edge_pixels():
    crop = np.zeros((10, 20, 3), dtype=np.uint8)
    crop[:, 0, :] = 99
    crop[:, -1, :] = 11
    out = square_pad_replicate(crop)
    assert out.shape == (20, 20, 3)
    assert (out[0, :, :] == out[5, :, :]).all()


def test_square_pad_replicate_returns_same_array_when_already_square():
    crop = np.zeros((15, 15, 3), dtype=np.uint8)
    out = square_pad_replicate(crop)
    assert out.shape == (15, 15, 3)


def test_min_size_guard_expands_tiny_region():
    out = min_size_guard([40.0, 40.0, 56.0, 56.0], min_side=64)
    assert out == [16.0, 16.0, 80.0, 80.0]


def test_min_size_guard_no_op_when_already_large():
    out = min_size_guard([10.0, 10.0, 80.0, 80.0], min_side=64)
    assert out == [10.0, 10.0, 80.0, 80.0]
```

Run: `pytest apps/model/tests/sam/test_visual_prompt_preprocess.py -v`
Expected: PASS (all 9).

- [ ] **Step 4: Commit**

```bash
git add apps/model/src/carve_model/sam/visual_prompt_preprocess.py apps/model/tests/sam/test_visual_prompt_preprocess.py
git commit -m "feat(sam): visual prompt preprocessing helpers"
```

### Task A2: Feature pooling helpers (dense, global, masked-mean, L2-norm)

**Files:**
- Create: `apps/model/src/carve_model/sam/visual_prompt_pool.py`
- Test: `apps/model/tests/sam/test_visual_prompt_pool.py`

- [ ] **Step 1: Failing tests**

```python
# apps/model/tests/sam/test_visual_prompt_pool.py
import numpy as np

from carve_model.sam.visual_prompt_pool import (
    masked_mean, l2norm, fuse_dense_global, self_attn_pool, cross_image_refine,
)


def test_masked_mean_returns_only_masked_cells():
    feats = np.zeros((4, 4, 3), dtype=np.float32)
    feats[0, 0] = [1.0, 2.0, 3.0]
    feats[3, 3] = [4.0, 5.0, 6.0]
    mask = np.zeros((4, 4), dtype=bool)
    mask[0, 0] = True
    mask[3, 3] = True
    np.testing.assert_allclose(masked_mean(feats, mask), [2.5, 3.5, 4.5])


def test_masked_mean_empty_mask_returns_global_mean():
    feats = np.ones((2, 2, 3), dtype=np.float32) * 5.0
    np.testing.assert_allclose(masked_mean(feats, np.zeros((2, 2), dtype=bool)), [5.0, 5.0, 5.0])


def test_l2norm_unit_norm():
    np.testing.assert_allclose(np.linalg.norm(l2norm(np.array([3.0, 0.0, 4.0]))), 1.0, atol=1e-6)


def test_l2norm_zero_vector_safe():
    out = l2norm(np.zeros(5))
    assert np.all(np.isfinite(out))
    assert np.linalg.norm(out) == 0.0


def test_fuse_dense_global_default_alpha_0_7():
    dense = l2norm(np.array([1.0, 0.0, 0.0]))
    glob = l2norm(np.array([0.0, 1.0, 0.0]))
    np.testing.assert_allclose(
        fuse_dense_global(dense, glob),
        l2norm(0.7 * dense + 0.3 * glob),
    )


def test_fuse_dense_global_alpha_override():
    dense = l2norm(np.array([1.0, 0.0]))
    glob = l2norm(np.array([0.0, 1.0]))
    np.testing.assert_allclose(
        fuse_dense_global(dense, glob, alpha=0.5),
        l2norm(0.5 * dense + 0.5 * glob),
    )


def test_self_attn_pool_emphasises_high_sim_cells():
    feats = np.zeros((1, 3, 4), dtype=np.float32)
    feats[0, 0] = [1.0, 0.0, 0.0, 0.0]
    feats[0, 1] = [0.0, 1.0, 0.0, 0.0]
    feats[0, 2] = [0.0, 0.0, 1.0, 0.0]
    mask = np.ones((1, 3), dtype=bool)
    global_vec = l2norm(np.array([0.0, 1.0, 0.0, 0.0]))
    out = self_attn_pool(feats, mask, global_vec, tau=0.01)
    np.testing.assert_allclose(out, l2norm(feats[0, 1]), atol=1e-3)


def test_cross_image_refine_blends_top_k():
    exemplar = l2norm(np.array([1.0, 0.0]))
    target_feats = np.zeros((2, 2, 2), dtype=np.float32)
    target_feats[0, 0] = [1.0, 0.0]
    target_feats[0, 1] = [0.9, 0.1]
    target_feats[1, 0] = [-1.0, 0.0]
    target_feats[1, 1] = [0.0, 1.0]
    out = cross_image_refine(exemplar, target_feats, k=2, beta=0.5)
    top_mean = l2norm(np.array([0.95, 0.05]))
    expected = l2norm(0.5 * exemplar + 0.5 * top_mean)
    np.testing.assert_allclose(out, expected, atol=1e-5)
```

Run: `pytest apps/model/tests/sam/test_visual_prompt_pool.py -v` → FAIL.

- [ ] **Step 2: Implement pooling**

```python
# apps/model/src/carve_model/sam/visual_prompt_pool.py
"""Feature pooling primitives for SAM visual prompt encoding.

See docs/superpowers/specs/2026-05-08-sam-visual-prompt-design.md §5.5–§5.6.
"""
from __future__ import annotations

import numpy as np


def masked_mean(feats, mask):
    if mask.sum() == 0:
        return feats.reshape(-1, feats.shape[-1]).mean(axis=0)
    return feats[mask].mean(axis=0)


def l2norm(v, eps=1e-12):
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, eps) if (n > 0).any() else v


def fuse_dense_global(dense, glob, *, alpha=0.7):
    return l2norm(alpha * dense + (1.0 - alpha) * glob)


def self_attn_pool(feats, mask, global_vec, *, tau=0.07):
    H, W, D = feats.shape
    flat = feats.reshape(-1, D)
    mflat = mask.reshape(-1)
    if mflat.sum() == 0:
        mflat = np.ones_like(mflat)
    cells = flat[mflat]
    cells_n = cells / np.maximum(np.linalg.norm(cells, axis=-1, keepdims=True), 1e-12)
    sims = cells_n @ global_vec
    sims = sims / max(tau, 1e-6)
    sims = sims - sims.max()
    w = np.exp(sims)
    w = w / w.sum()
    pooled = (w[:, None] * cells).sum(axis=0)
    return l2norm(pooled)


def cross_image_refine(exemplar, target_feats, *, k=10, beta=0.2):
    H, W, D = target_feats.shape
    flat = target_feats.reshape(-1, D)
    flat_n = flat / np.maximum(np.linalg.norm(flat, axis=-1, keepdims=True), 1e-12)
    sims = flat_n @ exemplar
    k = min(k, sims.shape[0])
    top_idx = np.argpartition(-sims, k - 1)[:k]
    top_mean = l2norm(flat[top_idx].mean(axis=0))
    return l2norm((1.0 - beta) * exemplar + beta * top_mean)
```

Run: `pytest apps/model/tests/sam/test_visual_prompt_pool.py -v` → PASS (8).

- [ ] **Step 3: Commit**

```bash
git add apps/model/src/carve_model/sam/visual_prompt_pool.py apps/model/tests/sam/test_visual_prompt_pool.py
git commit -m "feat(sam): visual prompt feature pooling helpers"
```

### Task A3: `set_visual_prompt` on SAM 3.1 native adapter (defaults only)

**Files:**
- Modify: `apps/model/src/carve_model/sam/sam3p1_adapter.py`
- Test: `apps/model/tests/sam/test_sam3p1_visual_prompt.py` (new)

- [ ] **Step 1: Failing tests using a stub native model**

```python
# apps/model/tests/sam/test_sam3p1_visual_prompt.py
from unittest.mock import MagicMock
import numpy as np
import pytest

from carve_model.sam.sam3p1_adapter import Sam3p1NativeImagePredictorAdapter


def _stub_features(h, w, d=8, seed=0):
    rng = np.random.default_rng(seed)
    return rng.standard_normal((h, w, d), dtype=np.float32)


def _build_adapter(fixed_state=None):
    model = MagicMock(name="Sam3Model")
    processor = MagicMock(name="Sam3Processor")
    def _set_image_stub(pil):
        if fixed_state is not None:
            return {**fixed_state, "original_height": pil.size[1], "original_width": pil.size[0]}
        return {
            "original_height": pil.size[1],
            "original_width": pil.size[0],
            "_stub_dense_hi": _stub_features(14, 14, 8, seed=1),
            "_stub_dense_lo": _stub_features(7, 7, 8, seed=2),
            "_stub_global": _stub_features(1, 1, 8, seed=3).reshape(8),
        }
    processor.set_image.side_effect = _set_image_stub
    return Sam3p1NativeImagePredictorAdapter(model=model, processor=processor, device="cpu")


def test_set_visual_prompt_bbox_returns_unit_norm_d_vector():
    adapter = _build_adapter()
    refer = np.random.default_rng(0).integers(0, 255, (100, 100, 3)).astype(np.uint8)
    out = adapter.set_visual_prompt(refer, {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]})
    assert out.shape == (8,)
    np.testing.assert_allclose(np.linalg.norm(out), 1.0, atol=1e-5)


def test_set_visual_prompt_polygon_differs_from_bbox_on_same_shape():
    adapter = _build_adapter()
    refer = np.random.default_rng(1).integers(0, 255, (100, 100, 3)).astype(np.uint8)
    bbox_out = adapter.set_visual_prompt(refer, {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]})
    poly_out = adapter.set_visual_prompt(
        refer, {"kind": "polygon", "points": [[10.0, 10.0], [30.0, 10.0], [20.0, 30.0]]}
    )
    assert not np.allclose(bbox_out, poly_out)


def test_dense_plus_global_default_is_alpha_0_7():
    fixed = {
        "_stub_dense_hi": np.tile(np.array([1, 0, 0, 0, 0, 0, 0, 0], dtype=np.float32), (4, 4, 1)),
        "_stub_dense_lo": np.tile(np.array([1, 0, 0, 0, 0, 0, 0, 0], dtype=np.float32), (2, 2, 1)),
        "_stub_global": np.array([0, 1, 0, 0, 0, 0, 0, 0], dtype=np.float32),
    }
    adapter = _build_adapter(fixed_state=fixed)
    out = adapter.set_visual_prompt(
        np.zeros((100, 100, 3), dtype=np.uint8),
        {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]},
    )
    expected_dense = np.array([1, 0, 0, 0, 0, 0, 0, 0], dtype=np.float32)
    expected_global = np.array([0, 1, 0, 0, 0, 0, 0, 0], dtype=np.float32)
    expected = 0.7 * expected_dense + 0.3 * expected_global
    expected = expected / np.linalg.norm(expected)
    np.testing.assert_allclose(out, expected, atol=1e-5)


def test_alpha_env_override(monkeypatch):
    monkeypatch.setenv("SAM_VISUAL_PROMPT_ALPHA", "0.5")
    adapter = _build_adapter()
    out = adapter.set_visual_prompt(
        np.zeros((100, 100, 3), dtype=np.uint8),
        {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]},
    )
    assert out.shape == (8,)
    np.testing.assert_allclose(np.linalg.norm(out), 1.0, atol=1e-5)


def test_min_size_guard_expands_tiny_region():
    adapter = _build_adapter()
    out = adapter.set_visual_prompt(
        np.zeros((200, 200, 3), dtype=np.uint8),
        {"kind": "bbox", "xyxy": [95.0, 95.0, 105.0, 105.0]},
    )
    assert out.shape == (8,)
```

Run: `pytest apps/model/tests/sam/test_sam3p1_visual_prompt.py -v` → FAIL (`AttributeError`).

- [ ] **Step 2: Implement `set_visual_prompt` (defaults-only path)**

Add to `Sam3p1NativeImagePredictorAdapter` between `predict` and `extract_embedding`:

```python
def set_visual_prompt(
    self,
    refer_image,
    region,
    *,
    fusion_mode="dense_plus_global",
    pad_ratio=0.15,
    multi_scale=True,
):
    """Compute a pooled visual_prompt_embed for one (refer_image, region) pair.

    Defaults-only path. Optional levers (TTA / color aug / self-attn / x-img)
    land in Task A4. See spec §5.5 + §5.6.
    """
    import numpy as np
    from PIL import Image
    from carve_model.sam.visual_prompt_preprocess import (
        expand_region_with_padding, min_size_guard,
        rasterise_polygon, square_pad_replicate,
    )
    from carve_model.sam.visual_prompt_pool import (
        masked_mean, l2norm, fuse_dense_global,
    )

    H, W = refer_image.shape[:2]
    expanded = expand_region_with_padding(region, image_h=H, image_w=W, pad_ratio=pad_ratio)
    crop_xyxy = expanded["xyxy"] if expanded["kind"] == "bbox" else expanded["crop_xyxy"]
    crop_xyxy = min_size_guard(crop_xyxy, min_side=64)
    cx1 = max(0, int(crop_xyxy[0])); cy1 = max(0, int(crop_xyxy[1]))
    cx2 = min(W, int(crop_xyxy[2])); cy2 = min(H, int(crop_xyxy[3]))
    crop = refer_image[cy1:cy2, cx1:cx2]
    crop = square_pad_replicate(crop)
    crop_h, crop_w = crop.shape[:2]

    state = self._processor.set_image(Image.fromarray(crop))
    dense_hi = self._extract_dense(state, scale="hi")
    dense_lo = self._extract_dense(state, scale="lo") if multi_scale else None
    global_vec = self._extract_global(state)

    pad_top = (crop_h - (cy2 - cy1)) // 2
    pad_left = (crop_w - (cx2 - cx1)) // 2
    if region["kind"] == "bbox":
        rx1, ry1, rx2, ry2 = (float(v) for v in region["xyxy"])
        rx1 = pad_left + (rx1 - cx1); rx2 = pad_left + (rx2 - cx1)
        ry1 = pad_top + (ry1 - cy1);  ry2 = pad_top + (ry2 - cy1)
        mask_hi = self._bbox_mask((rx1, ry1, rx2, ry2), crop_h, crop_w, dense_hi.shape[:2])
        mask_lo = (
            self._bbox_mask((rx1, ry1, rx2, ry2), crop_h, crop_w, dense_lo.shape[:2])
            if dense_lo is not None else None
        )
    else:
        pts = [[pad_left + (p[0] - cx1), pad_top + (p[1] - cy1)] for p in region["points"]]
        full_mask = rasterise_polygon(pts, crop_h, crop_w)
        mask_hi = self._downsample_bool(full_mask, dense_hi.shape[:2])
        mask_lo = self._downsample_bool(full_mask, dense_lo.shape[:2]) if dense_lo is not None else None

    dense_vec_hi = l2norm(masked_mean(dense_hi, mask_hi))
    if dense_lo is not None and mask_lo is not None:
        dense_vec_lo = l2norm(masked_mean(dense_lo, mask_lo))
        dense_vec = l2norm(0.5 * (dense_vec_hi + dense_vec_lo))
    else:
        dense_vec = dense_vec_hi
    global_vec = l2norm(global_vec)
    return fuse_dense_global(dense_vec, global_vec, alpha=self._alpha())

@staticmethod
def _bbox_mask(xyxy, crop_h, crop_w, feat_hw):
    import numpy as np
    H_f, W_f = feat_hw
    x1, y1, x2, y2 = xyxy
    fx1 = max(0, int(x1 / crop_w * W_f))
    fx2 = min(W_f, int(np.ceil(x2 / crop_w * W_f)))
    fy1 = max(0, int(y1 / crop_h * H_f))
    fy2 = min(H_f, int(np.ceil(y2 / crop_h * H_f)))
    m = np.zeros((H_f, W_f), dtype=bool)
    m[fy1:fy2, fx1:fx2] = True
    return m

@staticmethod
def _downsample_bool(mask, out_hw):
    import numpy as np
    H_out, W_out = out_hw
    H_in, W_in = mask.shape
    ys = (np.arange(H_out) * (H_in / H_out)).astype(int)
    xs = (np.arange(W_out) * (W_in / W_out)).astype(int)
    return mask[np.ix_(ys, xs)]

def _extract_dense(self, state, *, scale):
    if f"_stub_dense_{scale}" in state:
        return state[f"_stub_dense_{scale}"]
    return self._extract_dense_from_native(state, scale=scale)

def _extract_global(self, state):
    if "_stub_global" in state:
        return state["_stub_global"]
    return self._extract_global_from_native(state)

def _alpha(self):
    import os
    try:
        return float(os.environ.get("SAM_VISUAL_PROMPT_ALPHA", "0.7"))
    except ValueError:
        return 0.7

def _extract_dense_from_native(self, state, *, scale):
    raise NotImplementedError("filled in Task A6")

def _extract_global_from_native(self, state):
    raise NotImplementedError("filled in Task A6")
```

Run: `pytest apps/model/tests/sam/test_sam3p1_visual_prompt.py -v` → PASS (5).

- [ ] **Step 3: Commit**

```bash
git add apps/model/src/carve_model/sam/sam3p1_adapter.py apps/model/tests/sam/test_sam3p1_visual_prompt.py
git commit -m "feat(sam): set_visual_prompt with dense+global+multiscale defaults"
```

### Task A4: Optional accuracy levers (TTA, color aug, self-attn, x-img)

**Files:**
- Modify: `apps/model/src/carve_model/sam/sam3p1_adapter.py`
- Test: `apps/model/tests/sam/test_sam3p1_visual_prompt.py`

- [ ] **Step 1: Failing tests for each lever**

```python
def test_all_optional_levers_off_by_default(monkeypatch):
    for k in (
        "SAM_VISUAL_PROMPT_TTA_HFLIP", "SAM_VISUAL_PROMPT_TTA_VFLIP",
        "SAM_VISUAL_PROMPT_TTA_ROT90", "SAM_VISUAL_PROMPT_COLOR_AUG",
        "SAM_VISUAL_PROMPT_SELF_ATTN", "SAM_VISUAL_PROMPT_XIMG_REFINE",
    ):
        monkeypatch.delenv(k, raising=False)
    adapter = _build_adapter()
    adapter.set_visual_prompt(np.zeros((100, 100, 3), dtype=np.uint8),
                              {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]})
    assert adapter._processor.set_image.call_count == 1


def test_tta_hflip_env_doubles_encode(monkeypatch):
    monkeypatch.setenv("SAM_VISUAL_PROMPT_TTA_HFLIP", "1")
    adapter = _build_adapter()
    adapter.set_visual_prompt(np.zeros((100, 100, 3), dtype=np.uint8),
                              {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]})
    assert adapter._processor.set_image.call_count == 2


def test_tta_vflip_env_doubles_encode(monkeypatch):
    monkeypatch.setenv("SAM_VISUAL_PROMPT_TTA_VFLIP", "1")
    adapter = _build_adapter()
    adapter.set_visual_prompt(np.zeros((100, 100, 3), dtype=np.uint8),
                              {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]})
    assert adapter._processor.set_image.call_count == 2


def test_tta_rot90_env_runs_four_encodes(monkeypatch):
    monkeypatch.setenv("SAM_VISUAL_PROMPT_TTA_ROT90", "1")
    adapter = _build_adapter()
    adapter.set_visual_prompt(np.zeros((100, 100, 3), dtype=np.uint8),
                              {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]})
    assert adapter._processor.set_image.call_count == 4


def test_tta_compose_hflip_and_vflip(monkeypatch):
    monkeypatch.setenv("SAM_VISUAL_PROMPT_TTA_HFLIP", "1")
    monkeypatch.setenv("SAM_VISUAL_PROMPT_TTA_VFLIP", "1")
    adapter = _build_adapter()
    adapter.set_visual_prompt(np.zeros((100, 100, 3), dtype=np.uint8),
                              {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]})
    assert adapter._processor.set_image.call_count == 4


def test_color_aug_env_runs_twice(monkeypatch):
    monkeypatch.setenv("SAM_VISUAL_PROMPT_COLOR_AUG", "1")
    adapter = _build_adapter()
    adapter.set_visual_prompt(np.zeros((100, 100, 3), dtype=np.uint8),
                              {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]})
    assert adapter._processor.set_image.call_count == 2


def test_self_attn_pool_env_changes_output(monkeypatch):
    refer = np.zeros((100, 100, 3), dtype=np.uint8)
    region = {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]}
    a1 = _build_adapter().set_visual_prompt(refer, region)
    monkeypatch.setenv("SAM_VISUAL_PROMPT_SELF_ATTN", "1")
    a2 = _build_adapter().set_visual_prompt(refer, region)
    assert not np.allclose(a1, a2, atol=1e-3)
```

Run → FAIL (levers not implemented).

- [ ] **Step 2: Refactor `set_visual_prompt` to support optional levers**

Factor the per-encode body of step A3 into `_encode_one(crop, region_in_crop, multi_scale, use_self_attn) -> np.ndarray` and replace `set_visual_prompt` with the orchestrator below. Add `_build_tta_crops`, `_color_jitter`.

```python
def set_visual_prompt(
    self, refer_image, region, *,
    fusion_mode="dense_plus_global", pad_ratio=0.15, multi_scale=True,
    tta_hflip=False, tta_vflip=False, tta_rot90=False,
    color_aug=False, self_attn_pool=False, ximg_refine=False,
    target_state=None,
):
    import os
    import numpy as np
    from carve_model.sam.visual_prompt_pool import l2norm, cross_image_refine
    flags = {
        "tta_hflip": tta_hflip or os.environ.get("SAM_VISUAL_PROMPT_TTA_HFLIP") == "1",
        "tta_vflip": tta_vflip or os.environ.get("SAM_VISUAL_PROMPT_TTA_VFLIP") == "1",
        "tta_rot90": tta_rot90 or os.environ.get("SAM_VISUAL_PROMPT_TTA_ROT90") == "1",
        "color_aug": color_aug or os.environ.get("SAM_VISUAL_PROMPT_COLOR_AUG") == "1",
        "self_attn": self_attn_pool or os.environ.get("SAM_VISUAL_PROMPT_SELF_ATTN") == "1",
        "ximg":      ximg_refine    or os.environ.get("SAM_VISUAL_PROMPT_XIMG_REFINE") == "1",
    }
    crops = self._build_tta_crops(refer_image, region, pad_ratio=pad_ratio, flags=flags)
    per_ref_vecs = [
        self._encode_one(crop, region_in_crop, multi_scale, flags["self_attn"])
        for crop, region_in_crop in crops
    ]
    pooled = l2norm(np.mean(per_ref_vecs, axis=0))
    if flags["ximg"] and target_state is not None:
        pooled = cross_image_refine(
            pooled,
            self._extract_dense(target_state, scale="hi"),
            k=int(os.environ.get("SAM_VISUAL_PROMPT_XIMG_K", "10")),
            beta=float(os.environ.get("SAM_VISUAL_PROMPT_XIMG_BETA", "0.2")),
        )
    return pooled
```

`_build_tta_crops` returns a list of `(crop_array, region_in_crop_dict)` tuples — one for the original encode + one per enabled augmentation, plus combinations:
- hflip: numpy `crop[:, ::-1]`, region x-coords mirrored.
- vflip: `crop[::-1, :]`, region y-coords mirrored.
- both: compose.
- rot90: `np.rot90(crop, k)` for k=1,2,3 plus the original — region coords rotated.
- color_aug: deterministic ±10 % brightness/contrast/saturation via `numpy.clip(crop * 1.1, 0, 255).astype(np.uint8)` for one pass; original geometry unchanged.

Compose order: original → hflip → vflip → hvflip → rot90×3 → color (so total counts match the spec table when subsets enable).

`_encode_one` re-runs the per-scale dense + global pool from A3, swapping `masked_mean(dense_hi, mask_hi)` for `self_attn_pool(dense_hi, mask_hi, l2norm(global_vec))` when `use_self_attn=True`.

Run: `pytest apps/model/tests/sam/test_sam3p1_visual_prompt.py -v` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/model/src/carve_model/sam/sam3p1_adapter.py apps/model/tests/sam/test_sam3p1_visual_prompt.py
git commit -m "feat(sam): visual prompt opt-in accuracy levers (TTA, color, self-attn, x-img)"
```

### Task A5: `predict_with_visual_prompt` — forward pass with pooled embed

**Files:**
- Modify: `apps/model/src/carve_model/sam/sam3p1_adapter.py`
- Test: `apps/model/tests/sam/test_sam3p1_visual_prompt.py`

- [ ] **Step 1: Failing test**

```python
def test_predict_with_visual_prompt_text_disabled():
    adapter = _build_adapter()
    target_state = {
        "original_height": 100, "original_width": 100,
        "_stub_dense_hi": _stub_features(14, 14, 8, seed=10),
        "_stub_dense_lo": _stub_features(7, 7, 8, seed=11),
        "_stub_global": _stub_features(1, 1, 8, seed=12).reshape(8),
    }
    adapter._state = target_state
    adapter._original_size = (100, 100)
    pooled = np.ones(8, dtype=np.float32) / np.sqrt(8)
    masks_returned = np.zeros((1, 100, 100), dtype=bool)
    masks_returned[0, 40:60, 40:60] = True
    adapter._model.predict_visual_prompt = MagicMock(
        return_value=(masks_returned, np.array([0.9]), np.array([[40.0, 40.0, 60.0, 60.0]]))
    )
    masks, scores, boxes = adapter.predict_with_visual_prompt(pooled)
    assert masks.shape == (1, 100, 100)
    assert scores[0] == pytest.approx(0.9)
    kwargs = adapter._model.predict_visual_prompt.call_args.kwargs
    assert kwargs.get("encode_text") is False
    assert kwargs.get("visual_prompt_embed").shape == (1, 1, 8)
```

→ FAIL.

- [ ] **Step 2: Implement**

```python
def predict_with_visual_prompt(self, pooled_embed):
    import numpy as np
    if self._state is None:
        raise RuntimeError("set_image must be called on the target before predict_with_visual_prompt")
    embed = pooled_embed.reshape(1, 1, -1)
    masks, scores, boxes = self._model.predict_visual_prompt(
        self._state, visual_prompt_embed=embed, encode_text=False,
    )
    return np.asarray(masks), np.asarray(scores), np.asarray(boxes)
```

Run → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/model/src/carve_model/sam/sam3p1_adapter.py apps/model/tests/sam/test_sam3p1_visual_prompt.py
git commit -m "feat(sam): predict_with_visual_prompt on Sam3p1 adapter"
```

### Task A6: Wire native sam3 dense + global feature extraction

**Files:**
- Modify: `apps/model/src/carve_model/sam/sam3p1_adapter.py` — fill `_extract_dense_from_native`, `_extract_global_from_native`, native `predict_visual_prompt`.

- [ ] **Step 1: Inspect native state shape**

Read `/home/media4us/Documents/Dev/sam3/sam3/model/sam3_image_processor.py:42-110` (`set_image`) and `sam3_image.py` `_get_img_feats` + `_encode_prompt` to confirm dense feat slot keys (`backbone_out["backbone_fpn"]`) and global slot. Document discovered keys inline as a comment at the top of `_extract_dense_from_native`.

- [ ] **Step 2: Implement native extractors**

```python
def _extract_dense_from_native(self, state, *, scale):
    """Read dense feature map from the native sam3 state.

    sam3.set_image stores backbone outputs under state["backbone_out"]
    with FPN levels in backbone_fpn (highest-res first per Hiera defaults).
    'hi' uses index 0; 'lo' uses index 1.
    """
    fpn = state["backbone_out"]["backbone_fpn"]
    idx = 0 if scale == "hi" else 1
    feats = fpn[idx]
    feats = feats[0] if feats.dim() == 4 else feats
    feats = feats.permute(1, 2, 0).contiguous()
    import torch
    return feats.detach().to("cpu", dtype=torch.float32).numpy()


def _extract_global_from_native(self, state):
    import numpy as np
    dense_hi = self._extract_dense_from_native(state, scale="hi")
    return dense_hi.reshape(-1, dense_hi.shape[-1]).mean(axis=0)
```

- [ ] **Step 3: Implement `predict_visual_prompt` on the wrapped native model**

The native sam3 image model does not expose `predict_visual_prompt` directly. Add a small `_native_visual_forward` helper inside the adapter that:
1. Ensures `state["backbone_out"]["language_features"]` carries the dummy "visual" text features (mirror `sam3_image_processor.set_text_prompt(["visual"])` at line 140).
2. Sets `state["geometric_prompt"] = self._model._get_dummy_prompt()` if absent.
3. Calls `self._model.forward_grounding(...)` with `visual_prompt_embed` and `visual_prompt_mask` populated and otherwise mirrors `_forward_grounding` in `sam3_image.py:183-222`.
4. Re-uses the same masks/scores/boxes shaping as `_forward_grounding` (see lines 191-222 of `sam3_image.py`).

Then bind: `self._model.predict_visual_prompt = self._native_visual_forward`.

- [ ] **Step 4: Smoke test on the running model container**

```bash
docker compose exec model python -c "
from carve_model.sam.sam3p1_adapter import build_sam3p1_image_predictor
import numpy as np
adapter = build_sam3p1_image_predictor()
img = np.random.default_rng(0).integers(0, 255, (480, 640, 3)).astype(np.uint8)
adapter.set_image(img)
emb = adapter.set_visual_prompt(img, {'kind': 'bbox', 'xyxy': [100,100,300,300]})
print('embed shape:', emb.shape, 'norm:', float(np.linalg.norm(emb)))
m, s, b = adapter.predict_with_visual_prompt(emb)
print('masks:', m.shape, 'scores:', s.shape, 'boxes:', b.shape)
"
```

Expected: embed `(D,)` with norm ≈ 1.0; masks `(N, H, W)`; no exceptions.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/sam3p1_adapter.py
git commit -m "feat(sam): native sam3 dense+global extraction for visual prompt"
```

### Task A7: Visual predictor factory + registry

**Files:**
- Modify: `apps/model/src/carve_model/sam/sam3_adapter.py`
- Modify: `apps/model/src/carve_model/sam/predictor.py`
- Test: `apps/model/tests/sam/test_visual_predictor_factory.py` (new)

- [ ] **Step 1: Failing test**

```python
import pytest
from carve_model.sam.predictor import (
    get_visual_predictor, set_visual_predictor, _reset_visual_predictor_for_test,
)


def test_get_visual_predictor_raises_when_unset():
    _reset_visual_predictor_for_test()
    with pytest.raises(RuntimeError, match="not_loaded"):
        get_visual_predictor()


def test_set_then_get_visual_predictor():
    _reset_visual_predictor_for_test()
    sentinel = object()
    set_visual_predictor(sentinel)
    assert get_visual_predictor() is sentinel
    _reset_visual_predictor_for_test()
```

→ FAIL.

- [ ] **Step 2: Implement registry in `predictor.py`**

Module-level `_VISUAL_PREDICTOR_FACTORY: VisualPredictor | None = None`. Add `set_visual_predictor`, `get_visual_predictor` (raises `RuntimeError("sam_visual_predictor_not_loaded")`), `_reset_visual_predictor_for_test`, and inside `load_predictor` wire:

```python
if get_sam_variant() == "sam3p1":
    set_visual_predictor(sam3_adapter.make_sam3_visual_predictor())
```

In `sam3_adapter.py`, add factory closure that reuses the `Sam3p1NativeImagePredictorAdapter` instance, with this contract:

```python
def make_sam3_visual_predictor():
    """Return a callable matching:
        f(*, target_b64: str, refer_b64: str, regions: list[dict]) -> list[dict]
    where each output dict has keys (counts, size, score, bbox, polygon)
    matching the existing /sam/text-prompt response shape.
    """
    adapter_holder: dict = {}

    def _adapter():
        if "a" not in adapter_holder:
            from carve_model.sam.sam3p1_adapter import build_sam3p1_image_predictor
            adapter_holder["a"] = build_sam3p1_image_predictor()
        return adapter_holder["a"]

    def _decode_b64(b64: str):
        import base64
        from PIL import Image
        import io
        import numpy as np
        return np.asarray(Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB"))

    def _polygonise(mask):
        # Reuse the existing polygonize helper used by the text path.
        from carve_model.sam.polygonize import mask_to_polygon
        return mask_to_polygon(mask)

    def _encode_mask_rle(mask):
        # Reuse the same RLE encoder used by the text path.
        from carve_model.sam.codec import mask_to_rle
        return mask_to_rle(mask)

    def call(*, target_b64, refer_b64, regions):
        adapter = _adapter()
        target = _decode_b64(target_b64)
        refer = _decode_b64(refer_b64)
        adapter.set_image(target)
        per_ref = [adapter.set_visual_prompt(refer, r) for r in regions]
        import numpy as np
        from carve_model.sam.visual_prompt_pool import l2norm
        pooled = l2norm(np.mean(per_ref, axis=0))
        masks, scores, boxes = adapter.predict_with_visual_prompt(pooled)
        out = []
        for m, s, b in zip(masks, scores, boxes):
            rle = _encode_mask_rle(m)
            polygon = _polygonise(m)
            out.append({
                "counts": rle["counts"], "size": rle["size"],
                "score": float(s), "bbox": [float(x) for x in b],
                "polygon": polygon,
            })
        return out

    return call
```

`mask_to_polygon` and `mask_to_rle` already exist in `apps/model/src/carve_model/sam/polygonize.py` and `apps/model/src/carve_model/sam/codec.py` respectively (verify exact symbol names; rename here if the actual function is `_polygonize_mask` etc.).

Run: `pytest apps/model/tests/sam/test_visual_predictor_factory.py -v` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/model/src/carve_model/sam/sam3_adapter.py apps/model/src/carve_model/sam/predictor.py apps/model/tests/sam/test_visual_predictor_factory.py
git commit -m "feat(sam): visual predictor factory + registry"
```

### Task A8: `POST /sam/visual-prompt` endpoint + status flag

**Files:**
- Modify: `apps/model/src/carve_model/sam/router.py`
- Test: `apps/model/tests/sam/test_visual_prompt_router.py` (new)

- [ ] **Step 1: Failing tests**

```python
from fastapi.testclient import TestClient
from carve_model.main import app

client = TestClient(app)


def test_visual_prompt_returns_409_when_variant_not_sam3p1(monkeypatch):
    monkeypatch.setenv("SAM_MODEL", "sam2")
    r = client.post("/sam/visual-prompt", json={
        "refer_b64": "aGVsbG8=",
        "regions": [{"kind": "bbox", "xyxy": [0, 0, 10, 10]}],
        "target_b64": "aGVsbG8=",
    })
    assert r.status_code == 409
    assert r.json()["detail"] == "sam3p1_not_enabled"


def test_visual_prompt_validates_mixed_ref_types():
    r = client.post("/sam/visual-prompt", json={
        "refer_b64": "aGVsbG8=",
        "regions": [
            {"kind": "bbox", "xyxy": [0, 0, 10, 10]},
            {"kind": "polygon", "points": [[0, 0], [1, 0], [1, 1]]},
        ],
        "target_b64": "aGVsbG8=",
    })
    assert r.status_code == 422
    assert "mixed" in r.json()["detail"]


def test_visual_prompt_status_flag(monkeypatch):
    monkeypatch.setenv("SAM_MODEL", "sam3p1")
    r = client.get("/sam/status")
    assert r.status_code == 200
    body = r.json()
    assert "visual_prompt_available" in body
    assert body["visual_prompt_available"] is True
```

→ FAIL.

- [ ] **Step 2: Implement endpoint + status flag**

```python
class VisualPromptRegion(BaseModel):
    kind: Literal["bbox", "polygon"]
    xyxy: list[float] | None = None
    points: list[list[float]] | None = None


class VisualPromptIn(BaseModel):
    refer_b64: str = Field(..., min_length=1)
    regions: list[VisualPromptRegion] = Field(..., min_length=1, max_length=64)
    target_b64: str = Field(..., min_length=1)


class VisualPromptOut(BaseModel):
    counts: str
    size: list[int]
    score: float
    bbox: list[float]
    polygon: list[list[float]] = []


@router.post("/visual-prompt", response_model=list[VisualPromptOut])
def sam_visual_prompt(payload: VisualPromptIn) -> list[dict]:
    if get_sam_variant() != "sam3p1":
        raise HTTPException(status_code=409, detail="sam3p1_not_enabled")
    kinds = {r.kind for r in payload.regions}
    if len(kinds) > 1:
        raise HTTPException(status_code=422, detail="mixed_ref_types")
    try:
        factory = get_visual_predictor()
    except RuntimeError:
        try:
            load_predictor(get_sam_model())
            factory = get_visual_predictor()
        except Exception as exc:
            raise HTTPException(status_code=503, detail="sam_visual_predictor_not_loaded") from exc
    regions = [r.model_dump(exclude_none=True) for r in payload.regions]
    return factory(target_b64=payload.target_b64, refer_b64=payload.refer_b64, regions=regions)
```

In `StatusOut`, add `visual_prompt_available: bool`. In `sam_status`, set it to `get_sam_variant() == "sam3p1"`.

Run: `pytest apps/model/tests/sam/test_visual_prompt_router.py -v` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/model/src/carve_model/sam/router.py apps/model/tests/sam/test_visual_prompt_router.py
git commit -m "feat(sam): POST /sam/visual-prompt + status flag"
```

**Phase A complete.** Run `docker compose restart model` to reload.

---

## Phase B — API service: auto_visual + sync + batch

### Task B1: `model_client.sam_visual_prompt`

**Files:**
- Modify: `apps/api/src/carve_api/inference/model_client.py`
- Test: `apps/api/tests/inference/test_model_client_visual.py` (new)

- [ ] **Step 1: Failing test (httpx mock)**

```python
import respx, httpx
from carve_api.inference.model_client import sam_visual_prompt


@respx.mock
def test_sam_visual_prompt_posts_to_model_service():
    route = respx.post("http://model:8001/sam/visual-prompt").mock(
        return_value=httpx.Response(200, json=[{
            "counts": "0", "size": [10, 10], "score": 0.9,
            "bbox": [1, 1, 9, 9], "polygon": [[1, 1], [9, 1], [9, 9]],
        }])
    )
    out = sam_visual_prompt(
        refer_b64="aGVsbG8=",
        regions=[{"kind": "bbox", "xyxy": [0, 0, 10, 10]}],
        target_b64="aGVsbG8=",
    )
    assert route.called
    assert out[0]["score"] == 0.9
```

→ FAIL.

- [ ] **Step 2: Implement client function**

Mirror `sam_text_prompt`'s shape in `model_client.py` — POST to `f"{MODEL_BASE}/sam/visual-prompt"`, raise `SamModelFailed` / `SamModelUnreachable` on the same conditions, return parsed JSON list.

```bash
pytest apps/api/tests/inference/test_model_client_visual.py -v
git add apps/api/src/carve_api/inference/model_client.py apps/api/tests/inference/test_model_client_visual.py
git commit -m "feat(api): sam_visual_prompt model client"
```

### Task B2: `sam_visual_prompt_for_asset`

**Files:**
- Modify: `apps/api/src/carve_api/inference/sam.py`
- Test: `apps/api/tests/inference/test_sam_visual.py` (new)

- [ ] **Step 1: Failing test**

```python
from unittest.mock import patch
from carve_api.inference.sam import sam_visual_prompt_for_asset


def test_sam_visual_prompt_for_asset_loads_target_and_refer_bytes(asset_factory):
    target = asset_factory(image=True)
    refer = asset_factory(image=True)
    with patch("carve_api.inference.sam.sam_visual_prompt") as mock_vp:
        mock_vp.return_value = []
        sam_visual_prompt_for_asset(
            target_asset=target, refer_asset=refer,
            regions=[{"kind": "bbox", "xyxy": [0, 0, 10, 10]}],
        )
        mock_vp.assert_called_once()
        kwargs = mock_vp.call_args.kwargs
        assert "refer_b64" in kwargs
        assert "target_b64" in kwargs
```

(Confirm `asset_factory` exists in `apps/api/tests/conftest.py`; rename if the project uses a different fixture name.)

→ FAIL.

- [ ] **Step 2: Implement**

```python
def sam_visual_prompt_for_asset(*, target_asset, refer_asset, regions):
    """Fetch target+refer asset bytes from MinIO and call /sam/visual-prompt.

    Mirrors sam_text_prompt_for_asset's error mapping (SamModelFailed,
    SamModelUnreachable). Returns the list-of-dicts payload the model
    service produced.
    """
    target_b64 = _b64_of_asset(target_asset)
    refer_b64 = _b64_of_asset(refer_asset)
    return sam_visual_prompt(
        refer_b64=refer_b64, regions=regions, target_b64=target_b64,
    )
```

`_b64_of_asset` already exists in this module (reused by `sam_text_prompt_for_asset`).

```bash
pytest apps/api/tests/inference/test_sam_visual.py -v
git add apps/api/src/carve_api/inference/sam.py apps/api/tests/inference/test_sam_visual.py
git commit -m "feat(api): sam_visual_prompt_for_asset"
```

### Task B3: `auto_visual_for_asset` orchestrator

**Files:**
- Create: `apps/api/src/carve_api/inference/auto_visual.py`
- Test: `apps/api/tests/inference/test_auto_visual.py` (new)

- [ ] **Step 1: Failing tests**

```python
import pytest
from carve_api.inference.auto_visual import (
    auto_visual_for_asset,
    AutoVisualMixedRefs, AutoVisualNoRefs, AutoVisualNoClass,
)


def test_auto_visual_creates_polygons_per_class(session, asset_factory, class_factory, task_factory, monkeypatch):
    task = task_factory()
    target = asset_factory(image=True, task=task)
    refer = asset_factory(image=True, task=task)
    cls = class_factory(task=task, name="cat")
    monkeypatch.setattr(
        "carve_api.inference.auto_visual.sam_visual_prompt_for_asset",
        lambda **_: [{"counts":"0","size":[10,10],"score":0.9,
                      "bbox":[1,1,9,9],"polygon":[[1,1],[9,1],[9,9]]}],
    )
    out = auto_visual_for_asset(
        session=session, asset=target, task=task,
        sources=[{"asset_id": str(refer.id), "groups": [
            {"class_id": str(cls.id),
             "refs": [{"kind": "bbox", "xyxy": [0, 0, 10, 10]}]}
        ]}],
        ref_kind="bbox", threshold=0.4, find_all=True,
        overwrite=False, actor_id=None,
    )
    assert out["annotations_created"] == 1
    assert out["per_class"][str(cls.id)] == 1


def test_mixed_ref_types_rejected(session, asset_factory, class_factory, task_factory):
    task = task_factory()
    asset = asset_factory(image=True, task=task)
    cls = class_factory(task=task)
    with pytest.raises(AutoVisualMixedRefs):
        auto_visual_for_asset(
            session=session, asset=asset, task=task,
            sources=[{"asset_id": str(asset.id), "groups": [
                {"class_id": str(cls.id), "refs": [
                    {"kind": "bbox", "xyxy": [0, 0, 10, 10]},
                    {"kind": "polygon", "points": [[0, 0], [1, 0], [1, 1]]},
                ]}
            ]}],
            ref_kind="bbox", threshold=0.4, find_all=True,
            overwrite=False, actor_id=None,
        )


def test_no_refs_rejected(session, asset_factory, task_factory):
    task = task_factory()
    asset = asset_factory(image=True, task=task)
    with pytest.raises(AutoVisualNoRefs):
        auto_visual_for_asset(
            session=session, asset=asset, task=task,
            sources=[], ref_kind="bbox", threshold=0.4,
            find_all=True, overwrite=False, actor_id=None,
        )


def test_no_class_assignment_rejected(session, asset_factory, task_factory):
    task = task_factory()
    asset = asset_factory(image=True, task=task)
    with pytest.raises(AutoVisualNoClass):
        auto_visual_for_asset(
            session=session, asset=asset, task=task,
            sources=[{"asset_id": str(asset.id), "groups": [
                {"class_id": "", "refs": [{"kind": "bbox", "xyxy": [0, 0, 10, 10]}]}
            ]}],
            ref_kind="bbox", threshold=0.4, find_all=True,
            overwrite=False, actor_id=None,
        )


def test_overwrite_safe_when_no_matches(session, asset_factory, class_factory, task_factory, monkeypatch, annotation_factory):
    task = task_factory()
    target = asset_factory(image=True, task=task)
    refer = asset_factory(image=True, task=task)
    cls = class_factory(task=task)
    existing = annotation_factory(task=task, asset=target, cls=cls)
    monkeypatch.setattr(
        "carve_api.inference.auto_visual.sam_visual_prompt_for_asset",
        lambda **_: [],
    )
    auto_visual_for_asset(
        session=session, asset=target, task=task,
        sources=[{"asset_id": str(refer.id), "groups": [
            {"class_id": str(cls.id), "refs": [{"kind": "bbox", "xyxy": [0, 0, 10, 10]}]}
        ]}],
        ref_kind="bbox", threshold=0.4, find_all=True,
        overwrite=True, actor_id=None,
    )
    session.flush()
    assert session.get(type(existing), existing.id) is not None
```

→ FAIL.

- [ ] **Step 2: Implement**

```python
# apps/api/src/carve_api/inference/auto_visual.py
"""Multi-source SAM 3.1 visual-prompt auto-annotate.

Mirrors auto_text.py shape; replaces text concept with visual exemplars.
See spec §5.3 for the (source, class) dispatch ordering.
"""
from __future__ import annotations
import uuid

from sqlalchemy import delete as sa_delete
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset
from carve_api.errors import AppError
from carve_api.inference.autoannotate import _resolve_frame_id
from carve_api.inference.sam import sam_visual_prompt_for_asset
from carve_api.projects.models import Class, Task


class AutoVisualMixedRefs(AppError):
    http_status = 422
    code = "mixed_ref_types"


class AutoVisualNoRefs(AppError):
    http_status = 422
    code = "no_refs"


class AutoVisualNoClass(AppError):
    http_status = 422
    code = "no_class_assignment"


def auto_visual_for_asset(*, session, asset, task, sources, ref_kind,
                          threshold, find_all, overwrite, actor_id):
    if not sources:
        raise AutoVisualNoRefs("no_refs")
    seen_kinds: set[str] = set()
    for src in sources:
        for grp in src["groups"]:
            if not grp.get("class_id"):
                raise AutoVisualNoClass("no_class_assignment")
            for ref in grp["refs"]:
                seen_kinds.add(ref["kind"])
    if len(seen_kinds) > 1 or (seen_kinds and ref_kind not in seen_kinds):
        raise AutoVisualMixedRefs("mixed_ref_types")
    if not seen_kinds:
        raise AutoVisualNoRefs("no_refs")

    frame_id = _resolve_frame_id(session, asset)
    new_anns: list[Annotation] = []
    per_class: dict[str, int] = {}
    touched_class_ids: set[uuid.UUID] = set()

    asset_cache: dict[str, Asset] = {}
    def _refer_asset(asset_id: str) -> Asset:
        if asset_id not in asset_cache:
            asset_cache[asset_id] = session.get(Asset, uuid.UUID(asset_id))
        return asset_cache[asset_id]

    for src in sources:
        refer = _refer_asset(src["asset_id"])
        for grp in src["groups"]:
            cls_id = uuid.UUID(grp["class_id"])
            touched_class_ids.add(cls_id)
            results = sam_visual_prompt_for_asset(
                target_asset=asset, refer_asset=refer, regions=grp["refs"],
            )
            kept = [r for r in results if float(r.get("score", 0.0)) >= threshold]
            if not find_all and kept:
                kept = [max(kept, key=lambda r: float(r.get("score", 0.0)))]
            per_class[str(cls_id)] = per_class.get(str(cls_id), 0) + len(kept)
            for r in kept:
                new_anns.append(_build_annotation(task, frame_id, cls_id, r, actor_id))

    if overwrite and new_anns and frame_id is not None:
        session.execute(sa_delete(Annotation).where(
            Annotation.task_id == task.id,
            Annotation.frame_id == frame_id,
            Annotation.class_id.in_(list(touched_class_ids)),
        ))
    for ann in new_anns:
        session.add(ann)
    session.flush()
    return {"annotations_created": len(new_anns), "per_class": per_class}


def _build_annotation(task, frame_id, cls_id, r, actor_id) -> Annotation:
    polygon = r.get("polygon") or []
    if isinstance(polygon, list) and len(polygon) >= 3:
        return Annotation(
            task_id=task.id, frame_id=frame_id, class_id=cls_id,
            kind=AnnotationKind.polygon,
            geometry={"kind": "polygon",
                      "points": [[float(p[0]), float(p[1])] for p in polygon]},
            track_id=None, created_by=actor_id,
        )
    return Annotation(
        task_id=task.id, frame_id=frame_id, class_id=cls_id,
        kind=AnnotationKind.mask,
        geometry={"kind": "mask_rle",
                  "size": [int(r["size"][0]), int(r["size"][1])],
                  "counts": r["counts"]},
        track_id=None, created_by=actor_id,
    )
```

```bash
pytest apps/api/tests/inference/test_auto_visual.py -v
git add apps/api/src/carve_api/inference/auto_visual.py apps/api/tests/inference/test_auto_visual.py
git commit -m "feat(api): auto_visual_for_asset orchestrator"
```

### Task B4: Sync route `POST /sam/auto-visual/{asset_id}`

**Files:**
- Modify: `apps/api/src/carve_api/inference/router.py`
- Test: `apps/api/tests/inference/test_auto_visual_router.py` (new)

- [ ] **Step 1: Failing test**

```python
def test_auto_visual_sync_endpoint(client, auth_headers, asset_factory, class_factory, task_factory, monkeypatch):
    task = task_factory()
    target = asset_factory(image=True, task=task)
    refer = asset_factory(image=True, task=task)
    cls = class_factory(task=task)
    monkeypatch.setattr(
        "carve_api.inference.auto_visual.sam_visual_prompt_for_asset",
        lambda **_: [{"counts":"0","size":[10,10],"score":0.9,"bbox":[1,1,9,9],
                      "polygon":[[1,1],[9,1],[9,9]]}],
    )
    r = client.post(
        f"/assets/{target.id}/sam/auto-visual",
        headers=auth_headers,
        json={
            "sources": [{"asset_id": str(refer.id), "groups": [
                {"class_id": str(cls.id), "refs": [
                    {"kind": "bbox", "xyxy": [0, 0, 10, 10]}
                ]}
            ]}],
            "ref_kind": "bbox", "threshold": 0.4, "find_all": True, "overwrite": False,
        },
    )
    assert r.status_code == 200
    assert r.json()["annotations_created"] == 1
```

→ FAIL.

- [ ] **Step 2: Implement**

In `router.py`, mirror `sam_auto_text_endpoint` (line 622). Authn/viewer-403 parity. Map `AutoVisual*` exceptions → 422 via the existing `AppError` middleware. Pydantic body model:

```python
class AutoVisualGroupIn(BaseModel):
    class_id: str
    refs: list[VisualPromptRegion]


class AutoVisualSourceIn(BaseModel):
    asset_id: str
    groups: list[AutoVisualGroupIn] = Field(min_length=1)


class AutoVisualBody(BaseModel):
    sources: list[AutoVisualSourceIn] = Field(min_length=1)
    ref_kind: Literal["bbox", "polygon"]
    threshold: float = Field(ge=0.0, le=1.0, default=0.4)
    find_all: bool = True
    overwrite: bool = False
```

```bash
pytest apps/api/tests/inference/test_auto_visual_router.py -v
git add apps/api/src/carve_api/inference/router.py apps/api/tests/inference/test_auto_visual_router.py
git commit -m "feat(api): POST /sam/auto-visual sync endpoint"
```

### Task B5: Batch worker — `kind=sam_auto_visual`

**Files:**
- Modify: `apps/api/src/carve_api/inference/batch.py`
- Test: `apps/api/tests/inference/test_auto_visual_batch.py` (new)

- [ ] **Step 1: Failing test**

```python
def test_run_auto_visual_batch_progress_and_persistence(asset_factory, class_factory, task_factory, monkeypatch):
    task = task_factory()
    targets = [asset_factory(image=True, task=task) for _ in range(2)]
    refer = asset_factory(image=True, task=task)
    cls = class_factory(task=task)
    monkeypatch.setattr(
        "carve_api.inference.auto_visual.sam_visual_prompt_for_asset",
        lambda **_: [{"counts":"0","size":[10,10],"score":0.9,"bbox":[1,1,9,9],
                      "polygon":[[1,1],[9,1],[9,9]]}],
    )
    from carve_api.inference.batch import (
        AutoVisualBatchPayload, run_auto_visual_batch,
    )
    payload = AutoVisualBatchPayload(
        task_id=str(task.id), job_id="jobx", actor_id=None,
        sources=[{"asset_id": str(refer.id), "groups": [
            {"class_id": str(cls.id), "refs": [{"kind": "bbox", "xyxy": [0, 0, 10, 10]}]}
        ]}],
        ref_kind="bbox", threshold=0.4, find_all=True, overwrite=False,
    )
    out = run_auto_visual_batch(payload)
    assert out["status"] == "completed"
    assert out["total_annotations_created"] == 2
```

→ FAIL.

- [ ] **Step 2: Implement payload + worker**

Add `AutoVisualBatchPayload` (dataclass mirroring `AutoTextBatchPayload` at line 39) and `run_auto_visual_batch` (mirror `run_auto_text_batch` at line 293). Per-asset commit, Redis hash progress, cancel-flag check, `kind="sam_auto_visual"` in the progress hash. Reuse `_init_progress` / `_update_progress` helpers if present; otherwise replicate the auto-text shape.

```bash
pytest apps/api/tests/inference/test_auto_visual_batch.py -v
git add apps/api/src/carve_api/inference/batch.py apps/api/tests/inference/test_auto_visual_batch.py
git commit -m "feat(api): sam_auto_visual RQ batch worker"
```

### Task B6: Batch routes — enqueue / poll / cancel

**Files:**
- Modify: `apps/api/src/carve_api/inference/router.py`
- Test: `apps/api/tests/inference/test_auto_visual_router.py` (extend)

- [ ] **Step 1: Failing tests**

```python
def test_enqueue_auto_visual_batch_returns_job_id(client, auth_headers, task_factory, asset_factory, class_factory, monkeypatch):
    task = task_factory()
    refer = asset_factory(image=True, task=task)
    cls = class_factory(task=task)
    captured = {}
    monkeypatch.setattr(
        "carve_api.inference.batch.enqueue_rq_job",
        lambda **kw: captured.update(kw) or "rq-job-1",
    )
    r = client.post(
        f"/tasks/{task.id}/sam/auto-visual-batch",
        headers=auth_headers,
        json={"sources":[{"asset_id":str(refer.id),"groups":[{"class_id":str(cls.id),"refs":[{"kind":"bbox","xyxy":[0,0,10,10]}]}]}],
              "ref_kind":"bbox","threshold":0.4,"find_all":True,"overwrite":False},
    )
    assert r.status_code == 200
    assert "job_id" in r.json()


def test_poll_auto_visual_batch(client, auth_headers, task_factory, redis_client):
    task = task_factory()
    redis_client.hset(f"sam:auto-visual:{task.id}:job1",
                      mapping={"status":"running","done":"1","total":"2","failed":"0",
                               "total_annotations_created":"3"})
    r = client.get(f"/tasks/{task.id}/sam/auto-visual-batch/job1", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["done"] == 1 and body["total"] == 2


def test_cancel_auto_visual_batch(client, auth_headers, task_factory, redis_client):
    task = task_factory()
    redis_client.hset(f"sam:auto-visual:{task.id}:job1", mapping={"status":"running"})
    r = client.post(f"/tasks/{task.id}/sam/auto-visual-batch/job1/cancel", headers=auth_headers)
    assert r.status_code == 200
    assert redis_client.hget(f"sam:auto-visual:{task.id}:job1", "status") == b"canceled"
```

→ FAIL.

- [ ] **Step 2: Implement routes**

Three routes mirroring `enqueue_sam_auto_text_batch` (router.py:380), `get_sam_auto_text_batch_progress` (router.py:445), `cancel_sam_auto_text_batch` (router.py:503). Redis keys: `sam:auto-visual:{task_id}:{job_id}`. Same viewer-403 gate as the text batch.

```bash
pytest apps/api/tests/inference/test_auto_visual_router.py -v
git add apps/api/src/carve_api/inference/router.py apps/api/tests/inference/test_auto_visual_router.py
git commit -m "feat(api): auto-visual batch routes (enqueue/poll/cancel)"
```

**Phase B complete.**

---

## Phase C — Frontend: shared picker + Auto-Annotate dialog refactor

### Task C1: Extract `VisualReferencePicker` shared component

**Files:**
- Create: `apps/web/src/components/annotation/VisualReferencePicker.tsx`
- Test: `apps/web/tests/visual-reference-picker.test.tsx` (new)

- [ ] **Step 1: Failing component test**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { VisualReferencePicker } from "@/components/annotation/VisualReferencePicker";

describe("VisualReferencePicker", () => {
  const baseClasses = [{ id: "c1", name: "Cat", color: "#f00" }];
  const baseAssets = [{ id: "a1", original_name: "img1.jpg", thumbnail_url: "x", kind: "image" }];

  it("filters refs by refKindFilter='bbox' (polygon refs hidden)", () => {
    const annotationsByAssetId = new Map([
      ["a1", [
        { id: "r1", classId: "c1", kind: "bbox", geometry: { kind:"bbox", x:0,y:0,w:10,h:10 } },
        { id: "r2", classId: "c1", kind: "polygon", geometry: { kind:"polygon", points:[[0,0],[5,0],[5,5]] } },
      ]],
    ]);
    render(
      <VisualReferencePicker
        assetId="a1" taskId="t1" classes={baseClasses}
        pickableAssets={baseAssets}
        annotationsByAssetId={annotationsByAssetId}
        annotationsById={{}} picks={{}}
        onPicksChange={() => {}}
        refKindFilter="bbox"
      />
    );
    expect(screen.getByTestId("yoloe-visual-ref-r1")).toBeTruthy();
    expect(screen.queryByTestId("yoloe-visual-ref-r2")).toBeNull();
  });

  it("auto-fills source class on first pick toggle", () => {
    const onPicksChange = vi.fn();
    const annotationsByAssetId = new Map([
      ["a1", [{ id: "r1", classId: "c1", kind: "bbox", geometry: { kind:"bbox", x:0,y:0,w:10,h:10 } }]],
    ]);
    render(
      <VisualReferencePicker
        assetId="a1" taskId="t1" classes={baseClasses}
        pickableAssets={baseAssets}
        annotationsByAssetId={annotationsByAssetId}
        annotationsById={{}} picks={{}}
        onPicksChange={onPicksChange}
      />
    );
    fireEvent.click(screen.getByTestId("yoloe-visual-ref-r1").querySelector("button")!);
    const updated = onPicksChange.mock.calls[0][0];
    expect(updated["a1:r1"].classId).toBe("c1");
  });
});
```

→ FAIL.

- [ ] **Step 2: Extract picker**

Move the picker JSX + state helpers from `YoloeDialog.tsx:1057-1300` into `VisualReferencePicker.tsx`. Component props:

```tsx
export interface VisualPick {
  assetId: string;
  annotationId: string;
  classId: string;
  className: string;
  color: string;
  sourceKind: "bbox" | "polygon";
  geometry:
    | { kind: "bbox"; xyxy: [number, number, number, number] }
    | { kind: "polygon"; points: [number, number][] };
}

interface VisualReferencePickerProps {
  assetId: string | null;
  taskId?: string;
  classes: ClassRow[];
  pickableAssets: Asset[];
  annotationsByAssetId: Map<string, RawRef[]>;
  annotationsById: Record<string, AnnotationDraft>;
  picks: Record<string, VisualPick>;
  onPicksChange: (next: Record<string, VisualPick>) => void;
  refKindFilter?: "bbox" | "polygon";
}
```

Component is fully controlled (parent owns `picks`). Move `pickKey`, `geometryToXyxy`, `VisualReference` types into the new file and re-export.

- [ ] **Step 3: Add geometry getter on `VisualPick`**

Extend `VisualPick` to carry the original geometry (not just xyxy) so SAM can use polygon points directly. `VisualReferencePicker` populates `geometry` on toggle. YOLOE's existing wire builder converts polygon→xyxy for itself (no behavior change for YOLOE).

```bash
pnpm --filter web vitest run apps/web/tests/visual-reference-picker.test.tsx
git add apps/web/src/components/annotation/VisualReferencePicker.tsx apps/web/tests/visual-reference-picker.test.tsx
git commit -m "feat(web): extract VisualReferencePicker shared component"
```

### Task C2: Update `YoloeDialog` to consume the shared picker

**Files:**
- Modify: `apps/web/src/components/annotation/YoloeDialog.tsx`

- [ ] **Step 1: Replace inline picker with `<VisualReferencePicker>`**

Strip the picker JSX between lines 1057–1300 of `YoloeDialog.tsx`. Replace with:

```tsx
<VisualReferencePicker
  assetId={assetId}
  taskId={taskId}
  classes={classes}
  pickableAssets={pickableAssets}
  annotationsByAssetId={annotationsByAssetId}
  annotationsById={annotationsById}
  picks={picks}
  onPicksChange={setPicks}
/>
```

`refKindFilter` omitted ⇒ YOLOE keeps both kinds. The existing `buildVisualSources()` continues to flatten polygon→xyxy on send (no wire change).

- [ ] **Step 2: Run YOLOE tests**

```bash
pnpm --filter web vitest run apps/web/tests/yoloe-dialog.test.tsx
```

Expected: existing YOLOE tests still pass.

- [ ] **Step 3: Manual smoke**

```bash
docker compose up -d web
# Open editor, open Smart Find > Visual mode, verify picker still works.
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/annotation/YoloeDialog.tsx
git commit -m "refactor(web): YoloeDialog consumes shared VisualReferencePicker"
```

### Task C3: SAM API client methods

**Files:**
- Modify: `apps/web/src/api/sam.ts`
- Test: extend `apps/web/tests/sam-api.test.ts` (create if absent)

- [ ] **Step 1: Failing tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { samApi } from "@/api/sam";
import { api } from "@/api/client";


describe("samApi.autoVisual", () => {
  it("posts to /assets/:id/sam/auto-visual", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ data: { annotations_created: 2 } });
    await samApi.autoVisual("asset-1", {
      sources: [{ asset_id: "src-1", groups: [{ class_id: "c1", refs: [{ kind:"bbox", xyxy:[0,0,10,10] }] }] }],
      ref_kind: "bbox", threshold: 0.4, find_all: true, overwrite: false,
    });
    expect(post).toHaveBeenCalledWith(
      "/assets/asset-1/sam/auto-visual",
      expect.objectContaining({ ref_kind: "bbox" }),
    );
  });
});
```

→ FAIL.

- [ ] **Step 2: Implement**

```typescript
// apps/web/src/api/sam.ts (additions)
export interface SamVisualRefBbox { kind: "bbox"; xyxy: [number, number, number, number]; }
export interface SamVisualRefPolygon { kind: "polygon"; points: [number, number][]; }
export type SamVisualRef = SamVisualRefBbox | SamVisualRefPolygon;
export interface SamVisualGroup { class_id: string; refs: SamVisualRef[]; }
export interface SamVisualSource { asset_id: string; groups: SamVisualGroup[]; }
export interface SamAutoVisualBody {
  sources: SamVisualSource[];
  ref_kind: "bbox" | "polygon";
  threshold: number;
  find_all: boolean;
  overwrite: boolean;
}
export interface SamAutoVisualResult { annotations_created: number; per_class: Record<string, number>; }

samApi.autoVisual = async (assetId: string, body: SamAutoVisualBody): Promise<SamAutoVisualResult> =>
  (await api.post<SamAutoVisualResult>(`/assets/${assetId}/sam/auto-visual`, body)).data;

samApi.autoVisualBatch = async (taskId: string, body: SamAutoVisualBody): Promise<{ job_id: string }> =>
  (await api.post(`/tasks/${taskId}/sam/auto-visual-batch`, body)).data;

samApi.autoVisualBatchProgress = async (taskId: string, jobId: string) =>
  (await api.get(`/tasks/${taskId}/sam/auto-visual-batch/${jobId}`)).data;

samApi.autoVisualBatchCancel = async (taskId: string, jobId: string) =>
  (await api.post(`/tasks/${taskId}/sam/auto-visual-batch/${jobId}/cancel`)).data;
```

Also extend `SamStatusOut` to include `visual_prompt_available: boolean`.

```bash
pnpm --filter web vitest run apps/web/tests/sam-api.test.ts
git add apps/web/src/api/sam.ts apps/web/tests/sam-api.test.ts
git commit -m "feat(web): samApi.autoVisual + batch + progress + cancel"
```

### Task C4: `AutoAnnotateDialog` 2-tab layout (Text + Visual)

**Files:**
- Modify: `apps/web/src/components/annotation/AutoAnnotateDialog.tsx`
- Create: `apps/web/src/state/useTaskRefs.ts`
- Test: `apps/web/tests/auto-annotate-visual.test.tsx` (new)

- [ ] **Step 1: Extract `useTaskRefs` hook from YoloeDialog**

`YoloeDialog.tsx:244-300` queries task assets + task annotations, then derives `pickableAssets` and `annotationsByAssetId`. Lift the same logic into a shared hook so the SAM dialog reuses it.

```tsx
// apps/web/src/state/useTaskRefs.ts
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { assetsApi, type Asset } from "@/api/assets";
import { annotationsApi } from "@/api/annotations";
import { useAnnotations } from "@/state/annotations";

export function useTaskRefs({ taskId, assetId, enabled = true }: {
  taskId?: string; assetId: string | null; enabled?: boolean;
}) {
  const taskAssetsQ = useQuery({
    queryKey: ["task-refs-assets", taskId],
    queryFn: () => assetsApi.listForTask(taskId!),
    enabled: !!taskId && enabled,
    staleTime: 30_000,
  });
  const taskAnnotationsQ = useQuery({
    queryKey: ["task-refs-annotations", taskId],
    queryFn: () => annotationsApi.listForTaskRaw(taskId!),
    enabled: !!taskId && enabled,
    staleTime: 5_000,
  });
  const annotationsByAssetId = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const a of taskAnnotationsQ.data ?? []) {
      if (!a.asset_id) continue;
      if (a.kind !== "bbox" && a.kind !== "polygon") continue;
      const arr = m.get(a.asset_id) ?? [];
      arr.push({ id: a.id, classId: a.class_id, kind: a.kind, geometry: a.geometry });
      m.set(a.asset_id, arr);
    }
    return m;
  }, [taskAnnotationsQ.data]);
  const pickableAssets = useMemo<Asset[]>(() => {
    const all = taskAssetsQ.data ?? [];
    return all.filter(
      a => a.kind === "image" && (
        (annotationsByAssetId.get(a.id)?.length ?? 0) > 0 || a.id === assetId
      ),
    );
  }, [taskAssetsQ.data, annotationsByAssetId, assetId]);
  const annotationsById = useAnnotations((s) => s.byId);
  return {
    pickableAssets, annotationsByAssetId, annotationsById,
    isLoading: taskAssetsQ.isLoading || taskAnnotationsQ.isLoading,
  };
}
```

Refactor `YoloeDialog.tsx` to call `useTaskRefs({ taskId, assetId, enabled: open && mode === "visual" })` instead of its inline queries. Re-run YOLOE tests to confirm no regression.

- [ ] **Step 2: Failing tests for the SAM dialog**

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AutoAnnotateDialog } from "@/components/annotation/AutoAnnotateDialog";

vi.mock("@/api/phase2", () => ({
  modelsApi: {
    samStatus: vi.fn(async () => ({ variant: "sam3p1", visual_prompt_available: true })),
  },
}));

describe("AutoAnnotateDialog visual tab", () => {
  it("hides the Visual tab when visual_prompt_available is false", async () => {
    const { modelsApi } = await import("@/api/phase2");
    (modelsApi.samStatus as any).mockResolvedValueOnce({ variant: "sam3", visual_prompt_available: false });
    render(<AutoAnnotateDialog assetId="a1" taskId="t1" classes={[]} />);
    fireEvent.click(screen.getByTestId("auto-annotate-trigger"));
    await waitFor(() => expect(screen.getByText(/Auto-annotate/)).toBeTruthy());
    expect(screen.queryByTestId("auto-annotate-mode-visual")).toBeNull();
  });

  it("renders Visual tab when sam3p1 + visual_prompt_available", async () => {
    render(<AutoAnnotateDialog assetId="a1" taskId="t1" classes={[]} />);
    fireEvent.click(screen.getByTestId("auto-annotate-trigger"));
    await waitFor(() => expect(screen.getByTestId("auto-annotate-mode-visual")).toBeTruthy());
    fireEvent.click(screen.getByTestId("auto-annotate-mode-visual"));
    expect(screen.getByTestId("auto-visual-ref-kind")).toBeTruthy();
  });

  it("switching ref-type with non-empty picks shows confirm modal", async () => {
    // Render dialog with one pick already made.
    // Click Polygon toggle.
    // Assert confirm modal appears and does NOT clear picks until user confirms.
    // (Test body left to the implementing engineer; testid hooks: 'auto-visual-ref-kind-confirm'.)
  });

  it("Run button disabled until at least one pick has a class", async () => {
    // Render with empty picks → run disabled.
    // Add a pick with class → run enabled.
  });
});
```

→ FAIL.

- [ ] **Step 3: Refactor dialog into 2 tabs**

Wrap the current body of `AutoAnnotateDialog.tsx` in a tab switcher matching `YoloeDialog`'s `MODE_TABS` pattern. Tab ids: `"text"`, `"visual"`. Visual tab is rendered only when `samStatusQuery.data?.visual_prompt_available === true`. Test ids: `auto-annotate-mode-text`, `auto-annotate-mode-visual`.

Keep all existing text-mode state/logic in a `TextBody` inline component. The trigger button stays the same.

- [ ] **Step 4: Implement Visual body**

```tsx
function VisualBody({ assetId, taskId, classes, onSuccess, setOpen }: {
  assetId: string | null; taskId?: string; classes: ClassRow[];
  onSuccess?: (n: number) => void; setOpen: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [refKind, setRefKind] = useState<"bbox" | "polygon">("bbox");
  const [picks, setPicks] = useState<Record<string, VisualPick>>({});
  const [confirmSwitchTo, setConfirmSwitchTo] = useState<"bbox" | "polygon" | null>(null);
  const [scope, setScope] = useState<"this" | "all">("this");
  const [threshold, setThreshold] = useState(0.4);
  const [findAll, setFindAll] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const { pickableAssets, annotationsByAssetId, annotationsById, isLoading } =
    useTaskRefs({ taskId, assetId, enabled: !!taskId });

  function requestSwitch(next: "bbox" | "polygon") {
    if (next === refKind) return;
    if (Object.keys(picks).length > 0) {
      setConfirmSwitchTo(next);
    } else {
      setRefKind(next);
    }
  }

  function buildSources() {
    const bySource = new Map<string, Map<string, SamVisualRef[]>>();
    for (const p of Object.values(picks)) {
      if (!p.classId) continue;
      const inner = bySource.get(p.assetId) ?? new Map();
      const refs = inner.get(p.classId) ?? [];
      refs.push(p.geometry as SamVisualRef);
      inner.set(p.classId, refs);
      bySource.set(p.assetId, inner);
    }
    return Array.from(bySource.entries()).map(([asset_id, inner]) => ({
      asset_id,
      groups: Array.from(inner.entries()).map(([class_id, refs]) => ({ class_id, refs })),
    }));
  }

  const summary = useMemo(() => {
    const sources = new Set<string>();
    const classes = new Set<string>();
    let unassigned = 0;
    for (const p of Object.values(picks)) {
      sources.add(p.assetId);
      if (p.classId) classes.add(p.classId);
      else unassigned += 1;
    }
    return { pickCount: Object.keys(picks).length, sourceCount: sources.size, classCount: classes.size, unassigned };
  }, [picks]);

  const canRun = summary.pickCount > 0 && summary.unassigned === 0 && (
    (scope === "this" && !!assetId) || (scope === "all" && !!taskId)
  );

  const run = useMutation({
    mutationFn: async () => {
      const body: SamAutoVisualBody = {
        sources: buildSources(),
        ref_kind: refKind,
        threshold, find_all: findAll, overwrite,
      };
      if (scope === "all") {
        if (!taskId) throw new Error("no_task");
        const r = await samApi.autoVisualBatch(taskId, body);
        return { kind: "batch" as const, job_id: r.job_id };
      }
      if (!assetId) throw new Error("no_asset");
      const r = await samApi.autoVisual(assetId, body);
      return { kind: "sync" as const, ...r };
    },
    onSuccess: (result) => {
      if (result.kind === "batch") { setRunningJobId(result.job_id); return; }
      qc.invalidateQueries({ queryKey: ["annotations"] });
      showToast(
        result.annotations_created > 0
          ? `Created ${result.annotations_created} annotation${result.annotations_created === 1 ? "" : "s"}.`
          : "No matches above the threshold.",
        { variant: result.annotations_created > 0 ? "success" : "warning" },
      );
      onSuccess?.(result.annotations_created);
      setOpen(false);
    },
    onError: () => showToast("SAM Visual Prompt failed.", { variant: "error" }),
  });

  if (runningJobId && taskId) {
    return (
      <BatchProgressView
        taskId={taskId} jobId={runningJobId}
        progressFetcher={() => samApi.autoVisualBatchProgress(taskId, runningJobId)}
        onCancel={() => samApi.autoVisualBatchCancel(taskId, runningJobId)}
        onDone={(final) => { setRunningJobId(null); onSuccess?.(final?.total_annotations_created ?? 0); setOpen(false); }}
      />
    );
  }

  return (
    <>
      <div role="tablist" data-testid="auto-visual-ref-kind">
        <button data-testid="auto-visual-ref-kind-bbox" onClick={() => requestSwitch("bbox")} aria-pressed={refKind === "bbox"}>Bbox</button>
        <button data-testid="auto-visual-ref-kind-polygon" onClick={() => requestSwitch("polygon")} aria-pressed={refKind === "polygon"}>Polygon</button>
      </div>
      <VisualReferencePicker
        assetId={assetId} taskId={taskId} classes={classes}
        pickableAssets={pickableAssets}
        annotationsByAssetId={annotationsByAssetId}
        annotationsById={annotationsById}
        picks={picks} onPicksChange={setPicks}
        refKindFilter={refKind}
      />
      {/* Scope, threshold, find, overwrite — copy from text body */}
      <DialogFooter>
        <Button onClick={() => setOpen(false)}>Cancel</Button>
        <Button disabled={!canRun} loading={run.isPending} onClick={() => run.mutate()}
                data-testid="auto-annotate-run">
          {scope === "this" ? "Run" : "Run on all assets"}
        </Button>
      </DialogFooter>
      {confirmSwitchTo && (
        <ConfirmModal
          title={`Switch to ${confirmSwitchTo}? This clears your current picks.`}
          onConfirm={() => { setPicks({}); setRefKind(confirmSwitchTo); setConfirmSwitchTo(null); }}
          onCancel={() => setConfirmSwitchTo(null)}
        />
      )}
    </>
  );
}
```

`ConfirmModal` is the existing `Dialog`-derived confirm component used elsewhere (e.g., `EditorSettingsDialog`). If a project-shared confirm doesn't exist, render an inline `<Dialog>` with two buttons — keep it ~20 lines.

`BatchProgressView` should be parameterised so the existing component (currently inside `AutoAnnotateDialog.tsx`) accepts a `progressFetcher`/`onCancel` callback. Alternative: copy the SAM auto-text `BatchProgressView` body into a new function specific to the visual flow. Pick whichever produces less churn at implementation time; document the choice in the commit message.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter web vitest run apps/web/tests/auto-annotate-visual.test.tsx
```

→ PASS.

- [ ] **Step 6: Manual browser smoke**

```bash
docker compose up -d web api model worker
# Open editor on an image-only task with at least 2 image assets, draw a bbox + polygon on each.
# Open Auto-Annotate, confirm Visual tab visible (sam3p1 active).
# Toggle ref-type with picks present → confirm modal.
# Run "this image" → polygons land. Run "all assets" → progress, cancel, background.
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/annotation/AutoAnnotateDialog.tsx \
        apps/web/src/components/annotation/YoloeDialog.tsx \
        apps/web/src/state/useTaskRefs.ts \
        apps/web/tests/auto-annotate-visual.test.tsx
git commit -m "feat(web): SAM Visual Prompt tab in Auto-Annotate dialog"
```

**Phase C complete.** End-to-end manual flow works.

---

## Phase D — E2E + version bump

### Task D1: Playwright E2E

**Files:**
- Modify (or create) `apps/web/tests/e2e/auto-annotate.spec.ts`

- [ ] **Step 1: Add a Visual-Prompt scenario**

```ts
import { test, expect } from "@playwright/test";
import { login, openImageTask, drawBbox, assignClass } from "./helpers";

test("auto-annotate visual prompt — bbox ref produces polygon on target", async ({ page }) => {
  await login(page);
  await openImageTask(page, process.env.E2E_FIXTURE_TASK_ID!);
  await drawBbox(page, "first-asset", [200, 200, 400, 400]);
  await assignClass(page, "cat");
  await page.getByTestId("auto-annotate-trigger").click();
  await page.getByTestId("auto-annotate-mode-visual").click();
  await page.getByTestId(/yoloe-visual-ref-/).first().click();
  await page.getByTestId("auto-annotate-run").click();
  await expect(page.getByText(/Created \d+ annotation/)).toBeVisible({ timeout: 30_000 });
});
```

If `apps/web/tests/e2e/helpers.ts` does not yet expose `drawBbox` / `assignClass`, add minimal wrappers around the canvas pointer-event API used by other e2e specs.

- [ ] **Step 2: Run + commit**

```bash
pnpm --filter web e2e auto-annotate.spec.ts
git add apps/web/tests/e2e/auto-annotate.spec.ts
git commit -m "test(e2e): SAM Visual Prompt run produces polygons"
```

### Task D2: Version bump + release notes

**Files:**
- The version-string constant in the editor footer (locate via grep).

- [ ] **Step 1: Bump to v3.28.0**

```bash
grep -rn "v3.27" apps/web/src --include="*.ts" --include="*.tsx" | head
# Bump file(s) to v3.28.0
```

- [ ] **Step 2: Commit**

```bash
git add -p   # pick only the bumped version constants
git commit -m "chore(release): v3.28.0 SAM Visual Prompt — pick bbox or polygon refs, find similar across the task with native SAM 3.1 PCS"
```

---

## Done

The user can now:
1. Open Auto-Annotate on an image asset within a task.
2. Switch to the **Visual Prompt** tab (visible only with SAM 3.1 native).
3. Choose **Bbox** or **Polygon** as reference type (single-type per run).
4. Pick references from the thumbnail strip; auto-class kicks in on first toggle, editable after.
5. Run on this image (sync) or all assets in task (batch with progress / cancel / background).
6. Power users can opt into TTA / color aug / self-attention / cross-image refinement via env flags on the model service.

Annotations land on the same persistence path as auto-text, with the same overwrite-safety semantics (compute first, delete only when the run produced rows).
