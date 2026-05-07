"""Unit tests for the central device manager (carve_model.devices)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from carve_model.devices import (
    DeviceInfo,
    DeviceResolution,
    probe_devices,
    recommend_device,
    resolve_device,
)


def _cpu(free_mb: int = 0, total_mb: int = 0) -> DeviceInfo:
    return DeviceInfo(
        id="cpu",
        kind="cpu",
        name="CPU",
        available=True,
        total_mb=total_mb,
        free_mb=free_mb,
    )


def _cuda(idx: int, free_mb: int, total_mb: int = 24_000) -> DeviceInfo:
    return DeviceInfo(
        id=f"cuda:{idx}",
        kind="cuda",
        name=f"FakeGPU {idx}",
        available=True,
        total_mb=total_mb,
        free_mb=free_mb,
    )


def _mps(total_mb: int = 0, free_mb: int = 0) -> DeviceInfo:
    return DeviceInfo(
        id="mps",
        kind="mps",
        name="Apple Silicon (MPS)",
        available=True,
        total_mb=total_mb,
        free_mb=free_mb,
    )


# ---------------------------------------------------------------------------
# probe_devices — runs against the live host
# ---------------------------------------------------------------------------


def test_probe_always_includes_cpu() -> None:
    devs = probe_devices()
    assert any(d.kind == "cpu" for d in devs), "cpu must always be present"


# ---------------------------------------------------------------------------
# recommend_device — pure logic against a synthetic probe
# ---------------------------------------------------------------------------


def test_recommend_prefers_cuda_with_most_free() -> None:
    probe = [_cuda(0, free_mb=5_000), _cuda(1, free_mb=20_000), _cpu()]
    assert recommend_device(min_free_mb=512, probe=probe) == "cuda:1"


def test_recommend_skips_cuda_below_threshold() -> None:
    probe = [_cuda(0, free_mb=100), _mps(), _cpu()]
    # Single GPU with only 100 MiB free + 1 GiB threshold → MPS wins.
    assert recommend_device(min_free_mb=1024, probe=probe) == "mps"


def test_recommend_falls_back_to_cpu_when_nothing_fits() -> None:
    probe = [_cuda(0, free_mb=10), _cpu()]
    assert recommend_device(min_free_mb=8192, probe=probe) == "cpu"


def test_recommend_picks_mps_when_no_cuda() -> None:
    probe = [_mps(), _cpu()]
    assert recommend_device(min_free_mb=1024, probe=probe) == "mps"


# ---------------------------------------------------------------------------
# resolve_device — covers every fallback branch
# ---------------------------------------------------------------------------


def _resolve(pref: str | None, probe: list[DeviceInfo], min_free_mb: int = 512) -> DeviceResolution:
    return resolve_device(pref, min_free_mb=min_free_mb, probe=probe)


def test_resolve_auto_returns_recommended() -> None:
    probe = [_cuda(0, free_mb=20_000), _cpu()]
    r = _resolve("auto", probe)
    assert r.device == "cuda:0"
    assert r.fallback_used is False
    assert r.recommended == "cuda:0"


def test_resolve_none_is_treated_as_auto() -> None:
    probe = [_cuda(0, free_mb=20_000), _cpu()]
    r = _resolve(None, probe)
    assert r.requested == "auto"
    assert r.fallback_used is False


def test_resolve_specific_cuda_honoured_when_available() -> None:
    probe = [_cuda(0, free_mb=20_000), _cuda(1, free_mb=10_000), _cpu()]
    r = _resolve("cuda:1", probe, min_free_mb=4_000)
    assert r.device == "cuda:1"
    assert r.fallback_used is False
    # Recommended is "cuda:0" (more free), but the request was honoured.
    assert r.recommended == "cuda:0"


def test_resolve_unavailable_device_falls_back_with_reason() -> None:
    probe = [_cuda(0, free_mb=20_000), _cpu()]
    r = _resolve("cuda:99", probe)
    assert r.device == "cuda:0"
    assert r.fallback_used is True
    assert "not available" in r.reason
    assert "cuda:99" in r.reason


def test_resolve_mps_unavailable_on_cuda_host_falls_back() -> None:
    probe = [_cuda(0, free_mb=20_000), _cpu()]
    r = _resolve("mps", probe)
    assert r.device == "cuda:0"
    assert r.fallback_used is True
    assert "mps" in r.reason


def test_resolve_oom_cuda_falls_back_to_cpu() -> None:
    probe = [_cuda(0, free_mb=200), _cpu()]
    r = _resolve("cuda:0", probe, min_free_mb=4_000)
    assert r.device == "cpu"
    assert r.fallback_used is True
    assert "200" in r.reason
    assert "4000" in r.reason


def test_resolve_cpu_always_honoured() -> None:
    probe = [_cuda(0, free_mb=20_000), _cpu()]
    r = _resolve("cpu", probe, min_free_mb=99_999_999)
    assert r.device == "cpu"
    assert r.fallback_used is False


def test_resolve_bare_cuda_picks_first_eligible() -> None:
    probe = [_cuda(0, free_mb=200), _cuda(1, free_mb=20_000), _cpu()]
    r = _resolve("cuda", probe, min_free_mb=1_000)
    assert r.device == "cuda:1"
    assert r.fallback_used is False


def test_resolve_bare_cuda_falls_back_when_no_cuda() -> None:
    probe = [_mps(), _cpu()]
    r = _resolve("cuda", probe)
    assert r.device == "mps"
    assert r.fallback_used is True


def test_resolve_uppercase_normalised() -> None:
    probe = [_cuda(0, free_mb=20_000), _cpu()]
    r = _resolve("CUDA:0", probe)
    assert r.device == "cuda:0"
    assert r.fallback_used is False


def test_resolve_mps_with_unknown_memory_passes_threshold() -> None:
    """MPS without memory reporting (total_mb == 0) is allowed."""
    probe = [_mps(total_mb=0), _cpu()]
    r = _resolve("mps", probe, min_free_mb=99_999_999)
    assert r.device == "mps"
    assert r.fallback_used is False


def test_resolve_preserves_recommended_in_fallback_path() -> None:
    """Even when falling back, the resolution carries the recommended id
    so the UI can suggest the right next pick."""
    probe = [_cuda(0, free_mb=20_000), _cpu()]
    r = _resolve("cuda:99", probe)
    assert r.recommended == "cuda:0"
    assert r.device == "cuda:0"
