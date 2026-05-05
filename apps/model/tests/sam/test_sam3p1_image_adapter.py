"""Plan 12 — native SAM 3.1 image predictor unit tests.

Stubs the ``sam3`` package so the broader test suite stays torch /
transformers-free unless ``SAM3P1_AVAILABLE=1``. Exercises:

- adapter ``set_image`` caches state + original_size
- adapter ``predict`` routes points / box / both into ``predict_inst``
- adapter ``predict`` raises before ``set_image``
- text predictor returns RLE + polygon dicts sorted by score
- box predictor handles a single positive box

Verified state-key contract (from Plan 12 native probe inside the
model container): post-``set_text_prompt`` state has keys
``masks_logits``, ``masks``, ``boxes``, ``scores``, ``geometric_prompt``,
``backbone_out``, ``original_height``, ``original_width``. ``masks`` is
shape ``(N, 1, H, W)`` dtype=bool; ``scores`` is shape ``(N,)``.
"""

from __future__ import annotations

import base64
import io
import sys
import types
from types import ModuleType, SimpleNamespace

import numpy as np
import pytest


# --- torch stub (perf.py imports torch at module load) ----------------------


@pytest.fixture(autouse=True)
def _fake_torch(monkeypatch):
    """Inject a minimal ``torch`` stub so ``carve_model.sam.perf`` imports
    cleanly in the dev venv (no torch installed). Mirrors the fixture used
    by ``test_sam3p1_adapter.py``.
    """
    if "torch" in sys.modules:
        # Real torch is available — leave it alone.
        return
    fake = ModuleType("torch")
    fake.tensor = lambda data, dtype=None: np.asarray(data)
    fake.float32 = "float32"
    fake.int32 = "int32"
    fake.int64 = "int64"
    fake.dtype = type
    fake.bfloat16 = "bfloat16"
    fake.float16 = "float16"
    fake.cuda = SimpleNamespace(
        is_available=lambda: False,
        is_bf16_supported=lambda: False,
        empty_cache=lambda: None,
    )

    # v3.22 GPU-hygiene: adapters wrap inference in ``torch.no_grad()``.
    # The dev-venv stub didn't expose it; provide a no-op context
    # manager so tests that don't run on real torch still pass.
    class _NullCtx:
        def __enter__(self) -> "_NullCtx":
            return self

        def __exit__(self, *_exc) -> None:  # noqa: ANN001
            return None

    fake.no_grad = lambda: _NullCtx()
    fake.inference_mode = lambda: _NullCtx()
    monkeypatch.setitem(sys.modules, "torch", fake)


@pytest.fixture(autouse=True)
def _fake_cv2(monkeypatch):
    """Stub ``cv2`` for ``polygonize.mask_to_polygon`` in the dev venv.

    Returns a single bbox-shaped contour so the polygon list is non-empty
    and shaped like ``[[x, y], ...]``.
    """
    if "cv2" in sys.modules:
        return
    fake = ModuleType("cv2")
    fake.RETR_EXTERNAL = 0
    fake.RETR_CCOMP = 1
    fake.CHAIN_APPROX_SIMPLE = 2
    fake.CHAIN_APPROX_NONE = 3

    def _find_contours(mask, mode, method):
        ys, xs = np.where(mask > 0)
        if len(xs) == 0:
            return [], None
        x0, x1 = int(xs.min()), int(xs.max())
        y0, y1 = int(ys.min()), int(ys.max())
        contour = np.array(
            [[[x0, y0]], [[x1, y0]], [[x1, y1]], [[x0, y1]]], dtype=np.int32,
        )
        return [contour], None

    def _arc_length(contour, closed):
        return 16.0

    def _approx_poly_dp(contour, epsilon, closed):
        return contour

    def _contour_area(contour):
        pts = np.asarray(contour).reshape(-1, 2)
        if len(pts) < 3:
            return 0.0
        x = pts[:, 0]
        y = pts[:, 1]
        return float(0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))

    fake.findContours = _find_contours
    fake.arcLength = _arc_length
    fake.approxPolyDP = _approx_poly_dp
    fake.contourArea = _contour_area
    monkeypatch.setitem(sys.modules, "cv2", fake)


# --- stub -------------------------------------------------------------------


def _install_sam3_stub(monkeypatch):
    """Inject a fake ``sam3`` module so the adapter imports succeed.

    Returns the call log so tests can assert ordering and arg shapes.
    """
    fake_sam3 = types.ModuleType("sam3")
    fake_sam3.__file__ = "/tmp/sam3/__init__.py"

    calls: list = []

    def fake_build_sam3_image_model(**kwargs):
        calls.append(("build", kwargs))
        m = types.SimpleNamespace()

        def predict_inst(
            state,
            point_coords=None,
            point_labels=None,
            box=None,
            mask_input=None,
            multimask_output=True,
        ):
            calls.append((
                "predict_inst",
                {
                    "point_coords": (
                        None if point_coords is None else np.asarray(point_coords).tolist()
                    ),
                    "point_labels": (
                        None if point_labels is None else np.asarray(point_labels).tolist()
                    ),
                    "box": None if box is None else np.asarray(box).tolist(),
                    "multimask_output": multimask_output,
                },
            ))
            k = 3 if multimask_output else 1
            masks = np.zeros((k, 8, 8), dtype=np.uint8)
            masks[:, 2:6, 2:6] = 1
            scores = np.array([0.9, 0.8, 0.7][:k], dtype=np.float32)
            logits = np.zeros((k, 8, 8), dtype=np.float32)
            return masks, scores, logits

        m.predict_inst = predict_inst
        return m

    fake_sam3.build_sam3_image_model = fake_build_sam3_image_model

    fake_model_pkg = types.ModuleType("sam3.model")
    fake_processor_module = types.ModuleType("sam3.model.sam3_image_processor")

    class FakeProcessor:
        def __init__(self, model):
            self._model = model
            calls.append(("Processor.__init__", id(model)))

        def set_image(self, image, state=None):
            calls.append(("set_image", getattr(image, "size", None)))
            return {
                "original_height": (
                    image.size[1] if hasattr(image, "size") else None
                ),
                "original_width": (
                    image.size[0] if hasattr(image, "size") else None
                ),
                "backbone_out": {"vision_features": "fake"},
            }

        def set_text_prompt(self, prompt, state):
            calls.append(("set_text_prompt", prompt))
            # Mimic native shape: (N, 1, H, W) bool masks tensor.
            n, h, w = 2, 8, 8
            arr = np.zeros((n, 1, h, w), dtype=bool)
            arr[0, 0, 1:4, 1:4] = True
            arr[1, 0, 4:7, 4:7] = True
            state["masks"] = arr
            state["scores"] = np.array([0.85, 0.92], dtype=np.float32)
            state["boxes"] = np.array(
                [[1, 1, 4, 4], [4, 4, 7, 7]], dtype=np.float32,
            )
            state["masks_logits"] = arr.astype(np.float32)

        def reset_all_prompts(self, state):
            for k in ("masks", "scores", "boxes", "masks_logits", "geometric_prompt"):
                state.pop(k, None)

        def set_confidence_threshold(self, threshold, state=None):
            pass

    fake_processor_module.Sam3Processor = FakeProcessor

    monkeypatch.setitem(sys.modules, "sam3", fake_sam3)
    monkeypatch.setitem(sys.modules, "sam3.model", fake_model_pkg)
    monkeypatch.setitem(
        sys.modules, "sam3.model.sam3_image_processor", fake_processor_module,
    )
    return calls


def _png_b64_8x8() -> str:
    from PIL import Image

    img = np.zeros((8, 8, 3), dtype=np.uint8)
    img[2:6, 2:6] = 255
    pil = Image.fromarray(img)
    buf = io.BytesIO()
    pil.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


@pytest.fixture(autouse=True)
def _reset_module_cache():
    """Each test starts with a fresh native predictor cache."""
    try:
        from carve_model.sam import sam3p1_adapter

        sam3p1_adapter._set_native_image_predictor_for_tests(None)
    except Exception:  # noqa: BLE001
        pass
    yield
    try:
        from carve_model.sam import sam3p1_adapter

        sam3p1_adapter._set_native_image_predictor_for_tests(None)
    except Exception:  # noqa: BLE001
        pass


# --- tests: image adapter ---------------------------------------------------


def test_image_adapter_set_image_caches_state_and_size(monkeypatch):
    _install_sam3_stub(monkeypatch)
    from carve_model.sam.sam3p1_adapter import build_sam3p1_image_predictor

    adapter = build_sam3p1_image_predictor(device="cpu")
    img = np.zeros((480, 640, 3), dtype=np.uint8)
    adapter.set_image(img)

    assert adapter._original_size == (480, 640)
    assert isinstance(adapter._state, dict)
    assert adapter._state["original_height"] == 480
    assert adapter._state["original_width"] == 640


def test_image_adapter_predict_with_points(monkeypatch):
    calls = _install_sam3_stub(monkeypatch)
    from carve_model.sam.sam3p1_adapter import build_sam3p1_image_predictor

    adapter = build_sam3p1_image_predictor(device="cpu")
    img = np.zeros((8, 8, 3), dtype=np.uint8)
    adapter.set_image(img)

    masks, scores, _ = adapter.predict(
        point_coords=[[3.0, 3.0]],
        point_labels=[1],
        multimask_output=True,
    )
    assert masks.shape == (3, 8, 8)
    assert scores.shape == (3,)

    pi = next(c for c in calls if c[0] == "predict_inst")
    assert pi[1]["point_coords"] == [[3.0, 3.0]]
    assert pi[1]["point_labels"] == [1]
    assert pi[1]["box"] is None
    assert pi[1]["multimask_output"] is True


def test_image_adapter_predict_with_box_only(monkeypatch):
    calls = _install_sam3_stub(monkeypatch)
    from carve_model.sam.sam3p1_adapter import build_sam3p1_image_predictor

    adapter = build_sam3p1_image_predictor(device="cpu")
    adapter.set_image(np.zeros((8, 8, 3), dtype=np.uint8))

    masks, scores, _ = adapter.predict(
        point_coords=None,
        point_labels=None,
        multimask_output=False,
        box=[1.0, 1.0, 5.0, 5.0],
    )
    assert masks.shape == (1, 8, 8)

    pi = next(c for c in calls if c[0] == "predict_inst")
    assert pi[1]["box"] == [1.0, 1.0, 5.0, 5.0]
    assert pi[1]["point_coords"] is None
    assert pi[1]["multimask_output"] is False


def test_image_adapter_predict_with_points_and_box(monkeypatch):
    calls = _install_sam3_stub(monkeypatch)
    from carve_model.sam.sam3p1_adapter import build_sam3p1_image_predictor

    adapter = build_sam3p1_image_predictor(device="cpu")
    adapter.set_image(np.zeros((8, 8, 3), dtype=np.uint8))

    adapter.predict(
        point_coords=[[3.0, 4.0]],
        point_labels=[1],
        multimask_output=True,
        box=[0.0, 0.0, 7.0, 7.0],
    )
    pi = next(c for c in calls if c[0] == "predict_inst")
    assert pi[1]["point_coords"] == [[3.0, 4.0]]
    assert pi[1]["box"] == [0.0, 0.0, 7.0, 7.0]


def test_image_adapter_predict_before_set_image_raises(monkeypatch):
    _install_sam3_stub(monkeypatch)
    from carve_model.sam.sam3p1_adapter import build_sam3p1_image_predictor

    adapter = build_sam3p1_image_predictor(device="cpu")
    with pytest.raises(RuntimeError, match="set_image must be called"):
        adapter.predict([[1.0, 1.0]], [1])


def test_image_adapter_extract_embedding_returns_none(monkeypatch):
    _install_sam3_stub(monkeypatch)
    from carve_model.sam.sam3p1_adapter import build_sam3p1_image_predictor

    adapter = build_sam3p1_image_predictor(device="cpu")
    assert adapter.extract_embedding() is None


# --- tests: text predictor --------------------------------------------------


def test_text_predictor_returns_sorted_rle_polygon(monkeypatch):
    _install_sam3_stub(monkeypatch)
    from carve_model.sam.sam3p1_adapter import make_sam3p1_text_predictor

    fn = make_sam3p1_text_predictor()
    rows = fn(image_b64=_png_b64_8x8(), text="square")
    assert isinstance(rows, list)
    assert len(rows) == 2
    # Sorted score desc.
    assert rows[0]["score"] >= rows[1]["score"]
    for row in rows:
        assert set(row.keys()) >= {"counts", "size", "score", "polygon", "bbox"}
        assert isinstance(row["counts"], str) and row["counts"]
        assert row["size"] == [8, 8]
        assert isinstance(row["polygon"], list)
        assert len(row["bbox"]) == 4


# --- tests: box predictor ---------------------------------------------------


def test_box_predictor_single_positive(monkeypatch):
    calls = _install_sam3_stub(monkeypatch)
    from carve_model.sam.sam3p1_adapter import make_sam3p1_box_predictor

    fn = make_sam3p1_box_predictor()
    rows = fn(
        image_b64=_png_b64_8x8(),
        boxes=[[1.0, 1.0, 5.0, 5.0]],
        box_labels=[1],
    )
    assert len(rows) == 1
    row = rows[0]
    assert set(row.keys()) >= {"counts", "size", "score", "polygon", "bbox"}
    assert row["bbox"] == [1.0, 1.0, 5.0, 5.0]

    # Confirm we used multimask_output=False for the box prompt.
    pi_calls = [c for c in calls if c[0] == "predict_inst"]
    assert pi_calls and pi_calls[0][1]["multimask_output"] is False


def test_box_predictor_negative_subtracts_from_positive(monkeypatch):
    _install_sam3_stub(monkeypatch)
    from carve_model.sam.sam3p1_adapter import make_sam3p1_box_predictor

    fn = make_sam3p1_box_predictor()
    rows = fn(
        image_b64=_png_b64_8x8(),
        boxes=[[1.0, 1.0, 5.0, 5.0], [2.0, 2.0, 4.0, 4.0]],
        box_labels=[1, 0],
    )
    # Positive remains; the negative just modifies its mask.
    assert len(rows) == 1


# --- integration smoke (skipped unless real native sam3 is installed) -------


@pytest.mark.integration
def test_native_image_predictor_smoke():
    import os

    if os.environ.get("SAM3P1_AVAILABLE", "0") != "1":
        pytest.skip("SAM3P1_AVAILABLE!=1")
    pytest.importorskip("sam3")

    from carve_model.sam.sam3p1_adapter import build_sam3p1_image_predictor

    adapter = build_sam3p1_image_predictor()
    img = np.zeros((64, 64, 3), dtype=np.uint8)
    img[16:48, 16:48] = 200
    adapter.set_image(img)
    masks, scores, _ = adapter.predict(
        point_coords=[[32.0, 32.0]],
        point_labels=[1],
        multimask_output=True,
    )
    assert masks.shape[0] >= 1
    assert masks.shape[-2:] == (64, 64)
    assert scores.shape[0] == masks.shape[0]
