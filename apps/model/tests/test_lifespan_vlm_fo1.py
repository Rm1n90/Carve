"""Tests for the VLM-FO1 lifespan-time registration gate in
``carve_model.main._maybe_register_vlm_fo1``.

Spec: feature is OFF by default. ``VLM_FO1_AVAILABLE=1`` (or ``true``/
``yes``) opts in. Anything else (unset, ``0``, ``false``, etc.) keeps
the filter slot empty so ``/sam/status.vlm_fo1_available`` is false.

A registration failure MUST NOT crash startup — the model service has
to keep serving SAM 3 even when FO1 can't load.
"""

from __future__ import annotations

from typing import Any

import pytest

from carve_model import main as main_mod
from carve_model.sam import predictor as predictor_mod


@pytest.fixture(autouse=True)
def _clean_filter_slot():
    predictor_mod.reset_vlm_fo1_filter()
    yield
    predictor_mod.reset_vlm_fo1_filter()


# --- gate semantics --------------------------------------------------------


def test_register_skipped_when_env_unset(monkeypatch):
    monkeypatch.delenv("VLM_FO1_AVAILABLE", raising=False)

    main_mod._maybe_register_vlm_fo1()

    assert predictor_mod.get_vlm_fo1_filter() is None


@pytest.mark.parametrize("value", ["0", "false", "no", "off", "FALSE"])
def test_register_skipped_for_falsy_values(monkeypatch, value):
    monkeypatch.setenv("VLM_FO1_AVAILABLE", value)

    main_mod._maybe_register_vlm_fo1()

    assert predictor_mod.get_vlm_fo1_filter() is None


@pytest.mark.parametrize("value", ["1", "true", "yes", "TRUE"])
def test_register_runs_for_truthy_values(monkeypatch, value):
    monkeypatch.setenv("VLM_FO1_AVAILABLE", value)

    captured: dict[str, Any] = {}

    def fake_make_filter(*, quant: str | None = None):
        captured["quant"] = quant
        return lambda **kw: []

    import carve_model.vlm_fo1 as vlm_pkg
    monkeypatch.setattr(vlm_pkg, "make_vlm_fo1_filter", fake_make_filter)

    main_mod._maybe_register_vlm_fo1()

    assert predictor_mod.get_vlm_fo1_filter() is not None
    assert "quant" in captured


# --- failure handling ------------------------------------------------------


def test_register_does_not_crash_when_make_filter_raises(monkeypatch):
    """Registration failures must be swallowed so startup keeps going."""
    monkeypatch.setenv("VLM_FO1_AVAILABLE", "1")

    def exploding_make(*_args, **_kwargs):
        raise RuntimeError("simulated import failure")

    import carve_model.vlm_fo1 as vlm_pkg
    monkeypatch.setattr(vlm_pkg, "make_vlm_fo1_filter", exploding_make)

    # Must not raise.
    main_mod._maybe_register_vlm_fo1()

    assert predictor_mod.get_vlm_fo1_filter() is None


def test_register_passes_quant_env_to_factory(monkeypatch):
    monkeypatch.setenv("VLM_FO1_AVAILABLE", "1")
    monkeypatch.setenv("VLM_FO1_QUANT", "4bit")

    captured: dict[str, Any] = {}

    def fake_make_filter(*, quant: str | None = None):
        captured["quant"] = quant
        return lambda **kw: []

    import carve_model.vlm_fo1 as vlm_pkg
    monkeypatch.setattr(vlm_pkg, "make_vlm_fo1_filter", fake_make_filter)

    main_mod._maybe_register_vlm_fo1()

    assert captured["quant"] == "4bit"


def test_register_passes_none_quant_when_env_unset(monkeypatch):
    monkeypatch.setenv("VLM_FO1_AVAILABLE", "1")
    monkeypatch.delenv("VLM_FO1_QUANT", raising=False)

    captured: dict[str, Any] = {}

    def fake_make_filter(*, quant: str | None = None):
        captured["quant"] = quant
        return lambda **kw: []

    import carve_model.vlm_fo1 as vlm_pkg
    monkeypatch.setattr(vlm_pkg, "make_vlm_fo1_filter", fake_make_filter)

    main_mod._maybe_register_vlm_fo1()

    assert captured["quant"] is None
