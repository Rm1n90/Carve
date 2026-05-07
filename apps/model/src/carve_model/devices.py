"""Central compute-device manager (v3.25).

Replaces the older ``gpu.py`` (kept as a thin compat shim re-exporting
from this module) with a single source of truth for:

  * probing available devices (CUDA, MPS / Apple Silicon, CPU)
  * reporting free / total memory per device
  * resolving a user preference into a concrete device id, with a
    transparent fallback explanation when the preference can't be
    honoured (OOM, missing driver, missing torch, …)
  * a recommended-device heuristic (cuda > mps > cpu, gated by a
    minimum free-memory threshold)

Torch is imported lazily inside every function so the module stays
importable on a CPU-only dev box where torch isn't installed. All
public functions degrade to "cpu only" cleanly when that happens.

Threading: the module is stateless. Per-model preferences live in
``device_prefs.py`` and are stored under a lock there.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal

log = logging.getLogger(__name__)

# Public type aliases ---------------------------------------------------------

DeviceKind = Literal["cuda", "mps", "cpu"]

# Sensible per-model minimum free VRAM thresholds. The frontend echoes
# these so the user understands why a request might be rejected. Tune
# as model sizes change. SAM 2.1-large + YOLOE-26L-seg both fit under
# ~3 GiB at fp16/bf16; YOLOv11 weights are tiny but Ultralytics keeps
# scratch buffers around ~500 MiB.
MIN_FREE_MB_DEFAULTS: dict[str, int] = {
    "sam": 3072,
    "yoloe": 1536,
    "yolo": 512,
    # Generic fallback when the caller doesn't know which model it is.
    "*": 512,
}


@dataclass(frozen=True)
class DeviceInfo:
    """Snapshot of a single compute device."""

    id: str  # "cuda:0", "cuda:1", "mps", "cpu"
    kind: DeviceKind
    name: str  # human readable, e.g. "NVIDIA RTX 3090" / "Apple M2 Max"
    available: bool
    total_mb: int  # 0 when unknown / cpu
    free_mb: int  # 0 when unknown / cpu
    reason: str = ""  # why unavailable (empty when available)


@dataclass(frozen=True)
class DeviceResolution:
    """Outcome of resolving a user preference into a concrete device.

    The frontend uses this directly to surface accurate toasts:
    e.g. "You asked for cuda:0 but it has 250 MB free, which isn't
    enough for SAM (needs 3 GB). Falling back to cpu."
    """

    device: str  # final, validated device id ("cuda:0", "mps", "cpu")
    requested: str  # what the caller asked for ("auto" | "cuda:0" | …)
    fallback_used: bool  # True when device != requested
    reason: str  # human-friendly explanation
    recommended: str  # what we'd recommend independent of `requested`


# ---------------------------------------------------------------------------
# Probe
# ---------------------------------------------------------------------------


def _torch():
    """Lazy torch import — returns the module or None if torch isn't installed."""
    try:
        import torch  # type: ignore[import-not-found]

        return torch
    except ImportError:
        return None


def _probe_cuda(torch_mod) -> list[DeviceInfo]:
    out: list[DeviceInfo] = []
    if not torch_mod.cuda.is_available():
        return out
    try:
        count = torch_mod.cuda.device_count()
    except Exception as exc:  # noqa: BLE001
        log.warning("cuda.device_count failed: %s", exc)
        return out
    for idx in range(count):
        try:
            props = torch_mod.cuda.get_device_properties(idx)
            total_mb = int(props.total_memory // (1024 * 1024))
            try:
                free, _total = torch_mod.cuda.mem_get_info(idx)
                free_mb = int(free // (1024 * 1024))
            except Exception:
                free_mb = total_mb  # best-effort fallback
            out.append(
                DeviceInfo(
                    id=f"cuda:{idx}",
                    kind="cuda",
                    name=props.name,
                    available=True,
                    total_mb=total_mb,
                    free_mb=free_mb,
                )
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("cuda probe idx=%d failed: %s", idx, exc)
    return out


def _probe_mps(torch_mod) -> DeviceInfo | None:
    """Probe Apple Silicon MPS. Available only on macOS arm64 with PyTorch.

    Memory is best-effort: ``torch.mps.recommended_max_memory()`` (PyTorch
    >= 2.0) returns the unified-memory budget the driver suggests; we
    treat it as the "total" and don't separately report free since MPS
    shares system RAM. When the function isn't available we report 0
    and let the validator fall back to "available, memory unknown".
    """
    backends = getattr(torch_mod, "backends", None)
    mps_back = getattr(backends, "mps", None) if backends else None
    if mps_back is None or not getattr(mps_back, "is_available", lambda: False)():
        return None
    if not getattr(mps_back, "is_built", lambda: False)():
        return None
    total_mb = 0
    free_mb = 0
    mps_mod = getattr(torch_mod, "mps", None)
    if mps_mod is not None:
        try:
            rec = mps_mod.recommended_max_memory()  # bytes
            total_mb = int(rec // (1024 * 1024))
            try:
                used = mps_mod.driver_allocated_memory()
                free_mb = max(0, total_mb - int(used // (1024 * 1024)))
            except Exception:
                free_mb = total_mb
        except Exception:
            pass  # best-effort
    return DeviceInfo(
        id="mps",
        kind="mps",
        name="Apple Silicon (MPS)",
        available=True,
        total_mb=total_mb,
        free_mb=free_mb,
    )


def _probe_cpu() -> DeviceInfo:
    # CPU is always available. We don't try to report system RAM here —
    # callers that care about CPU OOM should use psutil; for our minimum
    # threshold logic, cpu is treated as "infinite" (the validator
    # special-cases it).
    name = "CPU"
    try:
        import platform

        proc = platform.processor() or platform.machine() or "CPU"
        if proc:
            name = f"CPU ({proc})"
    except Exception:
        pass
    return DeviceInfo(
        id="cpu",
        kind="cpu",
        name=name,
        available=True,
        total_mb=0,
        free_mb=0,
    )


def probe_devices() -> list[DeviceInfo]:
    """Return every device the host can plausibly use.

    Order: CUDA devices first (one entry per GPU), then MPS if the host
    is Apple Silicon, then CPU. The ordering is the recommendation
    fallback chain — see ``recommend_device``.
    """
    torch_mod = _torch()
    if torch_mod is None:
        return [
            DeviceInfo(
                id="cpu",
                kind="cpu",
                name="CPU",
                available=True,
                total_mb=0,
                free_mb=0,
                reason="torch not installed",
            )
        ]
    devices: list[DeviceInfo] = []
    devices.extend(_probe_cuda(torch_mod))
    mps = _probe_mps(torch_mod)
    if mps is not None:
        devices.append(mps)
    devices.append(_probe_cpu())
    return devices


# ---------------------------------------------------------------------------
# Recommend / resolve
# ---------------------------------------------------------------------------


def _device_kind(device_id: str) -> DeviceKind:
    if device_id.startswith("cuda"):
        return "cuda"
    if device_id == "mps":
        return "mps"
    return "cpu"


def _find(probe: list[DeviceInfo], device_id: str) -> DeviceInfo | None:
    for d in probe:
        if d.id == device_id:
            return d
    return None


def _has_enough_memory(d: DeviceInfo, min_free_mb: int) -> bool:
    """CPU is treated as 'infinite'; MPS with unknown memory passes too.

    For CUDA devices we enforce the threshold strictly so we don't
    silently let a request go to a near-OOM GPU.
    """
    if d.kind == "cpu":
        return True
    if d.kind == "mps" and d.total_mb == 0:
        # MPS without memory reporting — best-effort, allow.
        return True
    return d.free_mb >= min_free_mb


def recommend_device(min_free_mb: int = 512, probe: list[DeviceInfo] | None = None) -> str:
    """Pick the best device available right now.

    Order of preference: CUDA (highest free memory first) > MPS > CPU.
    A CUDA device is only chosen when it has at least ``min_free_mb``
    of free memory; otherwise we fall back to the next option.
    """
    devs = probe if probe is not None else probe_devices()
    # CUDA — pick the one with the most free memory that meets the
    # threshold. Multi-GPU hosts get sensible default placement.
    cuda_eligible = sorted(
        (d for d in devs if d.kind == "cuda" and d.available and _has_enough_memory(d, min_free_mb)),
        key=lambda d: d.free_mb,
        reverse=True,
    )
    if cuda_eligible:
        return cuda_eligible[0].id
    for d in devs:
        if d.kind == "mps" and d.available:
            return d.id
    return "cpu"


def resolve_device(
    preference: str | None,
    min_free_mb: int = 512,
    probe: list[DeviceInfo] | None = None,
) -> DeviceResolution:
    """Turn a user preference into a concrete, validated device id.

    ``preference`` semantics:

    * ``None`` or ``"auto"`` — pick the best device automatically.
    * ``"cuda"`` (no index) — first eligible CUDA device, else fall back.
    * ``"cuda:N"`` — that exact CUDA device, validated.
    * ``"mps"`` — MPS, validated.
    * ``"cpu"`` — CPU (always honoured).
    * Anything else — treated as ``"auto"`` with a warning in ``reason``.

    The function never raises for OOM or unavailability; instead it
    falls back and reports the reason in the returned ``DeviceResolution``
    so the API layer can surface it to the user verbatim.
    """
    devs = probe if probe is not None else probe_devices()
    recommended = recommend_device(min_free_mb=min_free_mb, probe=devs)

    raw = (preference or "auto").strip().lower()
    if raw in ("", "auto"):
        return DeviceResolution(
            device=recommended,
            requested="auto",
            fallback_used=False,
            reason=f"Auto-selected {recommended}.",
            recommended=recommended,
        )

    # Bare "cuda" → first eligible CUDA card.
    if raw == "cuda":
        cuda = [d for d in devs if d.kind == "cuda" and d.available]
        if not cuda:
            return DeviceResolution(
                device=recommended,
                requested=raw,
                fallback_used=True,
                reason=(
                    "No CUDA device available on this host. "
                    f"Falling back to {recommended}."
                ),
                recommended=recommended,
            )
        cuda_eligible = [d for d in cuda if _has_enough_memory(d, min_free_mb)]
        if not cuda_eligible:
            tightest = max(cuda, key=lambda d: d.free_mb)
            return DeviceResolution(
                device=recommended,
                requested=raw,
                fallback_used=True,
                reason=(
                    f"No CUDA device has the required {min_free_mb} MiB free "
                    f"(best is {tightest.id} with {tightest.free_mb} MiB). "
                    f"Falling back to {recommended}."
                ),
                recommended=recommended,
            )
        chosen = sorted(cuda_eligible, key=lambda d: d.free_mb, reverse=True)[0]
        return DeviceResolution(
            device=chosen.id,
            requested=raw,
            fallback_used=False,
            reason=f"Using {chosen.id} ({chosen.free_mb} MiB free).",
            recommended=recommended,
        )

    # Specific device id ("cuda:0", "mps", "cpu") — must exist + be eligible.
    found = _find(devs, raw)
    if found is None:
        return DeviceResolution(
            device=recommended,
            requested=raw,
            fallback_used=True,
            reason=(
                f"Device {raw!r} is not available on this host. "
                f"Falling back to {recommended}."
            ),
            recommended=recommended,
        )
    if not found.available:
        return DeviceResolution(
            device=recommended,
            requested=raw,
            fallback_used=True,
            reason=(
                f"Device {raw} is not available: {found.reason or 'unknown reason'}. "
                f"Falling back to {recommended}."
            ),
            recommended=recommended,
        )
    if not _has_enough_memory(found, min_free_mb):
        return DeviceResolution(
            device=recommended,
            requested=raw,
            fallback_used=True,
            reason=(
                f"Device {raw} has only {found.free_mb} MiB free; "
                f"this model needs at least {min_free_mb} MiB. "
                f"Falling back to {recommended}."
            ),
            recommended=recommended,
        )
    return DeviceResolution(
        device=found.id,
        requested=raw,
        fallback_used=False,
        reason=(
            f"Using {found.id}"
            + (f" ({found.free_mb} MiB free)" if found.free_mb > 0 else "")
            + "."
        ),
        recommended=recommended,
    )


# ---------------------------------------------------------------------------
# Backward-compat helpers (kept so older code paths still work)
# ---------------------------------------------------------------------------


def get_device() -> str:
    """Best-available device with no caller preference. Cuda > mps > cpu."""
    return recommend_device()


def has_cuda() -> bool:
    return get_device().startswith("cuda")


def vram_free_mb(device_id: str | None = None) -> int:
    """Free memory in MiB on the given (or active) device. 0 when N/A."""
    devs = probe_devices()
    target = device_id or recommend_device()
    found = _find(devs, target)
    return found.free_mb if found else 0
