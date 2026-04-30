"""Tests for the SAM model variant resolver.

The resolver lives in ``carve_model.sam.predictor`` and is the single source
of truth for which SAM checkpoint the image predictor should load. It
reads ``SAM_MODEL`` first and falls back to the legacy Plan 08
``SAM_VARIANT`` env var so existing operator setups keep working.
"""

import sys
from types import ModuleType, SimpleNamespace

import pytest

from carve_model.sam import predictor as p_mod


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    # Strip env vars before each test so we always start from defaults.
    # SAM2_BACKEND defaults to legacy when unset.
    monkeypatch.delenv("SAM_MODEL", raising=False)
    monkeypatch.delenv("SAM_VARIANT", raising=False)
    monkeypatch.delenv("SAM2_BACKEND", raising=False)


def test_default_is_sam2_1_large():
    assert p_mod.get_sam_model() == "sam2.1-large"
    assert p_mod.get_sam_variant() == "sam2"


@pytest.mark.parametrize("name", [
    "sam2.1-tiny",
    "sam2.1-small",
    "sam2.1-base-plus",
    "sam2.1-large",
    "sam3",
])
def test_each_allowed_model_resolves(monkeypatch, name):
    monkeypatch.setenv("SAM_MODEL", name)
    assert p_mod.get_sam_model() == name


def test_sam3_flips_variant(monkeypatch):
    monkeypatch.setenv("SAM_MODEL", "sam3")
    assert p_mod.get_sam_variant() == "sam3"


def test_unknown_falls_back_to_default(monkeypatch, caplog):
    import logging
    monkeypatch.setenv("SAM_MODEL", "totally-not-a-model")
    with caplog.at_level(logging.WARNING, logger="carve_model.sam.predictor"):
        assert p_mod.get_sam_model() == "sam2.1-large"
    assert any("totally-not-a-model" in r.message for r in caplog.records)


def test_legacy_sam_variant_sam3_still_works(monkeypatch):
    """Plan 08's SAM_VARIANT=sam3 must still flip the variant."""
    monkeypatch.setenv("SAM_VARIANT", "sam3")
    assert p_mod.get_sam_model() == "sam3"
    assert p_mod.get_sam_variant() == "sam3"


def test_legacy_sam_variant_sam2_maps_to_default_size(monkeypatch):
    """Plan 08's SAM_VARIANT=sam2 should select the default size."""
    monkeypatch.setenv("SAM_VARIANT", "sam2")
    assert p_mod.get_sam_model() == "sam2.1-large"


def test_sam_model_takes_precedence_over_sam_variant(monkeypatch):
    monkeypatch.setenv("SAM_VARIANT", "sam3")
    monkeypatch.setenv("SAM_MODEL", "sam2.1-tiny")
    assert p_mod.get_sam_model() == "sam2.1-tiny"
    assert p_mod.get_sam_variant() == "sam2"


def test_repo_map_has_entry_per_model():
    for name in p_mod.ALLOWED_SAM_MODELS:
        assert name in p_mod._HF_REPO_BY_MODEL  # noqa: SLF001 — module-level constant


# --- SAM2_BACKEND toggle (v3.4 commit 3) ------------------------------------


@pytest.fixture
def fake_legacy_sam2_modules(monkeypatch):
    """Stub the legacy ``sam2.sam2_image_predictor`` path so ``_default_factory``
    can run end-to-end without GPUs or real SAM 2 weights."""
    captured: dict = {}

    class _FakeModel:
        def to(self, _device):
            return self

    class _FakePredictor:
        model = _FakeModel()

        @classmethod
        def from_pretrained(cls, repo: str):
            captured["legacy_repo"] = repo
            return cls()

    fake_torch = ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(is_available=lambda: False)

    fake_sam2 = ModuleType("sam2")
    fake_image_pred = ModuleType("sam2.sam2_image_predictor")
    fake_image_pred.SAM2ImagePredictor = _FakePredictor

    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "sam2", fake_sam2)
    monkeypatch.setitem(sys.modules, "sam2.sam2_image_predictor", fake_image_pred)
    return captured


@pytest.fixture
def fake_transformers_sam2_modules(monkeypatch):
    """Stub the transformers ``Sam2Model`` + ``Sam2Processor`` classes so
    ``_default_factory`` can build the new transformers-backed adapter
    without loading torch or pulling weights."""
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
    fake_transformers.Sam2Model = type("Sam2Model", (_M,), {})
    fake_transformers.Sam2Processor = type("Sam2Processor", (_P,), {})
    monkeypatch.setitem(sys.modules, "transformers", fake_transformers)
    return captured


def test_default_factory_uses_legacy_path_when_sam2_backend_unset(
    monkeypatch, fake_legacy_sam2_modules,
):
    """Default ``SAM2_BACKEND`` (unset) must keep the existing legacy SAM 2
    git package path so production behavior is identical without an
    explicit opt-in."""
    monkeypatch.setenv("SAM_MODEL", "sam2.1-tiny")

    p_mod._default_factory()  # noqa: SLF001 — exercising module-private factory

    assert fake_legacy_sam2_modules["legacy_repo"] == "facebook/sam2.1-hiera-tiny"


def test_default_factory_uses_legacy_path_when_sam2_backend_legacy(
    monkeypatch, fake_legacy_sam2_modules,
):
    """Explicit ``SAM2_BACKEND=legacy`` is equivalent to unset."""
    monkeypatch.setenv("SAM_MODEL", "sam2.1-tiny")
    monkeypatch.setenv("SAM2_BACKEND", "legacy")

    p_mod._default_factory()  # noqa: SLF001

    assert fake_legacy_sam2_modules["legacy_repo"] == "facebook/sam2.1-hiera-tiny"


@pytest.mark.parametrize("model_name,expected_repo", [
    ("sam2.1-tiny",      "facebook/sam2.1-hiera-tiny"),
    ("sam2.1-small",     "facebook/sam2.1-hiera-small"),
    ("sam2.1-base-plus", "facebook/sam2.1-hiera-base-plus"),
    ("sam2.1-large",     "facebook/sam2.1-hiera-large"),
])
def test_default_factory_uses_transformers_path_when_sam2_backend_transformers(
    monkeypatch, fake_transformers_sam2_modules, model_name, expected_repo,
):
    """When ``SAM2_BACKEND=transformers``, ``_default_factory`` must call
    ``Sam2Model.from_pretrained(<repo>)`` (NOT the legacy
    ``SAM2ImagePredictor`` from the sam2 git package)."""
    monkeypatch.setenv("SAM_MODEL", model_name)
    monkeypatch.setenv("SAM2_BACKEND", "transformers")

    p_mod._default_factory()  # noqa: SLF001

    assert fake_transformers_sam2_modules["model_repo"] == expected_repo
    assert fake_transformers_sam2_modules["proc_repo"] == expected_repo
    assert fake_transformers_sam2_modules["model_class"] == "Sam2Model"


def test_default_factory_sam3_unaffected_by_sam2_backend(monkeypatch):
    """``SAM2_BACKEND`` is a SAM 2.x toggle only — ``SAM_MODEL=sam3`` always
    routes through the SAM 3 adapter regardless of the SAM2_BACKEND value."""
    monkeypatch.setenv("SAM_MODEL", "sam3")
    monkeypatch.setenv("SAM2_BACKEND", "transformers")

    called = {"build": False}

    def _fake_build():
        called["build"] = True
        return object()

    def _noop_text():
        return lambda **_: []

    def _noop_box():
        return lambda **_: []

    monkeypatch.setattr(
        "carve_model.sam.sam3_adapter.build_sam3_image_predictor",
        _fake_build,
    )
    monkeypatch.setattr(
        "carve_model.sam.sam3_adapter.make_sam3_text_predictor",
        _noop_text,
    )
    monkeypatch.setattr(
        "carve_model.sam.sam3_adapter.make_sam3_box_predictor",
        _noop_box,
    )

    p_mod._default_factory()  # noqa: SLF001

    assert called["build"] is True
