"""Tests for the optional torch.compile gate around SAM models.

These tests exercise the gate logic only — they do NOT actually invoke
``torch.compile`` (which would require a CUDA + Triton stack). The gate
combines the ``SAM_COMPILE`` env toggle (default off) with runtime CUDA
availability and must fail-open when ``torch.compile`` errors so that
incompatible hardware/drivers never prevent SAM from loading.
"""

import sys
from types import ModuleType, SimpleNamespace

import pytest

from vaa_model.sam import predictor as p_mod


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    monkeypatch.delenv("SAM_COMPILE", raising=False)
    yield


def test_use_compile_default_false():
    """Default-off: SAM_COMPILE unset → no compile."""
    assert p_mod.use_compile() is False


def test_use_compile_disabled_via_env(monkeypatch):
    monkeypatch.setenv("SAM_COMPILE", "0")
    assert p_mod.use_compile() is False


@pytest.mark.parametrize("value", ["1", "true", "yes", "on"])
def test_use_compile_truthy_strings_with_torch(monkeypatch, value):
    fake_torch = ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(is_available=lambda: True)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setenv("SAM_COMPILE", value)
    assert p_mod.use_compile() is True


def test_use_compile_false_when_torch_unavailable(monkeypatch):
    """No torch installed → use_compile returns False (fail open)."""
    monkeypatch.setenv("SAM_COMPILE", "1")
    # Test env has no torch installed → use_compile returns False
    assert p_mod.use_compile() is False


def test_use_compile_false_when_cuda_unavailable(monkeypatch):
    fake_torch = ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(is_available=lambda: False)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setenv("SAM_COMPILE", "1")
    assert p_mod.use_compile() is False


def test_maybe_compile_returns_input_when_disabled():
    """When the gate is off, maybe_compile is the identity function."""
    sentinel = object()
    assert p_mod.maybe_compile(sentinel) is sentinel


def test_maybe_compile_returns_compiled_when_enabled(monkeypatch):
    fake_torch = ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(is_available=lambda: True)
    captured: dict = {}

    def _fake_compile(m, mode):
        captured["called_with"] = (m, mode)
        return ("compiled", m)

    fake_torch.compile = _fake_compile
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setenv("SAM_COMPILE", "1")
    sentinel = object()
    result = p_mod.maybe_compile(sentinel)
    assert result == ("compiled", sentinel)
    assert captured["called_with"] == (sentinel, "reduce-overhead")


def test_maybe_compile_fails_open_on_torch_error(monkeypatch):
    """If torch.compile raises (Triton missing, etc.), return uncompiled model."""
    fake_torch = ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(is_available=lambda: True)

    def _boom(*args, **kw):
        raise RuntimeError("triton not found")

    fake_torch.compile = _boom
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setenv("SAM_COMPILE", "1")
    sentinel = object()
    # Should NOT raise; should return the original model.
    assert p_mod.maybe_compile(sentinel) is sentinel
