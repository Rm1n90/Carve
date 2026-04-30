"""Tests for the SAM 2 transformers adapter (commit 3 of v3.4 migration).

Mirrors the structure of ``test_sam3_adapter.py``: torch + transformers + PIL
are stubbed via ``sys.modules`` so the adapter logic can be exercised without
GPUs or network access. The real ``transformers.Sam2Model`` /
``Sam2VideoModel`` classes are not loaded here.

These tests guard the contract that the rest of the codebase depends on:

- ``Sam2ImagePredictorAdapter._features["image_embed"]`` is populated by
  ``set_image()`` so ``carve_model.sam.predictor.extract_embedding`` can
  emit float16 bytes for the browser ONNX decoder.
- ``build_sam2_image_predictor("sam2.1-tiny")`` resolves to the canonical
  HuggingFace repo id ``facebook/sam2.1-hiera-tiny``.
- ``build_sam2_video_tracker(...)`` constructs ``Sam2VideoModel`` +
  ``Sam2VideoProcessor`` from the right HF repo.
"""

import sys
from contextlib import nullcontext
from types import ModuleType, SimpleNamespace
from typing import Any

import numpy as np
import pytest

from carve_model.sam import sam2_adapter as a_mod


# --- shared fakes -----------------------------------------------------------


class _FakeTensor:
    """Minimal duck-typed tensor. Supports indexing, ``__len__``, ``cpu``,
    ``numpy``, ``ndim``, ``shape``, ``flatten``, ``item``."""

    def __init__(self, arr: np.ndarray) -> None:
        self._arr = np.asarray(arr)

    def cpu(self) -> "_FakeTensor":
        return self

    def numpy(self) -> np.ndarray:
        return self._arr

    def __len__(self) -> int:
        return len(self._arr)

    def __getitem__(self, idx) -> "_FakeTensor":
        return _FakeTensor(self._arr[idx])

    def item(self) -> Any:
        return self._arr.item() if self._arr.size == 1 else self._arr.tolist()

    def flatten(self) -> "_FakeTensor":
        return _FakeTensor(self._arr.flatten())

    def astype(self, dtype) -> np.ndarray:
        return self._arr.astype(dtype)

    @property
    def shape(self) -> tuple:
        return tuple(self._arr.shape)

    @property
    def ndim(self) -> int:
        return int(self._arr.ndim)


class _FakeBatch(dict):
    """Mock processor output — supports .to(device) and attribute-style access."""

    def to(self, _device: Any) -> "_FakeBatch":
        return self

    def __getattr__(self, name: str) -> Any:
        if name in self:
            return self[name]
        raise AttributeError(name)


def _install_torch(monkeypatch) -> None:
    """Install a minimal torch shim into ``sys.modules``."""
    fake_torch = ModuleType("torch")
    fake_torch.no_grad = lambda: nullcontext()
    fake_torch.bfloat16 = "bfloat16"
    fake_torch.float32 = "float32"
    fake_torch.bool = bool
    fake_torch.cuda = SimpleNamespace(
        is_available=lambda: False,
        is_bf16_supported=lambda: False,
    )

    def _zeros(shape, dtype=None):
        return _FakeTensor(np.zeros(shape, dtype=np.uint8))

    def _ones(shape, dtype=None):
        return _FakeTensor(np.ones(shape, dtype=np.float32))

    fake_torch.zeros = _zeros
    fake_torch.ones = _ones
    monkeypatch.setitem(sys.modules, "torch", fake_torch)


def _install_pil(monkeypatch) -> None:
    """Install a minimal PIL shim — fromarray returns a sentinel."""
    fake_pil_image = ModuleType("PIL.Image")
    fake_pil_image.fromarray = lambda arr: SimpleNamespace(_pil_marker=True, _arr=arr)
    fake_pil_pkg = ModuleType("PIL")
    fake_pil_pkg.Image = fake_pil_image
    monkeypatch.setitem(sys.modules, "PIL", fake_pil_pkg)
    monkeypatch.setitem(sys.modules, "PIL.Image", fake_pil_image)


# --- image adapter fixtures ------------------------------------------------


@pytest.fixture
def fake_sam2_image_modules(monkeypatch):
    """Stand in for transformers Sam2Model + Sam2Processor.

    The model returns ``outputs.pred_masks`` shape
    ``[batch=1, num_obj=1, K=3, H, W]`` plus an ``iou_scores`` tensor.
    ``processor.post_process_masks`` flattens to a per-image list of
    masks shaped ``[num_obj=1, K=3, H, W]``.
    """
    _install_torch(monkeypatch)
    _install_pil(monkeypatch)

    captured: dict[str, Any] = {"calls": []}

    class _FakeProcessor:
        def __call__(
            self,
            *,
            images=None,
            input_points=None,
            input_labels=None,
            input_boxes=None,
            return_tensors=None,
        ) -> _FakeBatch:
            captured["calls"].append({
                "images": images,
                "input_points": input_points,
                "input_labels": input_labels,
                "input_boxes": input_boxes,
            })
            return _FakeBatch({
                "pixel_values": "PIX",
                "original_sizes": [[4, 4]],
            })

        def post_process_masks(self, masks_input, original_sizes, **_kwargs):
            captured["post_process_called"] = True
            captured["post_process_original_sizes"] = original_sizes
            t = masks_input
            if hasattr(t, "_arr"):
                arr = t._arr
            elif hasattr(t, "numpy"):
                arr = t.numpy()
            else:
                arr = np.asarray(t)
            if arr.ndim == 5:
                arr = arr[0]
            return [_FakeTensor(arr)]

    class _FakeModel:
        def __call__(self, **kwargs) -> SimpleNamespace:
            captured["model_kwargs"] = kwargs
            pred_masks = np.zeros((1, 1, 3, 4, 4), dtype=np.uint8)
            pred_masks[0, 0, 0, 0, 0] = 1
            pred_masks[0, 0, 1, 0, :2] = 1
            pred_masks[0, 0, 2, :2, :2] = 1
            iou_scores = np.array([[[0.42, 0.91, 0.73]]], dtype=np.float32)
            return SimpleNamespace(
                pred_masks=_FakeTensor(pred_masks),
                iou_scores=_FakeTensor(iou_scores),
            )

        def get_image_embeddings(self, pixel_values=None) -> str:
            captured["get_image_embeddings_pixel_values"] = pixel_values
            return "VISION-EMB"

    return captured, _FakeModel, _FakeProcessor


# --- video tracker fixtures -------------------------------------------------


@pytest.fixture
def fake_sam2_video_modules(monkeypatch):
    """Stand in for transformers Sam2VideoModel + Sam2VideoProcessor."""
    _install_torch(monkeypatch)

    captured: dict[str, Any] = {
        "added_inputs": [],
        "init_video_calls": [],
    }

    class _FakeVideoProcessor:
        def init_video_session(self, **kwargs):
            captured["init_video_calls"].append(kwargs)
            return SimpleNamespace(
                _session=True,
                video_height=2,
                video_width=2,
            )

        def add_inputs_to_inference_session(
            self,
            *,
            inference_session,
            frame_idx,
            obj_ids,
            input_points=None,
            input_labels=None,
            input_boxes=None,
        ):
            captured["added_inputs"].append({
                "frame_idx": frame_idx,
                "obj_ids": obj_ids,
                "input_points": input_points,
                "input_labels": input_labels,
                "input_boxes": input_boxes,
            })
            return inference_session

        def post_process_masks(self, masks, original_sizes, binarize=True):
            t = masks[0] if isinstance(masks, list) else masks
            if hasattr(t, "_arr"):
                arr = t._arr
            elif hasattr(t, "numpy"):
                arr = t.numpy()
            else:
                arr = np.asarray(t)
            return [_FakeTensor(arr)]

    class _FakeVideoModel:
        def __init__(self) -> None:
            # pred_masks shape: [num_obj=1, K=1, H=2, W=2]
            self._frames = [
                SimpleNamespace(
                    frame_idx=0,
                    obj_ids=[1],
                    pred_masks=_FakeTensor(np.array([[
                        [[1, 0], [0, 0]],
                    ]], dtype=np.uint8)),
                ),
                SimpleNamespace(
                    frame_idx=1,
                    obj_ids=[1],
                    pred_masks=_FakeTensor(np.array([[
                        [[0, 1], [0, 1]],
                    ]], dtype=np.uint8)),
                ),
            ]

        def propagate_in_video_iterator(self, _session):
            yield from self._frames

    fake_video_utils = ModuleType("transformers.video_utils")
    fake_video_utils.load_video = lambda url: ([f"frame{i}" for i in range(2)], None)
    monkeypatch.setitem(sys.modules, "transformers.video_utils", fake_video_utils)

    return captured, _FakeVideoModel, _FakeVideoProcessor


# --- image adapter tests ---------------------------------------------------


def test_image_adapter_set_image_caches_original_size(fake_sam2_image_modules):
    _, FakeModel, FakeProcessor = fake_sam2_image_modules
    adapter = a_mod.Sam2ImagePredictorAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )
    img = np.zeros((10, 20, 3), dtype=np.uint8)

    adapter.set_image(img)

    assert adapter._original_size == (10, 20)


def test_image_adapter_set_image_populates_features_image_embed(fake_sam2_image_modules):
    """Contract: extract_embedding(adapter) reads ``_features['image_embed']``;
    set_image must populate it from ``model.get_image_embeddings``."""
    _, FakeModel, FakeProcessor = fake_sam2_image_modules
    adapter = a_mod.Sam2ImagePredictorAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )

    adapter.set_image(np.zeros((4, 4, 3), dtype=np.uint8))

    assert adapter._features is not None
    assert adapter._features["image_embed"] == "VISION-EMB"


def test_image_adapter_predict_packs_points_for_processor(fake_sam2_image_modules):
    """Sam2Processor expects [batch, num_obj, num_pts, 2] for points and
    [batch, num_obj, num_pts] for labels."""
    captured, FakeModel, FakeProcessor = fake_sam2_image_modules
    adapter = a_mod.Sam2ImagePredictorAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )
    adapter.set_image(np.zeros((4, 4, 3), dtype=np.uint8))

    adapter.predict(
        point_coords=np.array([[1, 2], [3, 4]]),
        point_labels=np.array([1, 0]),
    )

    predict_call = next(c for c in captured["calls"] if c["input_points"] is not None)
    assert predict_call["input_points"] == [[[[1.0, 2.0], [3.0, 4.0]]]]
    assert predict_call["input_labels"] == [[[1, 0]]]


def test_image_adapter_predict_returns_K_masks_and_scores(fake_sam2_image_modules):
    """Predict returns shape (K, H, W) so the router's argmax over scores works."""
    _, FakeModel, FakeProcessor = fake_sam2_image_modules
    adapter = a_mod.Sam2ImagePredictorAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )
    adapter.set_image(np.zeros((4, 4, 3), dtype=np.uint8))

    masks, scores, third = adapter.predict(
        point_coords=np.array([[1, 2]]),
        point_labels=np.array([1]),
    )

    assert len(masks) == 3
    assert len(scores) == 3
    # Third return value is None — legacy SAM2ImagePredictor returned low-res
    # logits there, which the router doesn't use.
    assert third is None


def test_image_adapter_predict_without_set_image_raises(fake_sam2_image_modules):
    _, FakeModel, FakeProcessor = fake_sam2_image_modules
    adapter = a_mod.Sam2ImagePredictorAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )

    with pytest.raises(RuntimeError, match="set_image must be called"):
        adapter.predict(point_coords=[[0, 0]], point_labels=[1])


# --- build_sam2_image_predictor tests --------------------------------------


@pytest.mark.parametrize("model_name,expected_repo", [
    ("sam2.1-tiny",      "facebook/sam2.1-hiera-tiny"),
    ("sam2.1-small",     "facebook/sam2.1-hiera-small"),
    ("sam2.1-base-plus", "facebook/sam2.1-hiera-base-plus"),
    ("sam2.1-large",     "facebook/sam2.1-hiera-large"),
])
def test_build_sam2_image_predictor_resolves_hf_repo(
    monkeypatch, model_name, expected_repo,
):
    """Every SAM 2.1 size must resolve to the canonical HF repo id."""
    _install_torch(monkeypatch)

    captured: dict[str, Any] = {}

    class _M:
        @classmethod
        def from_pretrained(cls, repo: str):
            captured["model_repo"] = repo
            captured["model_class"] = cls.__name__
            return SimpleNamespace(to=lambda dev, dtype=None: cls())

    class _P:
        @classmethod
        def from_pretrained(cls, repo: str):
            captured["proc_repo"] = repo
            captured["proc_class"] = cls.__name__
            return cls()

    fake_transformers = ModuleType("transformers")
    fake_transformers.Sam2Model = type("Sam2Model", (_M,), {})
    fake_transformers.Sam2Processor = type("Sam2Processor", (_P,), {})
    monkeypatch.setitem(sys.modules, "transformers", fake_transformers)

    a_mod.build_sam2_image_predictor(model_name, device="cpu")

    assert captured["model_repo"] == expected_repo
    assert captured["proc_repo"] == expected_repo
    assert captured["model_class"] == "Sam2Model"
    assert captured["proc_class"] == "Sam2Processor"


def test_build_sam2_image_predictor_rejects_unknown_model(monkeypatch):
    _install_torch(monkeypatch)

    with pytest.raises(ValueError, match="unknown SAM 2 model"):
        a_mod.build_sam2_image_predictor("sam3", device="cpu")


# --- video tracker tests ----------------------------------------------------


def test_video_tracker_init_state_does_not_load_session(fake_sam2_video_modules):
    """init_state must NOT preload the inference session — the session is
    deferred to the first prompt arrival."""
    captured, FakeModel, FakeProcessor = fake_sam2_video_modules
    tracker = a_mod.Sam2VideoTrackerAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )

    state = tracker.init_state("https://fake/v.mp4")

    assert state["session"] is None
    assert captured["init_video_calls"] == []


def test_video_tracker_add_new_points_routes_through_add_inputs_at_frame(
    fake_sam2_video_modules,
):
    captured, FakeModel, FakeProcessor = fake_sam2_video_modules
    tracker = a_mod.Sam2VideoTrackerAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )
    state = tracker.init_state("https://fake/v.mp4")

    tracker.add_new_points(state, frame_idx=0, points=[[10, 20]], labels=[1])

    assert len(captured["added_inputs"]) == 1
    call = captured["added_inputs"][0]
    # Legacy entrypoint always uses obj_id=1
    assert call["obj_ids"] == 1
    assert call["frame_idx"] == 0
    # Single object, single point — packed [batch][num_obj][num_pts][xy]
    assert call["input_points"] == [[[[10, 20]]]]
    assert call["input_labels"] == [[[1]]]


def test_video_tracker_add_inputs_at_frame_passes_obj_id(fake_sam2_video_modules):
    captured, FakeModel, FakeProcessor = fake_sam2_video_modules
    tracker = a_mod.Sam2VideoTrackerAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )
    state = tracker.init_state("https://fake/v.mp4")

    tracker.add_inputs_at_frame(
        state,
        frame_idx=12,
        obj_id=2,
        points=[[100, 200]],
        labels=[1],
    )

    call = captured["added_inputs"][0]
    assert call["frame_idx"] == 12
    assert call["obj_ids"] == 2
    assert call["input_points"] == [[[[100, 200]]]]
    assert call["input_labels"] == [[[1]]]


def test_video_tracker_add_inputs_at_frame_with_box(fake_sam2_video_modules):
    """Box-only prompts forward as ``input_boxes`` packed [batch][num_obj][4]."""
    captured, FakeModel, FakeProcessor = fake_sam2_video_modules
    tracker = a_mod.Sam2VideoTrackerAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )
    state = tracker.init_state("https://fake/v.mp4")

    tracker.add_inputs_at_frame(
        state,
        frame_idx=0,
        obj_id=3,
        boxes=[[10.0, 20.0, 50.0, 60.0]],
    )

    call = captured["added_inputs"][0]
    assert call["obj_ids"] == 3
    assert call["input_boxes"] == [[[10.0, 20.0, 50.0, 60.0]]]


def test_video_tracker_rejects_empty_prompt(fake_sam2_video_modules):
    _, FakeModel, FakeProcessor = fake_sam2_video_modules
    tracker = a_mod.Sam2VideoTrackerAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )
    state = tracker.init_state("https://fake/v.mp4")

    with pytest.raises(RuntimeError, match="requires points or boxes"):
        tracker.add_inputs_at_frame(state, frame_idx=0, obj_id=1)


def test_video_tracker_propagate_yields_frame_idx_and_mask_dict(fake_sam2_video_modules):
    """propagate_in_video must yield ``(frame_idx, {obj_id: mask})`` per the
    v1.4 multi-object contract that the router speaks."""
    _, FakeModel, FakeProcessor = fake_sam2_video_modules
    tracker = a_mod.Sam2VideoTrackerAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )
    state = tracker.init_state("https://fake/v.mp4")
    tracker.add_inputs_at_frame(
        state, frame_idx=0, obj_id=1, points=[[1, 1]], labels=[1],
    )

    out = list(tracker.propagate_in_video(state))

    assert len(out) == 2
    assert out[0][0] == 0
    assert out[1][0] == 1
    for _frame_idx, masks_by_obj in out:
        assert isinstance(masks_by_obj, dict)
        assert 1 in masks_by_obj
        assert isinstance(masks_by_obj[1], np.ndarray)


@pytest.mark.parametrize("model_name,expected_repo", [
    ("sam2.1-tiny",      "facebook/sam2.1-hiera-tiny"),
    ("sam2.1-small",     "facebook/sam2.1-hiera-small"),
    ("sam2.1-base-plus", "facebook/sam2.1-hiera-base-plus"),
    ("sam2.1-large",     "facebook/sam2.1-hiera-large"),
])
def test_build_sam2_video_tracker_resolves_hf_repo(
    monkeypatch, model_name, expected_repo,
):
    """build_sam2_video_tracker must call Sam2VideoModel.from_pretrained
    with the canonical HF repo id for each SAM 2.1 size."""
    _install_torch(monkeypatch)

    captured: dict[str, Any] = {}

    class _M:
        @classmethod
        def from_pretrained(cls, repo: str):
            captured["model_repo"] = repo
            captured["model_class"] = cls.__name__
            return SimpleNamespace(to=lambda dev, dtype=None: cls())

    class _P:
        @classmethod
        def from_pretrained(cls, repo: str):
            captured["proc_repo"] = repo
            captured["proc_class"] = cls.__name__
            return cls()

    fake_transformers = ModuleType("transformers")
    fake_transformers.Sam2VideoModel = type("Sam2VideoModel", (_M,), {})
    fake_transformers.Sam2VideoProcessor = type("Sam2VideoProcessor", (_P,), {})
    monkeypatch.setitem(sys.modules, "transformers", fake_transformers)

    a_mod.build_sam2_video_tracker(model_name, device="cpu")

    assert captured["model_repo"] == expected_repo
    assert captured["proc_repo"] == expected_repo
    assert captured["model_class"] == "Sam2VideoModel"
    assert captured["proc_class"] == "Sam2VideoProcessor"


def test_build_sam2_video_tracker_rejects_unknown_model(monkeypatch):
    _install_torch(monkeypatch)

    with pytest.raises(ValueError, match="unknown SAM 2 model"):
        a_mod.build_sam2_video_tracker("sam3", device="cpu")
