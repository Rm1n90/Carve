"""Tests for the SAM 3.1 native multiplex video adapter.

Plan 11 Task 3. The adapter wraps the native ``sam3`` git package's
``MultiplexVideoPredictor`` (request-style API) in the ``TrackerProtocol``
contract used by ``track_router`` and the rest of the pipeline.

These tests use a stub predictor (``FakePredictor``) so they run without
the native sam3 package — keeping the dev path torch/sam3-free. The
``SAM3P1_AVAILABLE=1`` env var unlocks an integration-style smoke test
that requires the real native package.
"""

from __future__ import annotations

import os
import sys
from types import ModuleType, SimpleNamespace
from typing import Any

import numpy as np
import pytest

from carve_model.sam import sam3p1_adapter as a_mod
from carve_model.sam import tracker as t_mod


# --- coord conversion -------------------------------------------------------


@pytest.mark.unit
def test_abs_to_rel_point_converts_pixel_to_relative():
    rel = a_mod._abs_to_rel_point((300, 200), h=1080, w=1920)

    # 300/1920 ≈ 0.15625, 200/1080 ≈ 0.18519
    assert rel == pytest.approx([0.15625, 0.18519], abs=1e-4)


@pytest.mark.unit
def test_abs_to_rel_box_converts_xyxy_to_relative():
    rel = a_mod._abs_to_rel_box((100, 50, 500, 400), h=1080, w=1920)

    assert rel == pytest.approx([0.052, 0.046, 0.260, 0.370], abs=1e-3)


@pytest.mark.unit
def test_abs_to_rel_point_rejects_zero_or_negative_size():
    with pytest.raises(ValueError):
        a_mod._abs_to_rel_point((10, 10), h=0, w=100)
    with pytest.raises(ValueError):
        a_mod._abs_to_rel_point((10, 10), h=100, w=-5)


# --- fake torch + predictor stubs -------------------------------------------


class _FakeTensor:
    """Minimal duck-typed tensor: numpy round-trip + dtype/shape."""

    def __init__(self, arr: Any, dtype: Any = None) -> None:
        self._arr = np.asarray(arr)
        self._dtype = dtype

    def cpu(self) -> "_FakeTensor":
        return self

    def numpy(self) -> np.ndarray:
        return self._arr

    @property
    def dtype(self) -> Any:
        return self._dtype if self._dtype is not None else self._arr.dtype

    @property
    def shape(self) -> tuple:
        return tuple(self._arr.shape)

    def tolist(self) -> Any:
        return self._arr.tolist()


@pytest.fixture
def fake_torch_module(monkeypatch):
    """Inject a minimal ``torch`` stub so the adapter's ``torch.tensor``
    calls work without pulling the real torch package.
    """
    fake = ModuleType("torch")

    def _tensor(data, dtype=None):
        return _FakeTensor(data, dtype=dtype)

    fake.tensor = _tensor
    fake.float32 = "float32"
    fake.int32 = "int32"
    # ``perf.py`` references ``torch.dtype`` as a type annotation evaluated
    # at module-import time, plus ``torch.cuda.is_available()`` /
    # ``torch.bfloat16`` from ``get_dtype``/``get_device``. Provide just
    # enough of the surface so a lazy ``from carve_model.sam.perf import
    # to_numpy_safe`` under this fixture doesn't blow up.
    fake.dtype = type
    fake.bfloat16 = "bfloat16"
    fake.cuda = SimpleNamespace(
        is_available=lambda: False,
        is_bf16_supported=lambda: False,
    )
    monkeypatch.setitem(sys.modules, "torch", fake)
    return fake


class FakePredictor:
    """Stub native sam3 multiplex predictor for adapter unit tests."""

    def __init__(
        self,
        start_response: dict | None = None,
        propagate_responses: list[dict] | None = None,
    ) -> None:
        self._start_response = start_response or {
            "session_id": "sess-abc",
            "image_height": 1080,
            "image_width": 1920,
        }
        self._propagate_responses = propagate_responses or []
        self.requests: list[dict] = []
        self.stream_requests: list[dict] = []

    def handle_request(self, req: dict) -> dict:
        self.requests.append(req)
        if req.get("type") == "start_session":
            return dict(self._start_response)
        return {"ok": True}

    def handle_stream_request(self, req: dict):
        self.stream_requests.append(req)
        for resp in self._propagate_responses:
            yield resp


# --- init_state -------------------------------------------------------------


@pytest.mark.unit
def test_init_state_calls_start_session_and_captures_image_size():
    pred = FakePredictor()
    adapter = a_mod.Sam3p1MultiplexVideoAdapter(predictor=pred)

    state = adapter.init_state("/path/to/video.mp4")

    assert state["session_id"] == "sess-abc"
    assert state["image_size"] == (1080, 1920)
    assert state["mode"] == "multiplex"
    assert state["video_path"] == "/path/to/video.mp4"
    assert len(pred.requests) == 1
    assert pred.requests[0]["type"] == "start_session"
    assert pred.requests[0]["resource_path"] == "/path/to/video.mp4"


@pytest.mark.unit
def test_init_state_raises_when_session_id_missing():
    pred = FakePredictor(start_response={"unexpected": "shape"})
    adapter = a_mod.Sam3p1MultiplexVideoAdapter(predictor=pred)

    with pytest.raises(RuntimeError, match="start_session"):
        adapter.init_state("/path/to/video.mp4")


# --- add_inputs_at_frame ----------------------------------------------------


@pytest.mark.unit
def test_add_inputs_at_frame_with_points_sends_relative_coords(fake_torch_module):
    pred = FakePredictor()
    adapter = a_mod.Sam3p1MultiplexVideoAdapter(predictor=pred)
    state = adapter.init_state("/v.mp4")

    adapter.add_inputs_at_frame(
        state,
        frame_idx=0,
        obj_id=2,
        points=[(300, 200)],
        labels=[1],
    )

    add_req = pred.requests[-1]
    assert add_req["type"] == "add_prompt"
    assert add_req["session_id"] == "sess-abc"
    assert add_req["frame_index"] == 0
    assert add_req["obj_id"] == 2
    points_tensor = add_req["points"]
    np.testing.assert_allclose(
        points_tensor.numpy(),
        [[300 / 1920, 200 / 1080]],
        atol=1e-6,
    )
    labels_tensor = add_req["point_labels"]
    np.testing.assert_array_equal(labels_tensor.numpy(), [1])


@pytest.mark.unit
def test_add_inputs_at_frame_with_box_sends_relative_xyxy(fake_torch_module):
    pred = FakePredictor()
    adapter = a_mod.Sam3p1MultiplexVideoAdapter(predictor=pred)
    state = adapter.init_state("/v.mp4")

    adapter.add_inputs_at_frame(
        state,
        frame_idx=0,
        obj_id=3,
        boxes=[(100, 50, 500, 400)],
    )

    add_req = pred.requests[-1]
    assert "box" in add_req
    np.testing.assert_allclose(
        add_req["box"].numpy(),
        [100 / 1920, 50 / 1080, 500 / 1920, 400 / 1080],
        atol=1e-6,
    )


@pytest.mark.unit
def test_add_inputs_at_frame_rejects_both_points_and_boxes(fake_torch_module):
    pred = FakePredictor()
    adapter = a_mod.Sam3p1MultiplexVideoAdapter(predictor=pred)
    state = adapter.init_state("/v.mp4")

    with pytest.raises(ValueError, match="either points or boxes"):
        adapter.add_inputs_at_frame(
            state,
            frame_idx=0,
            obj_id=1,
            points=[(10, 10)],
            labels=[1],
            boxes=[(0, 0, 50, 50)],
        )


@pytest.mark.unit
def test_add_inputs_at_frame_requires_one_of_points_or_boxes(fake_torch_module):
    pred = FakePredictor()
    adapter = a_mod.Sam3p1MultiplexVideoAdapter(predictor=pred)
    state = adapter.init_state("/v.mp4")

    with pytest.raises(RuntimeError, match="requires points or boxes"):
        adapter.add_inputs_at_frame(state, frame_idx=0, obj_id=1)


# --- text prompt ------------------------------------------------------------


@pytest.mark.unit
def test_add_text_prompt_omits_obj_id_for_multiplex_auto_assignment(
    fake_torch_module,
):
    pred = FakePredictor()
    adapter = a_mod.Sam3p1MultiplexVideoAdapter(predictor=pred)
    state = adapter.init_state("/v.mp4")

    adapter.add_text_prompt(state, frame_idx=0, text="person")

    text_req = pred.requests[-1]
    assert text_req["type"] == "add_prompt"
    assert text_req["text"] == "person"
    assert "obj_id" not in text_req


# --- propagate --------------------------------------------------------------


@pytest.mark.unit
def test_propagate_in_video_translates_streaming_outputs(fake_torch_module):
    mask_a = np.ones((4, 4), dtype=np.uint8)
    mask_b = np.zeros((4, 4), dtype=np.uint8)
    pred = FakePredictor(
        propagate_responses=[
            {
                "frame_index": 0,
                "outputs": {
                    "1": {"mask": _FakeTensor(mask_a), "score": 0.9},
                    "2": {"mask": _FakeTensor(mask_b), "score": 0.7},
                },
            },
            {
                "frame_index": 1,
                "outputs": {
                    "1": {"mask": _FakeTensor(mask_a), "score": 0.85},
                },
            },
        ],
    )
    adapter = a_mod.Sam3p1MultiplexVideoAdapter(predictor=pred)
    state = adapter.init_state("/v.mp4")

    results = list(adapter.propagate_in_video(state))

    assert len(results) == 2
    f0, masks0 = results[0]
    assert f0 == 0
    assert isinstance(f0, int)
    assert set(masks0.keys()) == {1, 2}
    np.testing.assert_array_equal(masks0[1], mask_a)
    np.testing.assert_array_equal(masks0[2], mask_b)
    f1, masks1 = results[1]
    assert f1 == 1
    assert set(masks1.keys()) == {1}


# --- remove_object / reset / release ----------------------------------------


@pytest.mark.unit
def test_remove_object_sends_request(fake_torch_module):
    pred = FakePredictor()
    adapter = a_mod.Sam3p1MultiplexVideoAdapter(predictor=pred)
    state = adapter.init_state("/v.mp4")

    adapter.remove_object(state, obj_id=2)

    req = pred.requests[-1]
    assert req["type"] == "remove_object"
    assert req["obj_id"] == 2
    assert req["session_id"] == "sess-abc"


@pytest.mark.unit
def test_reset_session_sends_request(fake_torch_module):
    pred = FakePredictor()
    adapter = a_mod.Sam3p1MultiplexVideoAdapter(predictor=pred)
    state = adapter.init_state("/v.mp4")

    adapter.reset_session(state)

    req = pred.requests[-1]
    assert req["type"] == "reset_session"
    assert req["session_id"] == "sess-abc"


@pytest.mark.unit
def test_release_sends_close_session_and_clears_predictor(fake_torch_module):
    pred = FakePredictor()
    adapter = a_mod.Sam3p1MultiplexVideoAdapter(predictor=pred)
    state = adapter.init_state("/v.mp4")

    adapter.release(state)

    req = pred.requests[-1]
    assert req["type"] == "close_session"
    assert state["predictor"] is None


# --- lazy image-size discovery ---------------------------------------------


@pytest.mark.unit
def test_ensure_image_size_uses_probe_when_response_omits_size(
    fake_torch_module, monkeypatch,
):
    pred = FakePredictor(start_response={"session_id": "sess-no-size"})
    adapter = a_mod.Sam3p1MultiplexVideoAdapter(predictor=pred)
    state = adapter.init_state("/v.mp4")
    assert state["image_size"] is None

    monkeypatch.setattr(a_mod, "_probe_image_size", lambda path: (720, 1280))

    adapter.add_inputs_at_frame(
        state, frame_idx=0, obj_id=1, points=[(640, 360)], labels=[1],
    )

    assert state["image_size"] == (720, 1280)
    points_tensor = pred.requests[-1]["points"]
    np.testing.assert_allclose(
        points_tensor.numpy(), [[640 / 1280, 360 / 720]], atol=1e-6,
    )


@pytest.mark.unit
def test_ensure_image_size_raises_when_probe_fails(
    fake_torch_module, monkeypatch,
):
    pred = FakePredictor(start_response={"session_id": "sess-no-size"})
    adapter = a_mod.Sam3p1MultiplexVideoAdapter(predictor=pred)
    state = adapter.init_state("/v.mp4")

    monkeypatch.setattr(a_mod, "_probe_image_size", lambda path: None)

    with pytest.raises(RuntimeError, match="could not determine image size"):
        adapter.add_inputs_at_frame(
            state, frame_idx=0, obj_id=1, points=[(10, 10)], labels=[1],
        )


# --- _default_factory routing ----------------------------------------------


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    monkeypatch.delenv("SAM_MODEL", raising=False)
    monkeypatch.delenv("SAM_VARIANT", raising=False)
    monkeypatch.delenv("SAM_VIDEO_BACKEND", raising=False)
    t_mod.set_test_tracker_factory(None)
    yield
    t_mod.set_test_tracker_factory(None)


@pytest.mark.unit
def test_default_factory_routes_to_multiplex_when_env_set_and_native_available(
    monkeypatch,
):
    monkeypatch.setenv("SAM_VIDEO_BACKEND", "multiplex")

    sentinel = object()
    monkeypatch.setattr(
        "carve_model.sam.sam3p1_adapter.build_sam3p1_multiplex_video_tracker",
        lambda: sentinel,
    )

    result = t_mod._default_factory()  # noqa: SLF001
    assert result is sentinel


@pytest.mark.unit
def test_default_factory_falls_back_when_native_sam3_missing(monkeypatch):
    monkeypatch.setenv("SAM_VIDEO_BACKEND", "multiplex")

    def _raise():
        raise ImportError("no native sam3")

    monkeypatch.setattr(
        "carve_model.sam.sam3p1_adapter.build_sam3p1_multiplex_video_tracker",
        _raise,
    )

    fallback_sentinel = object()
    monkeypatch.setattr(
        "carve_model.sam.sam3_adapter.build_sam3_video_tracker",
        lambda: fallback_sentinel,
    )

    result = t_mod._default_factory()  # noqa: SLF001
    assert result is fallback_sentinel


# --- integration smoke test (requires native sam3) -------------------------


@pytest.mark.integration
@pytest.mark.skipif(
    os.environ.get("SAM3P1_AVAILABLE") != "1",
    reason="native sam3 package not available; set SAM3P1_AVAILABLE=1 to run",
)
def test_native_sam3_multiplex_predictor_can_be_built():
    pytest.importorskip("sam3.model_builder")
    adapter = a_mod.build_sam3p1_multiplex_video_tracker()
    assert isinstance(adapter, a_mod.Sam3p1MultiplexVideoAdapter)
