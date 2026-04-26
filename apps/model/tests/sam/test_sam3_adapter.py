"""Tests for the SAM 3 adapters that wrap the four transformers SAM 3 model
classes in the SamPredictor and TrackerProtocol contracts the rest of the
codebase already speaks.

SAM 3 ships **four** transformers classes (model card, v5.6.x):

- ``Sam3Model`` + ``Sam3Processor``  — image concept (text + boxes, NO points)
- ``Sam3VideoModel`` + ``Sam3VideoProcessor`` — video concept (text only)
- ``Sam3TrackerModel`` + ``Sam3TrackerProcessor`` — drop-in SAM 2 image
  replacement (points + boxes + masks)
- ``Sam3TrackerVideoModel`` + ``Sam3TrackerVideoProcessor`` — drop-in SAM 2
  video replacement (points + boxes + masks at frames)

Click prompts must route to the **Tracker** classes (not the concept
classes). Text prompts continue to route to the concept classes.

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
    ``.item()``, ``.argmax()``, ``.shape``, ``.ndim``, ``.flatten()``.
    ``cpu()`` is a no-op identity, and ``numpy()`` returns the underlying
    numpy array.
    """

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

    def argmax(self) -> "_FakeTensor":
        return _FakeTensor(np.array(int(np.argmax(self._arr))))

    def tolist(self) -> Any:
        return self._arr.tolist()

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
    """Mock processor output that supports .to(device) and .get(key, default).

    Also exposes attribute-style access for ``original_sizes`` / ``pixel_values``
    since some transformers code paths read both as keys and as attributes.
    """

    def __init__(self, data: dict) -> None:
        super().__init__(data)

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
    fake_torch.cuda = SimpleNamespace(is_available=lambda: False)

    def _zeros(shape, dtype=None):
        return _FakeTensor(np.zeros(shape, dtype=np.uint8))

    def _tensor(values, dtype=None):
        return _FakeTensor(np.array(values))

    def _ones(shape, dtype=None):
        return _FakeTensor(np.ones(shape, dtype=np.float32))

    fake_torch.zeros = _zeros
    fake_torch.tensor = _tensor
    fake_torch.ones = _ones
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


# --- image adapter fixtures (Sam3TrackerModel + Sam3TrackerProcessor) -------


@pytest.fixture
def fake_sam3_tracker_image_modules(monkeypatch):
    """Stand in for transformers Sam3TrackerModel + Sam3TrackerProcessor.

    The Tracker model returns ``outputs.pred_masks`` shape
    ``[batch=1, num_obj=1, K=3, H, W]`` plus an ``iou_scores`` tensor.
    ``processor.post_process_masks(...)`` collapses pred_masks into a list
    of per-image mask tensors of shape ``[num_obj, K, H, W]``.
    """
    _install_torch(monkeypatch)
    _install_pil(monkeypatch)

    captured: dict[str, Any] = {"calls": []}

    class _FakeTrackerProcessor:
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

        def post_process_masks(self, masks_input, original_sizes, **kwargs):
            captured["post_process_called"] = True
            captured["post_process_original_sizes"] = original_sizes
            # Caller passes pred_masks shape [1, 1, K=3, H, W]; we flatten
            # to a list-per-image of shape [num_obj=1, K=3, H, W].
            t = masks_input
            if hasattr(t, "_arr"):
                arr = t._arr
            elif hasattr(t, "numpy"):
                arr = t.numpy()
            else:
                arr = np.asarray(t)
            if arr.ndim == 5:
                # [batch, num_obj, K, H, W] -> drop batch dim
                arr = arr[0]
            return [_FakeTensor(arr)]

    class _FakeTrackerModel:
        def __call__(self, **kwargs) -> SimpleNamespace:
            captured["model_kwargs"] = kwargs
            # pred_masks shape: [batch=1, num_obj=1, K=3, H=4, W=4]
            pred_masks = np.zeros((1, 1, 3, 4, 4), dtype=np.uint8)
            pred_masks[0, 0, 0, 0, 0] = 1
            pred_masks[0, 0, 1, 0, :2] = 1
            pred_masks[0, 0, 2, :2, :2] = 1
            iou_scores = np.array([[[0.42, 0.91, 0.73]]], dtype=np.float32)
            return SimpleNamespace(
                pred_masks=_FakeTensor(pred_masks),
                iou_scores=_FakeTensor(iou_scores),
            )

        def get_vision_features(self, pixel_values=None) -> str:
            captured["get_vision_features_pixel_values"] = pixel_values
            return "VISION-EMB"

    return captured, _FakeTrackerModel, _FakeTrackerProcessor


# --- box predictor fixtures (Sam3Model + Sam3Processor — concept) -----------


@pytest.fixture
def fake_sam3_concept_image_modules(monkeypatch):
    """Stand in for transformers Sam3Model + Sam3Processor (concept classes).

    Used for /sam/text-prompt and /sam/box-prompt — these stay on the
    concept classes (Sam3Model / Sam3Processor) since SAM 3 concept
    segmentation is the right backbone for text + boxes.
    """
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

    return captured, _FakeModel, _FakeProcessor


# --- video dispatcher fixtures ---------------------------------------------


@pytest.fixture
def fake_sam3_video_dispatcher_modules(monkeypatch):
    """Stand in for BOTH transformers SAM 3 video classes:

    - ``Sam3TrackerVideoModel`` + ``Sam3TrackerVideoProcessor`` (point/box)
    - ``Sam3VideoModel`` + ``Sam3VideoProcessor`` (text concept)

    The dispatcher decides which pair to use at first ``add_new_points``.
    """
    _install_torch(monkeypatch)

    captured: dict[str, Any] = {
        "tracker_added_inputs": [],
        "concept_text_prompts": [],
        "init_video_calls": [],
    }

    # -- text concept (Sam3VideoModel + Sam3VideoProcessor) ------------------
    class _FakeConceptVideoProcessor:
        def init_video_session(self, **kwargs):
            captured["init_video_calls"].append(("concept", kwargs))
            return SimpleNamespace(_session=True, mode="concept")

        def add_text_prompt(self, *, inference_session, text):
            captured["concept_text_prompts"].append(text)
            return inference_session

        def postprocess_outputs(self, session, outputs):
            return outputs.processed

    class _FakeConceptVideoModel:
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
            yield from self._frames

    # -- tracker (Sam3TrackerVideoModel + Sam3TrackerVideoProcessor) ---------
    class _FakeTrackerVideoProcessor:
        def init_video_session(self, **kwargs):
            captured["init_video_calls"].append(("tracker", kwargs))
            session = SimpleNamespace(
                _session=True,
                mode="tracker",
                video_height=2,
                video_width=2,
            )
            return session

        def add_inputs_to_inference_session(
            self,
            *,
            inference_session,
            frame_idx,
            obj_ids,
            input_points=None,
            input_labels=None,
            input_boxes=None,
            input_masks=None,
            original_size=None,
            clear_old_inputs=True,
        ):
            captured["tracker_added_inputs"].append({
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

    class _FakeTrackerVideoModel:
        def __init__(self) -> None:
            # pred_masks shape: [num_obj=1, K=1, H=2, W=2]
            self._frames = [
                SimpleNamespace(
                    frame_idx=0,
                    pred_masks=_FakeTensor(np.array([[
                        [[1, 0], [0, 0]],
                    ]], dtype=np.uint8)),
                ),
                SimpleNamespace(
                    frame_idx=1,
                    pred_masks=_FakeTensor(np.array([[
                        [[0, 1], [0, 1]],
                    ]], dtype=np.uint8)),
                ),
            ]

        def propagate_in_video_iterator(self, inference_session):
            yield from self._frames

        def __call__(self, *, inference_session, frame_idx):
            # Optional: seed-frame call before propagation.
            return SimpleNamespace(
                pred_masks=_FakeTensor(np.array([[
                    [[1, 0], [0, 0]],
                ]], dtype=np.uint8)),
            )

    # Stub transformers.video_utils.load_video used by the dispatcher.
    fake_video_utils = ModuleType("transformers.video_utils")
    fake_video_utils.load_video = lambda url: ([f"frame{i}" for i in range(2)], None)
    monkeypatch.setitem(sys.modules, "transformers.video_utils", fake_video_utils)

    return (
        captured,
        _FakeTrackerVideoModel,
        _FakeTrackerVideoProcessor,
        _FakeConceptVideoModel,
        _FakeConceptVideoProcessor,
    )


# --- image adapter tests (Sam3TrackerModel) ---------------------------------


def test_image_adapter_set_image_caches_original_size(fake_sam3_tracker_image_modules):
    _, FakeModel, FakeProcessor = fake_sam3_tracker_image_modules
    adapter = a_mod.Sam3ImagePredictorAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )
    img = np.zeros((10, 20, 3), dtype=np.uint8)

    adapter.set_image(img)

    assert adapter._original_size == (10, 20)


def test_image_adapter_set_image_populates_features(fake_sam3_tracker_image_modules):
    """``extract_embedding(adapter)`` looks at ``_features['image_embed']`` —
    set_image must populate it from the model's get_vision_features."""
    _, FakeModel, FakeProcessor = fake_sam3_tracker_image_modules
    adapter = a_mod.Sam3ImagePredictorAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )

    adapter.set_image(np.zeros((4, 4, 3), dtype=np.uint8))

    assert adapter._features is not None
    assert adapter._features["image_embed"] == "VISION-EMB"


def test_image_adapter_predict_passes_points_and_labels_to_tracker_processor(
    fake_sam3_tracker_image_modules,
):
    """Sam3TrackerProcessor expects [batch, num_obj, num_pts, 2] for points
    and [batch, num_obj, num_pts] for labels."""
    captured, FakeModel, FakeProcessor = fake_sam3_tracker_image_modules
    adapter = a_mod.Sam3ImagePredictorAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )
    adapter.set_image(np.zeros((4, 4, 3), dtype=np.uint8))

    adapter.predict(
        point_coords=np.array([[1, 2], [3, 4]]),
        point_labels=np.array([1, 0]),
    )

    # The last processor call should be the predict-time one with points
    predict_call = next(c for c in captured["calls"] if c["input_points"] is not None)
    assert predict_call["input_points"] == [[[[1.0, 2.0], [3.0, 4.0]]]]
    assert predict_call["input_labels"] == [[[1, 0]]]


def test_image_adapter_predict_returns_K_masks_and_scores(fake_sam3_tracker_image_modules):
    """Sam3TrackerModel returns K=3 multimask candidates per object;
    predict() returns shape (K, H, W) so the router can argmax pick."""
    _, FakeModel, FakeProcessor = fake_sam3_tracker_image_modules
    adapter = a_mod.Sam3ImagePredictorAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )
    adapter.set_image(np.zeros((4, 4, 3), dtype=np.uint8))

    masks, scores, _ = adapter.predict(
        point_coords=np.array([[1, 2]]),
        point_labels=np.array([1]),
    )

    # K=3 multimask candidates
    assert len(masks) == 3
    assert len(scores) == 3


def test_image_adapter_predict_without_set_image_raises(fake_sam3_tracker_image_modules):
    _, FakeModel, FakeProcessor = fake_sam3_tracker_image_modules
    adapter = a_mod.Sam3ImagePredictorAdapter(
        model=FakeModel(), processor=FakeProcessor(), device="cpu",
    )

    with pytest.raises(RuntimeError, match="set_image must be called"):
        adapter.predict(point_coords=[[0, 0]], point_labels=[1])


def test_build_sam3_image_predictor_calls_from_pretrained_with_facebook_sam3(monkeypatch):
    """The image-click builder must load Sam3TrackerModel + Sam3TrackerProcessor
    (NOT Sam3Model / Sam3Processor — those are concept classes for text/boxes)."""
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
    fake_transformers.Sam3TrackerModel = type("Sam3TrackerModel", (_M,), {})
    fake_transformers.Sam3TrackerProcessor = type("Sam3TrackerProcessor", (_P,), {})
    monkeypatch.setitem(sys.modules, "transformers", fake_transformers)

    a_mod.build_sam3_image_predictor(device="cpu")

    assert captured["model_repo"] == "facebook/sam3"
    assert captured["proc_repo"] == "facebook/sam3"
    assert captured["model_class"] == "Sam3TrackerModel"
    assert captured["proc_class"] == "Sam3TrackerProcessor"


# --- box predictor tests (still uses Sam3Model + Sam3Processor) -------------


def _stub_box_predictor_build_concept(monkeypatch, fake_concept_modules):
    """Patch ``a_mod._build_concept_image_pair`` to return the fake concept
    model + processor + device tuple. This is the helper the text and box
    predictors use to lazy-load Sam3Model + Sam3Processor."""
    _, FakeModel, FakeProcessor = fake_concept_modules

    def _fake_build():
        return FakeModel(), FakeProcessor(), "cpu"

    monkeypatch.setattr(a_mod, "_build_concept_image_pair", _fake_build)


def test_box_predictor_passes_positive_box_to_processor(
    monkeypatch, fake_sam3_concept_image_modules,
):
    captured, _, _ = fake_sam3_concept_image_modules
    _stub_box_predictor_build_concept(monkeypatch, fake_sam3_concept_image_modules)

    fn = a_mod.make_sam3_box_predictor()
    img_b64 = (
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACRXR/mAAAAFElEQVQ"
        "okWNgYGD4z0AswK4SAFXuAf8EPy+xAAAAAElFTkSuQmCC"
    )
    out = fn(image_b64=img_b64, boxes=[[1.0, 2.0, 3.0, 4.0]], box_labels=[1])

    # The model-call processor invocation should carry the boxes + labels
    predict_call = next(c for c in captured["calls"] if c["input_boxes"] is not None)
    assert predict_call["input_boxes"] == [[[1.0, 2.0, 3.0, 4.0]]]
    assert predict_call["input_boxes_labels"] == [[1]]
    # No text passed when caller omitted it
    assert predict_call["text"] is None
    # Returns shaped result list
    assert isinstance(out, list)
    assert len(out) >= 1
    for item in out:
        assert {"counts", "size", "score", "bbox"} <= set(item.keys())


def test_box_predictor_routes_negative_box_with_label_zero(
    monkeypatch, fake_sam3_concept_image_modules,
):
    captured, _, _ = fake_sam3_concept_image_modules
    _stub_box_predictor_build_concept(monkeypatch, fake_sam3_concept_image_modules)

    fn = a_mod.make_sam3_box_predictor()
    img_b64 = (
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACRXR/mAAAAFElEQVQ"
        "okWNgYGD4z0AswK4SAFXuAf8EPy+xAAAAAElFTkSuQmCC"
    )
    fn(image_b64=img_b64, boxes=[[5.0, 5.0, 9.0, 9.0]], box_labels=[0])

    predict_call = next(c for c in captured["calls"] if c["input_boxes"] is not None)
    assert predict_call["input_boxes_labels"] == [[0]]


def test_box_predictor_combines_text_with_negative_box(
    monkeypatch, fake_sam3_concept_image_modules,
):
    """SAM 3 text-concept refinement: text + a negative box that excludes a
    region. Both must reach the processor in the same call."""
    captured, _, _ = fake_sam3_concept_image_modules
    _stub_box_predictor_build_concept(monkeypatch, fake_sam3_concept_image_modules)

    fn = a_mod.make_sam3_box_predictor()
    img_b64 = (
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACRXR/mAAAAFElEQVQ"
        "okWNgYGD4z0AswK4SAFXuAf8EPy+xAAAAAElFTkSuQmCC"
    )
    fn(
        image_b64=img_b64,
        boxes=[[2.0, 2.0, 6.0, 6.0]],
        box_labels=[0],
        text="handle",
    )

    predict_call = next(c for c in captured["calls"] if c["input_boxes"] is not None)
    assert predict_call["text"] == "handle"
    assert predict_call["input_boxes"] == [[[2.0, 2.0, 6.0, 6.0]]]
    assert predict_call["input_boxes_labels"] == [[0]]


# --- video dispatcher tests -------------------------------------------------


def test_dispatcher_init_state_lazy_loads_no_models(fake_sam3_video_dispatcher_modules):
    """init_state must NOT preload either underlying model — the dispatcher
    can't know yet which prompt type the caller will use."""
    _, _, _, _, _ = fake_sam3_video_dispatcher_modules
    adapter = a_mod.Sam3VideoDispatcherAdapter(device="cpu")

    state = adapter.init_state("https://fake/v.mp4")

    assert state is not None
    # No mode chosen yet (no model loaded yet).
    assert state.get("mode") is None


def test_dispatcher_text_mode_uses_concept_model(fake_sam3_video_dispatcher_modules):
    """A text prompt (list of strings) routes to Sam3VideoModel +
    Sam3VideoProcessor.add_text_prompt."""
    captured, _, _, ConceptModel, ConceptProcessor = fake_sam3_video_dispatcher_modules
    adapter = a_mod.Sam3VideoDispatcherAdapter(device="cpu")
    # Inject the concept pair directly so we don't need to mock from_pretrained.
    adapter._concept_model = ConceptModel()  # noqa: SLF001
    adapter._concept_processor = ConceptProcessor()  # noqa: SLF001

    state = adapter.init_state("https://fake/v.mp4")
    adapter.add_new_points(state, frame_idx=0, points=["person"], labels=[])

    assert state["mode"] == "concept"
    assert captured["concept_text_prompts"] == ["person"]
    # Tracker side untouched.
    assert captured["tracker_added_inputs"] == []


def test_dispatcher_text_mode_accepts_single_string(fake_sam3_video_dispatcher_modules):
    captured, _, _, ConceptModel, ConceptProcessor = fake_sam3_video_dispatcher_modules
    adapter = a_mod.Sam3VideoDispatcherAdapter(device="cpu")
    adapter._concept_model = ConceptModel()  # noqa: SLF001
    adapter._concept_processor = ConceptProcessor()  # noqa: SLF001

    state = adapter.init_state("https://fake/v.mp4")
    adapter.add_new_points(state, frame_idx=0, points="cat", labels=[])

    assert state["mode"] == "concept"
    assert captured["concept_text_prompts"] == ["cat"]


def test_dispatcher_point_mode_uses_tracker_model(fake_sam3_video_dispatcher_modules):
    """A numeric click prompt routes to Sam3TrackerVideoModel +
    Sam3TrackerVideoProcessor.add_inputs_to_inference_session."""
    captured, TrackerModel, TrackerProcessor, _, _ = fake_sam3_video_dispatcher_modules
    adapter = a_mod.Sam3VideoDispatcherAdapter(device="cpu")
    adapter._tracker_model = TrackerModel()  # noqa: SLF001
    adapter._tracker_processor = TrackerProcessor()  # noqa: SLF001

    state = adapter.init_state("https://fake/v.mp4")
    adapter.add_new_points(state, frame_idx=0, points=[[210, 350]], labels=[1])

    assert state["mode"] == "tracker"
    assert len(captured["tracker_added_inputs"]) == 1
    call = captured["tracker_added_inputs"][0]
    assert call["frame_idx"] == 0
    # Single object, single point — packed [batch][num_obj][num_pts][xy]
    assert call["input_points"] == [[[[210, 350]]]]
    assert call["input_labels"] == [[[1]]]


def test_dispatcher_point_mode_accepts_multiple_points(fake_sam3_video_dispatcher_modules):
    captured, TrackerModel, TrackerProcessor, _, _ = fake_sam3_video_dispatcher_modules
    adapter = a_mod.Sam3VideoDispatcherAdapter(device="cpu")
    adapter._tracker_model = TrackerModel()  # noqa: SLF001
    adapter._tracker_processor = TrackerProcessor()  # noqa: SLF001

    state = adapter.init_state("https://fake/v.mp4")
    adapter.add_new_points(state, frame_idx=0, points=[[10, 20], [30, 40]], labels=[1, 0])

    call = captured["tracker_added_inputs"][0]
    # Single object, two points
    assert call["input_points"] == [[[[10, 20], [30, 40]]]]
    assert call["input_labels"] == [[[1, 0]]]


def test_dispatcher_rejects_empty_prompt(fake_sam3_video_dispatcher_modules):
    _, _, _, _, _ = fake_sam3_video_dispatcher_modules
    adapter = a_mod.Sam3VideoDispatcherAdapter(device="cpu")
    state = adapter.init_state("https://fake/v.mp4")

    with pytest.raises(RuntimeError, match="requires points or text"):
        adapter.add_new_points(state, frame_idx=0, points=[], labels=[])


def test_dispatcher_propagate_in_concept_mode_yields_frame_idx_and_mask(
    fake_sam3_video_dispatcher_modules,
):
    _, _, _, ConceptModel, ConceptProcessor = fake_sam3_video_dispatcher_modules
    adapter = a_mod.Sam3VideoDispatcherAdapter(device="cpu")
    adapter._concept_model = ConceptModel()  # noqa: SLF001
    adapter._concept_processor = ConceptProcessor()  # noqa: SLF001

    state = adapter.init_state("https://fake/v.mp4")
    adapter.add_new_points(state, frame_idx=0, points=["person"], labels=[])

    out = list(adapter.propagate_in_video(state))

    assert len(out) == 2
    assert out[0][0] == 0
    assert out[1][0] == 1
    for _frame_idx, mask in out:
        assert isinstance(mask, np.ndarray)


def test_dispatcher_propagate_in_tracker_mode_yields_frame_idx_and_mask(
    fake_sam3_video_dispatcher_modules,
):
    _, TrackerModel, TrackerProcessor, _, _ = fake_sam3_video_dispatcher_modules
    adapter = a_mod.Sam3VideoDispatcherAdapter(device="cpu")
    adapter._tracker_model = TrackerModel()  # noqa: SLF001
    adapter._tracker_processor = TrackerProcessor()  # noqa: SLF001

    state = adapter.init_state("https://fake/v.mp4")
    adapter.add_new_points(state, frame_idx=0, points=[[1, 1]], labels=[1])

    out = list(adapter.propagate_in_video(state))

    assert len(out) == 2
    assert out[0][0] == 0
    assert out[1][0] == 1
    for _frame_idx, mask in out:
        assert isinstance(mask, np.ndarray)


def test_build_sam3_video_tracker_returns_dispatcher(monkeypatch):
    """The video-tracker builder must return a Sam3VideoDispatcherAdapter
    (not a single-class adapter). Loading actual transformers classes is
    deferred to the first add_new_points call."""
    _install_torch(monkeypatch)

    tracker = a_mod.build_sam3_video_tracker(device="cpu")

    assert isinstance(tracker, a_mod.Sam3VideoDispatcherAdapter)


# --- v1.4 multi-object: add_inputs_at_frame on the dispatcher ---------------


def test_dispatcher_add_inputs_at_frame_calls_tracker_processor(
    fake_sam3_video_dispatcher_modules,
):
    """The new ``add_inputs_at_frame`` method must route through the SAM 3
    tracker processor (Sam3TrackerVideoProcessor.add_inputs_to_inference_session)
    with the supplied ``obj_id`` (singular int per the SAM 3 model card)."""
    captured, TrackerModel, TrackerProcessor, _, _ = fake_sam3_video_dispatcher_modules
    adapter = a_mod.Sam3VideoDispatcherAdapter(device="cpu")
    adapter._tracker_model = TrackerModel()  # noqa: SLF001
    adapter._tracker_processor = TrackerProcessor()  # noqa: SLF001

    state = adapter.init_state("https://fake/v.mp4")
    adapter.add_inputs_at_frame(
        state,
        frame_idx=12,
        obj_id=2,
        points=[[100, 200]],
        labels=[1],
    )

    assert state["mode"] == "tracker"
    assert len(captured["tracker_added_inputs"]) == 1
    call = captured["tracker_added_inputs"][0]
    assert call["frame_idx"] == 12
    assert call["obj_ids"] == 2
    assert call["input_points"] == [[[[100, 200]]]]
    assert call["input_labels"] == [[[1]]]


def test_dispatcher_add_inputs_at_frame_with_box(fake_sam3_video_dispatcher_modules):
    """Box-only prompts must be forwarded as ``input_boxes`` to the tracker
    processor — points and labels stay None."""
    captured, TrackerModel, TrackerProcessor, _, _ = fake_sam3_video_dispatcher_modules
    adapter = a_mod.Sam3VideoDispatcherAdapter(device="cpu")
    adapter._tracker_model = TrackerModel()  # noqa: SLF001
    adapter._tracker_processor = TrackerProcessor()  # noqa: SLF001

    state = adapter.init_state("https://fake/v.mp4")
    adapter.add_inputs_at_frame(
        state,
        frame_idx=0,
        obj_id=3,
        boxes=[[10.0, 20.0, 50.0, 60.0]],
    )

    call = captured["tracker_added_inputs"][0]
    assert call["obj_ids"] == 3
    # Boxes get packed into [batch=1][num_obj=1][4]
    assert call["input_boxes"] == [[[10.0, 20.0, 50.0, 60.0]]]
    # No points → no point/label keys forwarded
    assert call["input_points"] is None
    assert call["input_labels"] is None


def test_dispatcher_add_inputs_at_frame_initializes_session_lazy(
    fake_sam3_video_dispatcher_modules,
):
    """On the first ``add_inputs_at_frame`` call against a fresh state,
    the dispatcher must lazily initialize the tracker session (the
    state's ``session`` field starts as None until at least one prompt
    arrives)."""
    captured, TrackerModel, TrackerProcessor, _, _ = fake_sam3_video_dispatcher_modules
    adapter = a_mod.Sam3VideoDispatcherAdapter(device="cpu")
    adapter._tracker_model = TrackerModel()  # noqa: SLF001
    adapter._tracker_processor = TrackerProcessor()  # noqa: SLF001

    state = adapter.init_state("https://fake/v.mp4")
    assert state["session"] is None
    assert state["mode"] is None

    adapter.add_inputs_at_frame(
        state,
        frame_idx=0,
        obj_id=1,
        points=[[1, 2]],
        labels=[1],
    )

    # Session is now alive and tracker mode was selected.
    assert state["session"] is not None
    assert state["mode"] == "tracker"
    # init_video_session was called exactly once on the tracker side.
    assert any(target == "tracker" for target, _ in captured["init_video_calls"])
