"""Tests for the SAM video tracker variant resolver.

Mirrors ``tests/sam/test_predictor_resolver.py``. The tracker reads
``SAM_MODEL`` (or the legacy ``SAM_VARIANT``) via the shared resolver in
``carve_model.sam.predictor`` and binds the matching HF repo. Tests stub
out ``torch`` and ``sam2.sam2_video_predictor`` via ``sys.modules`` so
the production factory can run end-to-end without GPUs or real weights.
"""

import sys
from types import ModuleType, SimpleNamespace

import pytest

from carve_model.sam import tracker as t_mod


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    monkeypatch.delenv("SAM_MODEL", raising=False)
    monkeypatch.delenv("SAM_VARIANT", raising=False)
    # Ensure no test factory leakage between resolver tests
    t_mod.set_test_tracker_factory(None)
    yield
    t_mod.set_test_tracker_factory(None)


@pytest.fixture
def fake_sam2_modules(monkeypatch):
    """Stand in for torch + sam2.sam2_video_predictor so _default_factory
    can run end-to-end without GPUs or real SAM 2 weights."""
    captured: dict = {}

    class _FakeModel:
        def to(self, _device):
            return self

    class _FakeTracker:
        model = _FakeModel()

        @classmethod
        def from_pretrained(cls, repo: str):
            captured["repo"] = repo
            return cls()

    fake_torch = ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(is_available=lambda: False)

    fake_sam2 = ModuleType("sam2")
    fake_video = ModuleType("sam2.sam2_video_predictor")
    fake_video.SAM2VideoPredictor = _FakeTracker

    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "sam2", fake_sam2)
    monkeypatch.setitem(sys.modules, "sam2.sam2_video_predictor", fake_video)
    return captured


@pytest.mark.parametrize("model_name,expected_repo", [
    ("sam2.1-tiny",      "facebook/sam2.1-hiera-tiny"),
    ("sam2.1-small",     "facebook/sam2.1-hiera-small"),
    ("sam2.1-base-plus", "facebook/sam2.1-hiera-base-plus"),
    ("sam2.1-large",     "facebook/sam2.1-hiera-large"),
])
def test_default_factory_resolves_each_sam2_1_variant(
    monkeypatch, fake_sam2_modules, model_name, expected_repo,
):
    monkeypatch.setenv("SAM_MODEL", model_name)
    t_mod._default_factory()
    assert fake_sam2_modules["repo"] == expected_repo


def test_default_factory_default_is_sam2_1_large(fake_sam2_modules):
    # Both env vars unset (autouse fixture)
    t_mod._default_factory()
    assert fake_sam2_modules["repo"] == "facebook/sam2.1-hiera-large"


def test_default_factory_routes_to_sam3_adapter_when_sam3_selected(
    monkeypatch, fake_sam2_modules,
):
    """v1.1 T6: SAM 3 selection now routes through the SAM 3 video tracker
    adapter instead of raising — the actual model is loaded lazily by the
    adapter so the RuntimeError from earlier plans no longer fires."""
    monkeypatch.setenv("SAM_MODEL", "sam3")
    called = {"build": False}

    def _fake_build():
        called["build"] = True
        return object()

    monkeypatch.setattr(
        "carve_model.sam.sam3_adapter.build_sam3_video_tracker",
        _fake_build,
    )

    t_mod._default_factory()
    assert called["build"] is True


def test_default_factory_routes_to_sam3_adapter_when_legacy_sam_variant_sam3(
    monkeypatch, fake_sam2_modules,
):
    monkeypatch.setenv("SAM_VARIANT", "sam3")
    called = {"build": False}

    def _fake_build():
        called["build"] = True
        return object()

    monkeypatch.setattr(
        "carve_model.sam.sam3_adapter.build_sam3_video_tracker",
        _fake_build,
    )

    t_mod._default_factory()
    assert called["build"] is True
