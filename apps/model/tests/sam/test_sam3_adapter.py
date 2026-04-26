"""Tests for the SAM 3 adapters that wrap transformers' Sam3Model and
Sam3VideoModel in the SamPredictor and TrackerProtocol contracts the rest
of the codebase already speaks.

The real SAM 3 model is gated on Hugging Face and is not loaded here. We
stub torch + transformers + PIL via ``sys.modules`` so adapter logic can
run without GPUs or network access — mirrors the ``fake_sam2_modules``
pattern used in test_predictor_resolver.py and test_tracker_resolver.py.
"""

import sys
from contextlib import nullcontext
from types import ModuleType, SimpleNamespace
from typing import Any

import numpy as np
import pytest

from vaa_model.sam import sam3_adapter as a_mod


# --- shared fakes -----------------------------------------------------------


class _FakeTensor:
    """Minimal duck-typed tensor that supports the ops adapters call.

    Supports: indexing (``t[i]``), ``__len__``, ``.cpu()``, ``.numpy()``,
    ``.item()``, ``.argmax()``. ``cpu()`` is a no-op identity, and
    ``numpy()`` returns the underlying numpy array.
    """

    def __init__(self, arr: np.ndarray) -> None:
        self._arr = arr

    def cpu(self) -> "_FakeTensor":
        return self

    def numpy(self) -> np.ndarray:
        return self._arr

    def __len__(self) -> int:
        return len(self._arr)

    def __getitem__(self, idx: int) -> "_FakeTensor":
        return _FakeTensor(self._arr[idx])

    def item(self) -> Any:
        return self._arr.item() if self._arr.size == 1 else self._arr.tolist()

    def argmax(self) -> "_FakeTensor":
        return _FakeTensor(np.array(int(np.argmax(self._arr))))

    def tolist(self) -> Any:
        return self._arr.tolist()


class _FakeBatch(dict):
    """Mock processor output that supports .to(device) and .get(key, default)."""

    def __init__(self, data: dict) -> None:
        super().__init__(data)

    def to(self, _device: Any) -> "_FakeBatch":
        return self


def _install_torch(monkeypatch) -> None:
    """Install a minimal torch shim into ``sys.modules``."""
    fake_torch = ModuleType("torch")
    fake_torch.no_grad = lambda: nullcontext()
    fake_torch.bfloat16 = "bfloat16"
    fake_torch.float32 = "float32"
    fake_torch.bool = bool
    fake_torch.cuda = SimpleNamespace(is_available=lambda: False)

    def _zeros(shape, dtype=None):
        return _FakeTensor(np.zeros(shape, dtype=np.uint8))

    def _tensor(values, dtype=None):
        return _FakeTensor(np.array(values))

    fake_torch.zeros = _zeros
    fake_torch.tensor = _tensor
    monkeypatch.setitem(sys.modules, "torch", fake_torch)


def _install_pil(monkeypatch) -> None:
    """Install a minimal PIL shim — fromarray returns a sentinel."""
    fake_pil_image = ModuleType("PIL.Image")
    fake_pil_image.fromarray = lambda arr: SimpleNamespace(_pil_marker=True, _arr=arr)
    fake_pil_image.open = lambda buf: SimpleNamespace(
        _pil_marker=True,
        convert=lambda mode: SimpleNamespace(_pil_marker=True, size=(16, 16)),
    )
    fake_pil_pkg = ModuleType("PIL")
    fake_pil_pkg.Image = fake_pil_image
    monkeypatch.setitem(sys.modules, "PIL", fake_pil_pkg)
    monkeypatch.setitem(sys.modules, "PIL.Image", fake_pil_image)


# --- image adapter fixtures -------------------------------------------------


@pytest.fixture
def fake_sam3_image_modules(monkeypatch):
    """Stand in for transformers Sam3Model + Sam3Processor."""
    _install_torch(monkeypatch)
    _install_pil(monkeypatch)

    captured: dict[str, Any] = {"calls": []}

    class _FakeProcessor:
        def __call__(
            self,
            *,
            images=None,
            text=None,
            input_points=None,
            input_labels=None,
            input_boxes=None,
            input_boxes_labels=None,
            return_tensors=None,
        ) -> _FakeBatch:
            captured["calls"].append({
                "images": images,
                "text": text,
                "input_points": input_points,
                "input_labels": input_labels,
                "input_boxes": input_boxes,
                "input_boxes_labels": input_boxes_labels,
            })
            return _FakeBatch({"pixel_values": "PIX"})

        def post_process_instance_segmentation(self, outputs, **kwargs):
            captured["post_kwargs"] = kwargs
            return [outputs.processed_result]

    class _FakeModel:
        def __call__(self, **kwargs) -> SimpleNamespace:
            captured["model_kwargs"] = kwargs
            return SimpleNamespace(processed_result={
                "masks": _FakeTensor(np.array([
                    [[1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
                    [[0, 1, 1, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
                ], dtype=np.uint8)),
                "scores": _FakeTensor(np.array([0.92, 0.41])),
                "boxes": _FakeTensor(np.array([[0.0, 0.0, 1.0, 1.0], [1.0, 0.0, 3.0, 1.0]])),
            })

        def get_vision_features(self, pixel_values=None) -> str:
            captured["get_vision_features_pixel_values"] = pixel_values
            return "VISION-EMB"

    return captured, _FakeModel, _FakeProcessor


# --- video adapter fixtures -------------------------------------------------


@pytest.fixture
def fake_sam3_video_modules(monkeypatch):
    """Stand in for transformers Sam3VideoModel + Sam3VideoProcessor."""
    _install_torch(monkeypatch)

    captured: dict[str, Any] = {"text_prompts": []}

    class _FakeVideoProcessor:
        def init_video_session(self, **kwargs):
            captured["init_kwargs"] = kwargs
            return SimpleNamespace(_session=True)

        def add_text_prompt(self, *, inference_session, text):
            captured["text_prompts"].append(text)
            return inference_session

        def postprocess_outputs(self, session, outputs):
            captured["postprocess_called"] = True
            return outputs.processed

    class _FakeVideoModel:
        def __init__(self) -> None:
            self._frames = [
                SimpleNamespace(
                    frame_idx=0,
                    processed={
                        "masks": _FakeTensor(np.array([
                            [[1, 0], [0, 0]],
                            [[0, 1], [0, 0]],
                        ], dtype=np.uint8)),
                        "scores": _FakeTensor(np.array([0.7, 0.3])),
                    },
                ),
                SimpleNamespace(
                    frame_idx=1,
                    processed={
                        "masks": _FakeTensor(np.array([
                            [[0, 0], [1, 1]],
                        ], dtype=np.uint8)),
                        "scores": _FakeTensor(np.array([0.95])),
                    },
                ),
            ]

        def propagate_in_video_iterator(self, **kwargs):
            captured["propagate_kwargs"] = kwargs
            yield from self._frames

    # Stub transformers.video_utils.load_video
    fake_video_utils = ModuleType("transformers.video_utils")
    fake_video_utils.load_video = lambda url: ([f"frame{i}" for i in range(2)], None)
    monkeypatch.setitem(sys.modules, "transformers.video_utils", fake_video_utils)

    return captured, _FakeVideoModel, _FakeVideoProcessor


# --- image adapter tests ----------------------------------------------------


def test_image_adapter_set_image_caches_original_size(fake_sam3_image_modules):
    _, FakeModel, FakeProcessor = fake_sam3_image_modules
    adapter = a_mod.Sam3ImagePredictorAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )
    img = np.zeros((10, 20, 3), dtype=np.uint8)

    adapter.set_image(img)

    assert adapter._original_size == (10, 20)
    assert adapter._pixel_values == "PIX"


def test_image_adapter_set_image_populates_features(fake_sam3_image_modules):
    """``extract_embedding(adapter)`` looks at ``_features['image_embed']`` —
    set_image must populate it from the model's get_vision_features."""
    _, FakeModel, FakeProcessor = fake_sam3_image_modules
    adapter = a_mod.Sam3ImagePredictorAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )

    adapter.set_image(np.zeros((4, 4, 3), dtype=np.uint8))

    assert adapter._features is not None
    assert adapter._features["image_embed"] == "VISION-EMB"


def test_image_adapter_predict_passes_points_and_labels_to_processor(
    fake_sam3_image_modules,
):
    captured, FakeModel, FakeProcessor = fake_sam3_image_modules
    adapter = a_mod.Sam3ImagePredictorAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )
    adapter.set_image(np.zeros((4, 4, 3), dtype=np.uint8))

    adapter.predict(
        point_coords=np.array([[1, 2], [3, 4]]),
        point_labels=np.array([1, 0]),
    )

    # The last processor call should be the predict-time one with points
    predict_call = captured["calls"][-1]
    assert predict_call["input_points"] == [[[[1.0, 2.0], [3.0, 4.0]]]]
    assert predict_call["input_labels"] == [[[1, 0]]]


def test_image_adapter_predict_returns_masks_and_scores(fake_sam3_image_modules):
    _, FakeModel, FakeProcessor = fake_sam3_image_modules
    adapter = a_mod.Sam3ImagePredictorAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )
    adapter.set_image(np.zeros((4, 4, 3), dtype=np.uint8))

    masks, scores, _ = adapter.predict(
        point_coords=np.array([[1, 2]]),
        point_labels=np.array([1]),
    )

    # Shape: 2 masks of 4x4 (matches the fake post_process result above)
    assert len(masks) == 2
    assert len(scores) == 2


def test_image_adapter_predict_without_set_image_raises(fake_sam3_image_modules):
    _, FakeModel, FakeProcessor = fake_sam3_image_modules
    adapter = a_mod.Sam3ImagePredictorAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )

    with pytest.raises(RuntimeError, match="set_image must be called"):
        adapter.predict(point_coords=[[0, 0]], point_labels=[1])


def test_image_adapter_predict_returns_empty_zero_mask_when_no_detections(
    monkeypatch, fake_sam3_image_modules,
):
    """When the model finds nothing, return a single zero mask + zero score
    so the existing /sam/decode router emits a benign empty RLE."""
    captured, FakeModel, FakeProcessor = fake_sam3_image_modules

    # Override the model to return zero detections
    class _EmptyModel(FakeModel):
        def __call__(self, **kwargs):
            return SimpleNamespace(processed_result={
                "masks": _FakeTensor(np.zeros((0, 4, 4), dtype=np.uint8)),
                "scores": _FakeTensor(np.array([], dtype=np.float32)),
                "boxes": _FakeTensor(np.zeros((0, 4))),
            })

    adapter = a_mod.Sam3ImagePredictorAdapter(
        model=_EmptyModel(), processor=FakeProcessor(), device="cpu",
    )
    adapter.set_image(np.zeros((4, 4, 3), dtype=np.uint8))

    masks, scores, _ = adapter.predict(
        point_coords=np.array([[0, 0]]), point_labels=np.array([1]),
    )

    # Should yield exactly one zero mask of the original size
    assert len(masks) == 1
    assert len(scores) == 1


def test_build_sam3_image_predictor_calls_from_pretrained_with_facebook_sam3(monkeypatch):
    _install_torch(monkeypatch)

    captured: dict[str, Any] = {}

    class _M:
        @classmethod
        def from_pretrained(cls, repo: str):
            captured["model_repo"] = repo
            return SimpleNamespace(to=lambda dev, dtype=None: cls())

    class _P:
        @classmethod
        def from_pretrained(cls, repo: str):
            captured["proc_repo"] = repo
            return cls()

    fake_transformers = ModuleType("transformers")
    fake_transformers.Sam3Model = _M
    fake_transformers.Sam3Processor = _P
    monkeypatch.setitem(sys.modules, "transformers", fake_transformers)

    a_mod.build_sam3_image_predictor(device="cpu")

    assert captured["model_repo"] == "facebook/sam3"
    assert captured["proc_repo"] == "facebook/sam3"


# --- video adapter tests ----------------------------------------------------


def test_video_adapter_init_state_calls_init_video_session(fake_sam3_video_modules):
    captured, FakeVM, FakeVP = fake_sam3_video_modules
    adapter = a_mod.Sam3VideoTrackerAdapter(
        model=FakeVM(), processor=FakeVP(), device="cpu",
    )

    state = adapter.init_state("https://fake/v.mp4")

    assert state is not None
    assert "video" in captured["init_kwargs"]


def test_video_adapter_add_new_points_routes_string_lists_to_add_text_prompt(
    fake_sam3_video_modules,
):
    captured, FakeVM, FakeVP = fake_sam3_video_modules
    adapter = a_mod.Sam3VideoTrackerAdapter(
        model=FakeVM(), processor=FakeVP(), device="cpu",
    )
    state = adapter.init_state("https://fake/v.mp4")

    adapter.add_new_points(state, frame_idx=0, points=["person"], labels=[])

    assert captured["text_prompts"] == ["person"]


def test_video_adapter_add_new_points_accepts_single_string(fake_sam3_video_modules):
    captured, FakeVM, FakeVP = fake_sam3_video_modules
    adapter = a_mod.Sam3VideoTrackerAdapter(
        model=FakeVM(), processor=FakeVP(), device="cpu",
    )
    state = adapter.init_state("https://fake/v.mp4")

    adapter.add_new_points(state, frame_idx=0, points="cat", labels=[])

    assert captured["text_prompts"] == ["cat"]


def test_video_adapter_add_new_points_rejects_numeric_points(fake_sam3_video_modules):
    """SAM 3 video tracking is text-based. Numeric points must be rejected
    with a clear error so callers don't silently get unexpected behavior."""
    _, FakeVM, FakeVP = fake_sam3_video_modules
    adapter = a_mod.Sam3VideoTrackerAdapter(
        model=FakeVM(), processor=FakeVP(), device="cpu",
    )
    state = adapter.init_state("https://fake/v.mp4")

    with pytest.raises(RuntimeError, match=r"text prompts.*numeric"):
        adapter.add_new_points(state, frame_idx=0, points=[[10, 20]], labels=[1])


def test_video_adapter_add_new_points_rejects_empty(fake_sam3_video_modules):
    _, FakeVM, FakeVP = fake_sam3_video_modules
    adapter = a_mod.Sam3VideoTrackerAdapter(
        model=FakeVM(), processor=FakeVP(), device="cpu",
    )
    state = adapter.init_state("https://fake/v.mp4")

    with pytest.raises(RuntimeError, match="requires text prompt"):
        adapter.add_new_points(state, frame_idx=0, points=[], labels=[])


def test_video_adapter_propagate_yields_frame_idx_and_mask(fake_sam3_video_modules):
    _, FakeVM, FakeVP = fake_sam3_video_modules
    adapter = a_mod.Sam3VideoTrackerAdapter(
        model=FakeVM(), processor=FakeVP(), device="cpu",
    )
    state = adapter.init_state("https://fake/v.mp4")

    out = list(adapter.propagate_in_video(state))

    # Two frames in the fake (frame_idx 0 and 1)
    assert len(out) == 2
    assert out[0][0] == 0
    assert out[1][0] == 1
    # Each yielded mask should be a 2-D numpy array
    for _frame_idx, mask in out:
        assert isinstance(mask, np.ndarray)


def test_build_sam3_video_tracker_calls_from_pretrained_with_facebook_sam3(monkeypatch):
    _install_torch(monkeypatch)

    captured: dict[str, Any] = {}

    class _VM:
        @classmethod
        def from_pretrained(cls, repo: str):
            captured["model_repo"] = repo
            return SimpleNamespace(to=lambda dev, dtype=None: cls())

    class _VP:
        @classmethod
        def from_pretrained(cls, repo: str):
            captured["proc_repo"] = repo
            return cls()

    fake_transformers = ModuleType("transformers")
    fake_transformers.Sam3VideoModel = _VM
    fake_transformers.Sam3VideoProcessor = _VP
    monkeypatch.setitem(sys.modules, "transformers", fake_transformers)

    a_mod.build_sam3_video_tracker(device="cpu")

    assert captured["model_repo"] == "facebook/sam3"
    assert captured["proc_repo"] == "facebook/sam3"
