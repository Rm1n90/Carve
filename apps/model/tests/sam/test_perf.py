import numpy as np
import torch

from carve_model.sam import perf


def test_get_dtype_bf16(monkeypatch):
    monkeypatch.setenv("SAM_DTYPE", "bf16")
    assert perf.get_dtype() is torch.bfloat16


def test_get_dtype_fp16(monkeypatch):
    monkeypatch.setenv("SAM_DTYPE", "fp16")
    assert perf.get_dtype() is torch.float16


def test_get_dtype_fp32(monkeypatch):
    monkeypatch.setenv("SAM_DTYPE", "fp32")
    assert perf.get_dtype() is torch.float32


def test_get_dtype_default_falls_back_when_unrecognised(monkeypatch):
    monkeypatch.setenv("SAM_DTYPE", "nonsense")
    expected = torch.bfloat16 if perf.get_device() == "cuda" else torch.float32
    assert perf.get_dtype() is expected


def test_attn_impl_default_sdpa(monkeypatch):
    monkeypatch.delenv("SAM_ATTN_IMPL", raising=False)
    assert perf.get_attn_impl() == "sdpa"


def test_attn_impl_eager(monkeypatch):
    monkeypatch.setenv("SAM_ATTN_IMPL", "eager")
    assert perf.get_attn_impl() == "eager"


def test_attn_impl_falls_back_when_flash_attn_missing(monkeypatch):
    monkeypatch.setenv("SAM_ATTN_IMPL", "flash_attention_2")
    monkeypatch.setattr(perf, "_flash_attn_available", lambda: False)
    assert perf.get_attn_impl() == "sdpa"


def test_compile_enabled_truthy(monkeypatch):
    for v in ("true", "TRUE", "1", "yes"):
        monkeypatch.setenv("SAM_COMPILE", v)
        assert perf.get_compile_enabled() is True


def test_compile_enabled_default_false(monkeypatch):
    monkeypatch.delenv("SAM_COMPILE", raising=False)
    assert perf.get_compile_enabled() is False


def test_to_numpy_safe_bf16():
    t = torch.tensor([1.0, 2.0], dtype=torch.bfloat16)
    arr = perf.to_numpy_safe(t)
    assert arr.dtype == np.float32


def test_to_numpy_safe_already_numpy():
    a = np.array([1, 2, 3], dtype=np.int32)
    out = perf.to_numpy_safe(a)
    assert out is a or np.array_equal(out, a)
