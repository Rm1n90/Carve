"""Smoke tests for the gpu compat shim (v3.25 — backed by carve_model.devices).

These tests must run on a CPU-only dev box (where ``torch`` may not even be
installed). They assert the fallback contract; the broader behaviour
matrix lives in ``test_devices.py``.
"""
from carve_model.gpu import get_device, has_cuda, vram_free_mb


def test_get_device_returns_well_formed_id() -> None:
    d = get_device()
    assert d == "cpu" or d == "mps" or d.startswith("cuda:"), d


def test_vram_free_mb_returns_int_ge_zero() -> None:
    free = vram_free_mb()
    assert isinstance(free, int)
    assert free >= 0


def test_has_cuda_consistent_with_get_device() -> None:
    if has_cuda():
        assert get_device().startswith("cuda:")
    else:
        # has_cuda() is False → device is mps or cpu (any non-cuda).
        assert not get_device().startswith("cuda")


def test_get_device_is_deterministic() -> None:
    assert get_device() == get_device()
