"""Tests for the bf16 autocast gate around SAM inference.

These tests exercise the gate logic only — they do NOT verify that
torch.autocast actually changes dtypes on GPU (we trust PyTorch). The
gate combines a hardware capability check with the ``SAM_BF16`` env
toggle and must fail-open when torch is unavailable so the model dev
venv (no torch installed) keeps working.
"""

import sys
from types import ModuleType, SimpleNamespace

import pytest

from vaa_model.sam import predictor as p_mod


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    monkeypatch.delenv("SAM_BF16", raising=False)
    yield


def test_use_bf16_default_when_torch_unavailable():
    """No torch installed → no bf16 (graceful no-op)."""
    # Default behaviour on a torch-less dev box: SAM_BF16 unset, no torch
    # import, ``use_bf16`` returns False.
    assert p_mod.use_bf16() is False


def test_use_bf16_disabled_via_env(monkeypatch):
    monkeypatch.setenv("SAM_BF16", "0")
    assert p_mod.use_bf16() is False


@pytest.mark.parametrize("value", ["false", "no", "off", "0", ""])
def test_use_bf16_falsey_strings_disable(monkeypatch, value):
    monkeypatch.setenv("SAM_BF16", value)
    assert p_mod.use_bf16() is False


def test_use_bf16_returns_true_when_cuda_and_bf16_supported(monkeypatch):
    fake_torch = ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(
        is_available=lambda: True,
        is_bf16_supported=lambda: True,
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setenv("SAM_BF16", "1")
    assert p_mod.use_bf16() is True


def test_use_bf16_false_when_cuda_unavailable(monkeypatch):
    fake_torch = ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(
        is_available=lambda: False,
        is_bf16_supported=lambda: True,
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setenv("SAM_BF16", "1")
    assert p_mod.use_bf16() is False


def test_use_bf16_false_when_bf16_unsupported(monkeypatch):
    fake_torch = ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(
        is_available=lambda: True,
        is_bf16_supported=lambda: False,
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setenv("SAM_BF16", "1")
    assert p_mod.use_bf16() is False


def test_autocast_ctx_no_op_when_disabled():
    """When ``use_bf16`` returns False, ``autocast_ctx`` should be a passthrough."""
    with p_mod.autocast_ctx():
        x = 1 + 1
    assert x == 2


def test_autocast_ctx_engages_when_enabled(monkeypatch):
    """When ``use_bf16`` returns True, ``autocast_ctx`` enters torch.autocast."""
    entered = {"called": False, "device_type": None, "dtype": None}

    class _FakeAutocast:
        def __init__(self, device_type, dtype):
            entered["called"] = True
            entered["device_type"] = device_type
            entered["dtype"] = dtype

        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

    fake_torch = ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(
        is_available=lambda: True,
        is_bf16_supported=lambda: True,
    )
    fake_torch.autocast = _FakeAutocast
    fake_torch.bfloat16 = "bfloat16"  # sentinel
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setenv("SAM_BF16", "1")

    with p_mod.autocast_ctx():
        pass

    assert entered["called"] is True
    assert entered["device_type"] == "cuda"
    assert entered["dtype"] == "bfloat16"


def test_autocast_ctx_swallows_torch_errors(monkeypatch):
    """If autocast itself raises, the context is still usable."""

    class _BoomAutocast:
        def __init__(self, *_a, **_kw):
            raise RuntimeError("torch internal")

    fake_torch = ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(
        is_available=lambda: True,
        is_bf16_supported=lambda: True,
    )
    fake_torch.autocast = _BoomAutocast
    fake_torch.bfloat16 = "bfloat16"
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setenv("SAM_BF16", "1")

    # Should NOT raise — autocast_ctx swallows the error and proceeds without
    # autocast.
    with p_mod.autocast_ctx():
        x = 2 + 2
    assert x == 4
