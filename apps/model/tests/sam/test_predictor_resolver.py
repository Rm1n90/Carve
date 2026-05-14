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
    # As of v3.4 commit 6 the SAM 2 backend is transformers-only; there is
    # no legacy toggle to clear.
    monkeypatch.delenv("SAM_MODEL", raising=False)
    monkeypatch.delenv("SAM_VARIANT", raising=False)


def test_default_is_sam2_1_large():
    assert p_mod.get_sam_model() == "sam2.1-large"
    assert p_mod.get_sam_variant() == "sam2"


@pytest.mark.parametrize("name", [
    "sam2.1-tiny",
    "sam2.1-small",
    "sam2.1-base-plus",
    "sam2.1-large",
    "sam3.1",
])
def test_each_allowed_model_resolves(monkeypatch, name):
    monkeypatch.setenv("SAM_MODEL", name)
    p_mod._SAM3_WARNED = False  # noqa: SLF001 — reset warn-once for test isolation
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
    """Plan 08's ``SAM_VARIANT=sam3`` must still flip the variant.

    Phase 6: ``sam3`` auto-remaps to ``sam3.1``; both still resolve to the
    sam3 family.
    """
    monkeypatch.setenv("SAM_VARIANT", "sam3")
    p_mod._SAM3_WARNED = False  # noqa: SLF001 — reset warn-once for test isolation
    assert p_mod.get_sam_model() == "sam3.1"
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


# --- SAM 2 transformers backend (v3.4 commit 6: legacy path removed) --------


@pytest.fixture
def fake_transformers_sam2_modules(monkeypatch):
    """Stub the transformers ``Sam2Model`` + ``Sam2Processor`` classes so
    ``_default_factory`` can build the transformers-backed adapter without
    loading torch or pulling weights."""
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


@pytest.mark.parametrize("model_name,expected_repo", [
    ("sam2.1-tiny",      "facebook/sam2.1-hiera-tiny"),
    ("sam2.1-small",     "facebook/sam2.1-hiera-small"),
    ("sam2.1-base-plus", "facebook/sam2.1-hiera-base-plus"),
    ("sam2.1-large",     "facebook/sam2.1-hiera-large"),
])
def test_default_factory_uses_transformers_path_for_each_sam2_variant(
    monkeypatch, fake_transformers_sam2_modules, model_name, expected_repo,
):
    """Every SAM 2.x model must route through ``Sam2Model.from_pretrained``
    on the transformers backend. The legacy ``sam2`` git path no longer
    exists (removed in v3.4 commit 6)."""
    monkeypatch.setenv("SAM_MODEL", model_name)

    p_mod._default_factory()  # noqa: SLF001 — exercising module-private factory

    assert fake_transformers_sam2_modules["model_repo"] == expected_repo
    assert fake_transformers_sam2_modules["proc_repo"] == expected_repo
    assert fake_transformers_sam2_modules["model_class"] == "Sam2Model"


def test_default_factory_routes_sam3p1_through_sam3p1_adapter(monkeypatch):
    """``SAM_MODEL=sam3.1`` must route through the SAM 3.1 adapter.

    Task 6.2 removed the legacy ``sam3`` branch from ``_default_factory``;
    ``SAM_MODEL=sam3`` is auto-remapped to ``sam3.1`` via the deprecation
    logic in ``get_sam_model``.
    """
    monkeypatch.setenv("SAM_MODEL", "sam3.1")

    called = {"build": False}

    def _fake_build(device=None):
        called["build"] = True
        return object()

    monkeypatch.setattr(
        "carve_model.sam.sam3p1_adapter.build_sam3p1_image_predictor",
        _fake_build,
    )

    p_mod._default_factory()  # noqa: SLF001

    assert called["build"] is True
