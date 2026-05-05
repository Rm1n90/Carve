"""Tests for VLM-FO1 adapter — the precision filter that sits between
SAM 3's mask proposals and the final returned annotations.

The real Qwen2.5-VL-3B + FO1 head is multi-GB and gated — never loaded
in tests. We stub torch + transformers + PIL via ``sys.modules`` so the
adapter logic runs without GPUs or network access. Mirrors the
``fake_sam2_modules`` / ``fake_sam3_concept`` patterns used elsewhere in
``apps/model/tests/sam/``.
"""

from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace
from typing import Any

import numpy as np
import pytest

from carve_model.vlm_fo1 import adapter as a_mod


# --- shared fakes -----------------------------------------------------------


class _FakeImage:
    """Minimal PIL.Image-like object."""

    def __init__(self, w: int = 64, h: int = 64) -> None:
        self.size = (w, h)
        self.mode = "RGB"

    def convert(self, _mode: str) -> "_FakeImage":
        return self


class _FakeModel:
    def __init__(self, decoded_output: str = "<region0>") -> None:
        self._decoded = decoded_output
        self.generate_calls: list[dict] = []

    def generate(self, **kwargs) -> Any:
        self.generate_calls.append(kwargs)
        return np.zeros((1, 1), dtype=np.int64)


class _FakeTokenizer:
    def __init__(self, decoded_output: str) -> None:
        self.decoded_output = decoded_output
        self.decode_calls: list[Any] = []

    def decode(self, _ids, *_a, **_kw) -> str:
        self.decode_calls.append(_ids)
        return self.decoded_output


class _FakeProcessor:
    """Stand-in for the FO1 image processor / message builder."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def __call__(self, **kwargs) -> dict:
        self.calls.append(kwargs)
        return _FakeBatch({"input_ids": np.zeros((1, 8), dtype=np.int64)})


class _FakeBatch(dict):
    def __init__(self, data: dict) -> None:
        super().__init__(data)

    def to(self, _device: Any) -> "_FakeBatch":
        return self

    @property
    def shape(self) -> tuple:
        ids = self.get("input_ids")
        return tuple(ids.shape) if ids is not None else (1, 0)


# --- shared monkeypatch helpers --------------------------------------------


@pytest.fixture
def fake_vlm_fo1_modules(monkeypatch):
    fake_torch = ModuleType("torch")

    class _InferenceMode:
        def __enter__(self) -> "_InferenceMode":
            return self

        def __exit__(self, *_exc: Any) -> None:
            return None

    fake_torch.inference_mode = lambda: _InferenceMode()
    fake_torch.no_grad = lambda: _InferenceMode()
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    fake_pil = ModuleType("PIL")
    fake_pil_image = ModuleType("PIL.Image")
    fake_pil_image.Image = _FakeImage
    fake_pil.Image = fake_pil_image
    monkeypatch.setitem(sys.modules, "PIL", fake_pil)
    monkeypatch.setitem(sys.modules, "PIL.Image", fake_pil_image)

    fake_transformers = ModuleType("transformers")
    monkeypatch.setitem(sys.modules, "transformers", fake_transformers)

    return SimpleNamespace(
        Model=_FakeModel,
        Tokenizer=_FakeTokenizer,
        Processor=_FakeProcessor,
    )


@pytest.fixture
def stubbed_filter(monkeypatch, fake_vlm_fo1_modules):
    """Patch ``a_mod._build_vlm_fo1_pair`` to return canned fakes."""
    bundle = SimpleNamespace(
        decoded_output="<region0>",
        build_calls=0,
        last_pair=None,
    )

    def _fake_build(*_args, **_kwargs):
        bundle.build_calls += 1
        model = fake_vlm_fo1_modules.Model(bundle.decoded_output)
        tok = fake_vlm_fo1_modules.Tokenizer(bundle.decoded_output)
        proc = fake_vlm_fo1_modules.Processor()
        pair = (tok, model, proc, "cpu")
        bundle.last_pair = pair
        return pair

    monkeypatch.setattr(a_mod, "_build_vlm_fo1_pair", _fake_build)
    return bundle


# --- behavioural tests -----------------------------------------------------


def test_filter_short_circuits_on_empty_boxes(stubbed_filter):
    fn = a_mod.make_vlm_fo1_filter()
    image = _FakeImage()

    out = fn(image=image, text="lion", boxes=[])

    assert out == []
    assert stubbed_filter.build_calls == 0


def test_filter_short_circuits_on_blank_text(stubbed_filter):
    """Blank text → degrade to passthrough (return all indexes)."""
    fn = a_mod.make_vlm_fo1_filter()
    image = _FakeImage()
    boxes = [[0.0, 0.0, 10.0, 10.0], [5.0, 5.0, 15.0, 15.0]]

    out = fn(image=image, text="   ", boxes=boxes)

    assert out == [0, 1]
    assert stubbed_filter.build_calls == 0


def test_filter_returns_indexes_emitted_by_model(stubbed_filter):
    stubbed_filter.decoded_output = "<region2>, <region0>"
    fn = a_mod.make_vlm_fo1_filter()
    image = _FakeImage()
    boxes = [[i, i, i + 5, i + 5] for i in range(4)]

    out = fn(image=image, text="ball nearest the bear", boxes=boxes)

    assert out == [2, 0]


def test_filter_caps_box_count_for_model_input(stubbed_filter):
    stubbed_filter.decoded_output = "<region0>"
    fn = a_mod.make_vlm_fo1_filter(max_boxes=3)
    image = _FakeImage()
    boxes = [[i, i, i + 5, i + 5] for i in range(10)]

    fn(image=image, text="lion", boxes=boxes)

    proc = stubbed_filter.last_pair[2]
    last_call = proc.calls[-1]
    assert "bbox_list" in last_call
    assert len(last_call["bbox_list"]) == 3


def test_filter_lazy_loads_only_once(stubbed_filter):
    stubbed_filter.decoded_output = "<region0>"
    fn = a_mod.make_vlm_fo1_filter()
    image = _FakeImage()
    boxes = [[0.0, 0.0, 10.0, 10.0]]

    fn(image=image, text="a", boxes=boxes)
    fn(image=image, text="b", boxes=boxes)
    fn(image=image, text="c", boxes=boxes)

    assert stubbed_filter.build_calls == 1


def test_filter_degrades_to_passthrough_on_model_error(monkeypatch, fake_vlm_fo1_modules):
    """A runtime error inside the model must NOT crash the request."""
    def _build_exploding():
        class _Boom:
            def generate(self, **_kw):
                raise RuntimeError("simulated cuda OOM")
        tok = type("T", (), {"decode": lambda self, *_a, **_kw: ""})()
        proc = type("P", (), {"__call__": lambda self, **_kw: {}})()
        return tok, _Boom(), proc, "cpu"

    monkeypatch.setattr(a_mod, "_build_vlm_fo1_pair", _build_exploding)

    fn = a_mod.make_vlm_fo1_filter()
    image = _FakeImage()
    boxes = [[0.0, 0.0, 10.0, 10.0], [5.0, 5.0, 15.0, 15.0]]

    out = fn(image=image, text="lion", boxes=boxes)

    assert out == [0, 1]


def test_filter_returns_empty_when_model_emits_no_matches(stubbed_filter):
    stubbed_filter.decoded_output = "no objects matched."
    fn = a_mod.make_vlm_fo1_filter()
    image = _FakeImage()
    boxes = [[i, i, i + 5, i + 5] for i in range(3)]

    out = fn(image=image, text="unicorn", boxes=boxes)

    assert out == []


def test_filter_drops_indexes_outside_box_range(stubbed_filter):
    stubbed_filter.decoded_output = "<region77>, <region1>"
    fn = a_mod.make_vlm_fo1_filter()
    image = _FakeImage()
    boxes = [[0.0, 0.0, 10.0, 10.0], [5.0, 5.0, 15.0, 15.0]]

    out = fn(image=image, text="lion", boxes=boxes)

    assert out == [1]
