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
    # SAM2_BACKEND defaults to legacy when unset (v3.4 commit 3 toggle).
    monkeypatch.delenv("SAM2_BACKEND", raising=False)
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


# --- SAM2_BACKEND toggle (v3.4 commit 3) ------------------------------------


@pytest.fixture
def fake_transformers_sam2_video_modules(monkeypatch):
    """Stub the transformers ``Sam2VideoModel`` + ``Sam2VideoProcessor`` so
    the new transformers-backed video tracker can be built without loading
    torch or pulling weights."""
    captured: dict = {}

    fake_torch = ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(
        is_available=lambda: False,
        is_bf16_supported=lambda: False,
    )
    fake_torch.bfloat16 = "bfloat16"
    fake_torch.float32 = "float32"
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

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
    return captured


def test_default_factory_uses_legacy_path_when_sam2_backend_unset(
    monkeypatch, fake_sam2_modules,
):
    """Default ``SAM2_BACKEND`` (unset) must keep using the legacy
    ``SAM2VideoPredictor`` from the sam2 git package."""
    monkeypatch.setenv("SAM_MODEL", "sam2.1-tiny")

    t_mod._default_factory()  # noqa: SLF001

    assert fake_sam2_modules["repo"] == "facebook/sam2.1-hiera-tiny"


def test_default_factory_uses_legacy_path_when_sam2_backend_legacy(
    monkeypatch, fake_sam2_modules,
):
    """Explicit ``SAM2_BACKEND=legacy`` is equivalent to unset."""
    monkeypatch.setenv("SAM_MODEL", "sam2.1-tiny")
    monkeypatch.setenv("SAM2_BACKEND", "legacy")

    t_mod._default_factory()  # noqa: SLF001

    assert fake_sam2_modules["repo"] == "facebook/sam2.1-hiera-tiny"


@pytest.mark.parametrize("model_name,expected_repo", [
    ("sam2.1-tiny",      "facebook/sam2.1-hiera-tiny"),
    ("sam2.1-small",     "facebook/sam2.1-hiera-small"),
    ("sam2.1-base-plus", "facebook/sam2.1-hiera-base-plus"),
    ("sam2.1-large",     "facebook/sam2.1-hiera-large"),
])
def test_default_factory_uses_transformers_path_when_sam2_backend_transformers(
    monkeypatch, fake_transformers_sam2_video_modules, model_name, expected_repo,
):
    """When ``SAM2_BACKEND=transformers``, ``_default_factory`` must call
    ``Sam2VideoModel.from_pretrained(<repo>)`` (NOT the legacy
    ``SAM2VideoPredictor`` from the sam2 git package)."""
    monkeypatch.setenv("SAM_MODEL", model_name)
    monkeypatch.setenv("SAM2_BACKEND", "transformers")

    t_mod._default_factory()  # noqa: SLF001

    assert fake_transformers_sam2_video_modules["model_repo"] == expected_repo
    assert fake_transformers_sam2_video_modules["proc_repo"] == expected_repo
    assert fake_transformers_sam2_video_modules["model_class"] == "Sam2VideoModel"


def test_default_factory_sam3_unaffected_by_sam2_backend(
    monkeypatch, fake_sam2_modules,
):
    """``SAM2_BACKEND`` is a SAM 2.x toggle only — ``SAM_MODEL=sam3`` always
    routes through the SAM 3 adapter regardless of the SAM2_BACKEND value."""
    monkeypatch.setenv("SAM_MODEL", "sam3")
    monkeypatch.setenv("SAM2_BACKEND", "transformers")
    called = {"build": False}

    def _fake_build():
        called["build"] = True
        return object()

    monkeypatch.setattr(
        "carve_model.sam.sam3_adapter.build_sam3_video_tracker",
        _fake_build,
    )

    t_mod._default_factory()  # noqa: SLF001
    assert called["build"] is True
