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

    def fake_make_filter(*, model_path: str = "", quant: str | None = None, **_):
        captured["quant"] = quant
        captured["model_path"] = model_path
        return lambda **kw: []

    import carve_model.vlm_fo1 as vlm_pkg
    monkeypatch.setattr(vlm_pkg, "make_vlm_fo1_filter", fake_make_filter)
    # v3.21+ — _maybe_register_vlm_fo1 now probes whether the upstream
    # vlm_fo1 package is importable before registering. In dev the
    # package isn't installed, so we stub the probe to simulate a
    # successful detect.
    monkeypatch.setattr(
        main_mod, "_vlm_fo1_can_load", lambda _path: (True, "test-stub"),
    )

    main_mod._maybe_register_vlm_fo1()

    assert predictor_mod.get_vlm_fo1_filter() is not None
    assert "quant" in captured


# --- failure handling ------------------------------------------------------


def test_register_does_not_crash_when_make_filter_raises(monkeypatch):
    """Registration failures must be swallowed so startup keeps going."""
    monkeypatch.setenv("VLM_FO1_AVAILABLE", "1")
    monkeypatch.setattr(
        main_mod, "_vlm_fo1_can_load", lambda _path: (True, "test-stub"),
    )

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

    def fake_make_filter(*, model_path: str = "", quant: str | None = None, **_):
        captured["quant"] = quant
        captured["model_path"] = model_path
        return lambda **kw: []

    import carve_model.vlm_fo1 as vlm_pkg
    monkeypatch.setattr(vlm_pkg, "make_vlm_fo1_filter", fake_make_filter)
    # v3.21+ — _maybe_register_vlm_fo1 now probes whether the upstream
    # vlm_fo1 package is importable before registering. In dev the
    # package isn't installed, so we stub the probe to simulate a
    # successful detect.
    monkeypatch.setattr(
        main_mod, "_vlm_fo1_can_load", lambda _path: (True, "test-stub"),
    )

    main_mod._maybe_register_vlm_fo1()

    assert captured["quant"] == "4bit"


def test_register_skipped_when_probe_reports_unavailable(monkeypatch):
    """When the upstream vlm_fo1 package isn't installed (or some other
    capability check fails), the probe must short-circuit the
    registration so /sam/status reports false and the editor toggle stays
    hidden — instead of registering a filter that silently degrades."""
    monkeypatch.setenv("VLM_FO1_AVAILABLE", "1")
    monkeypatch.setattr(
        main_mod,
        "_vlm_fo1_can_load",
        lambda _path: (False, "vlm_fo1 package not installed"),
    )

    def make_filter_should_not_run(*_args, **_kwargs):
        raise AssertionError("make_vlm_fo1_filter should not be called")

    import carve_model.vlm_fo1 as vlm_pkg
    monkeypatch.setattr(
        vlm_pkg, "make_vlm_fo1_filter", make_filter_should_not_run,
    )

    main_mod._maybe_register_vlm_fo1()

    assert predictor_mod.get_vlm_fo1_filter() is None


def test_register_passes_none_quant_when_env_unset(monkeypatch):
    monkeypatch.setenv("VLM_FO1_AVAILABLE", "1")
    monkeypatch.delenv("VLM_FO1_QUANT", raising=False)

    captured: dict[str, Any] = {}

    def fake_make_filter(*, model_path: str = "", quant: str | None = None, **_):
        captured["quant"] = quant
        captured["model_path"] = model_path
        return lambda **kw: []

    import carve_model.vlm_fo1 as vlm_pkg
    monkeypatch.setattr(vlm_pkg, "make_vlm_fo1_filter", fake_make_filter)
    # v3.21+ — _maybe_register_vlm_fo1 now probes whether the upstream
    # vlm_fo1 package is importable before registering. In dev the
    # package isn't installed, so we stub the probe to simulate a
    # successful detect.
    monkeypatch.setattr(
        main_mod, "_vlm_fo1_can_load", lambda _path: (True, "test-stub"),
    )

    main_mod._maybe_register_vlm_fo1()

    assert captured["quant"] is None
