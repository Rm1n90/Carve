"""Tests for the SAM 3 wiring inside ``predictor._default_factory`` and
``tracker._default_factory``.

The actual SAM 3 model is not loaded; we monkeypatch the
``vaa_model.sam.sam3_adapter.build_sam3_image_predictor``,
``make_sam3_text_predictor``, and ``build_sam3_video_tracker`` symbols to
verify the factories route to them when ``SAM_MODEL=sam3`` is selected,
and stay out of the way otherwise.
"""

import sys
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

from vaa_model.sam import predictor as p_mod
from vaa_model.sam import tracker as t_mod


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    monkeypatch.delenv("SAM_MODEL", raising=False)
    monkeypatch.delenv("SAM_VARIANT", raising=False)
    p_mod.set_test_predictor(None)
    p_mod.reset_text_predictor()
    p_mod._reset_singleton()  # noqa: SLF001 — test-only reset
    t_mod.reset_for_test()
    yield
    p_mod.set_test_predictor(None)
    p_mod.reset_text_predictor()
    p_mod._reset_singleton()  # noqa: SLF001
    t_mod.reset_for_test()


def test_predictor_factory_uses_sam3_adapter_when_sam3_selected(monkeypatch):
    """``_default_factory()`` must build the SAM 3 image adapter when
    ``SAM_MODEL=sam3`` and (as a side effect) register the text predictor
    so /sam/text-prompt becomes operational."""
    monkeypatch.setenv("SAM_MODEL", "sam3")
    captured: dict[str, Any] = {}

    def _fake_build():
        captured["build_called"] = True
        return SimpleNamespace(
            set_image=lambda img: None,
            predict=lambda **kw: ([], [], None),
        )

    def _fake_text_factory():
        captured["text_factory_called"] = True
        return lambda *, image_b64, text: []

    monkeypatch.setattr(
        "vaa_model.sam.sam3_adapter.build_sam3_image_predictor",
        _fake_build,
    )
    monkeypatch.setattr(
        "vaa_model.sam.sam3_adapter.make_sam3_text_predictor",
        _fake_text_factory,
    )

    predictor = p_mod._default_factory()  # noqa: SLF001 — exercising production path

    assert captured.get("build_called") is True
    assert captured.get("text_factory_called") is True
    assert predictor is not None
    # Side effect: a text predictor must now be registered so /sam/text-prompt
    # stops returning 503.
    assert p_mod._TEXT_PREDICTOR_FACTORY is not None  # noqa: SLF001


def test_predictor_factory_skips_text_predictor_if_already_set(monkeypatch):
    """When the operator has already registered a custom text predictor,
    the SAM 3 factory must NOT overwrite it."""
    monkeypatch.setenv("SAM_MODEL", "sam3")

    pre_existing = lambda *, image_b64, text: [{"counts": "x", "size": [1, 1], "score": 0.5, "bbox": [0.0, 0.0, 0.0, 0.0]}]
    p_mod.set_text_predictor(pre_existing)

    overwrite_called = {"value": False}

    def _fake_build():
        return SimpleNamespace(set_image=lambda img: None, predict=lambda **kw: ([], [], None))

    def _fake_text_factory():
        overwrite_called["value"] = True
        return lambda *, image_b64, text: []

    monkeypatch.setattr(
        "vaa_model.sam.sam3_adapter.build_sam3_image_predictor",
        _fake_build,
    )
    monkeypatch.setattr(
        "vaa_model.sam.sam3_adapter.make_sam3_text_predictor",
        _fake_text_factory,
    )

    p_mod._default_factory()  # noqa: SLF001

    # The factory must have skipped the text predictor registration step.
    assert overwrite_called["value"] is False
    assert p_mod._TEXT_PREDICTOR_FACTORY is pre_existing  # noqa: SLF001


def test_tracker_factory_uses_sam3_adapter_when_sam3_selected(monkeypatch):
    monkeypatch.setenv("SAM_MODEL", "sam3")
    captured: dict[str, Any] = {}

    def _fake_build():
        captured["called"] = True
        return SimpleNamespace(
            init_state=lambda url: {"video": url},
            add_new_points=lambda *a, **kw: (None, None, None),
            propagate_in_video=lambda s: iter([]),
        )

    monkeypatch.setattr(
        "vaa_model.sam.sam3_adapter.build_sam3_video_tracker",
        _fake_build,
    )

    tracker = t_mod._default_factory()  # noqa: SLF001

    assert captured["called"] is True
    assert tracker is not None


def test_predictor_factory_uses_sam2_path_for_default(monkeypatch):
    """Regression: when SAM_MODEL is unset (default sam2.1-large) the
    factory must NOT touch the SAM 3 adapter — it must follow the SAM 2
    path that imports torch + sam2."""
    captured: dict[str, Any] = {}

    fake_torch = ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(is_available=lambda: False)

    class _FakeModel:
        def to(self, _device):
            return self

    class _FakeSam2Predictor:
        model = _FakeModel()

        @classmethod
        def from_pretrained(cls, repo: str):
            captured["repo"] = repo
            return cls()

    fake_sam2 = ModuleType("sam2")
    fake_image = ModuleType("sam2.sam2_image_predictor")
    fake_image.SAM2ImagePredictor = _FakeSam2Predictor
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "sam2", fake_sam2)
    monkeypatch.setitem(sys.modules, "sam2.sam2_image_predictor", fake_image)

    # Sentinel to detect any leakage into the SAM 3 path.
    def _explode():
        raise AssertionError("sam2 default path must not call the SAM 3 builder")

    monkeypatch.setattr(
        "vaa_model.sam.sam3_adapter.build_sam3_image_predictor",
        _explode,
    )

    p_mod._default_factory()  # noqa: SLF001

    assert captured["repo"] == "facebook/sam2.1-hiera-large"


def test_tracker_factory_uses_sam2_path_for_default(monkeypatch):
    """Regression: tracker default factory must skip SAM 3 path on default."""
    captured: dict[str, Any] = {}

    fake_torch = ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(is_available=lambda: False)

    class _FakeModel:
        def to(self, _device):
            return self

    class _FakeSam2VideoPredictor:
        model = _FakeModel()

        @classmethod
        def from_pretrained(cls, repo: str):
            captured["repo"] = repo
            return cls()

    fake_sam2 = ModuleType("sam2")
    fake_video = ModuleType("sam2.sam2_video_predictor")
    fake_video.SAM2VideoPredictor = _FakeSam2VideoPredictor
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "sam2", fake_sam2)
    monkeypatch.setitem(sys.modules, "sam2.sam2_video_predictor", fake_video)

    def _explode():
        raise AssertionError("sam2 default path must not call the SAM 3 builder")

    monkeypatch.setattr(
        "vaa_model.sam.sam3_adapter.build_sam3_video_tracker",
        _explode,
    )

    t_mod._default_factory()  # noqa: SLF001

    assert captured["repo"] == "facebook/sam2.1-hiera-large"


def test_predictor_factory_with_legacy_sam_variant_sam3(monkeypatch):
    """Plan 08's ``SAM_VARIANT=sam3`` must still route through the SAM 3
    adapter for backward compatibility."""
    monkeypatch.setenv("SAM_VARIANT", "sam3")
    called = {"build": False}

    def _fake_build():
        called["build"] = True
        return SimpleNamespace(set_image=lambda img: None, predict=lambda **kw: ([], [], None))

    monkeypatch.setattr(
        "vaa_model.sam.sam3_adapter.build_sam3_image_predictor",
        _fake_build,
    )
    monkeypatch.setattr(
        "vaa_model.sam.sam3_adapter.make_sam3_text_predictor",
        lambda: (lambda *, image_b64, text: []),
    )

    p_mod._default_factory()  # noqa: SLF001
    assert called["build"] is True
