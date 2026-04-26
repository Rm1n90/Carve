"""Tests for the SAM model variant resolver.

The resolver lives in ``carve_model.sam.predictor`` and is the single source
of truth for which SAM checkpoint the image predictor should load. It
reads ``SAM_MODEL`` first and falls back to the legacy Plan 08
``SAM_VARIANT`` env var so existing operator setups keep working.
"""

import pytest

from carve_model.sam import predictor as p_mod


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    # Strip both env vars before each test so we always start from defaults
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
