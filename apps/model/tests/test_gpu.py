"""Smoke tests for gpu.py.

These tests must run on a CPU-only dev box (where ``torch`` may not even be
installed). They assert the fallback contract.
"""
from vaa_model.gpu import DeviceName, get_device, has_cuda, vram_free_mb


def test_get_device_returns_cpu_or_cuda() -> None:
    d: DeviceName = get_device()
    assert d in ("cpu", "cuda:0")


def test_vram_free_mb_returns_int_ge_zero() -> None:
    free = vram_free_mb()
    assert isinstance(free, int)
    assert free >= 0


def test_has_cuda_consistent_with_get_device() -> None:
    if has_cuda():
        assert get_device() == "cuda:0"
    else:
        assert get_device() == "cpu"


def test_get_device_is_deterministic() -> None:
    assert get_device() == get_device()
