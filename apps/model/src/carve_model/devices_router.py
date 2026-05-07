"""HTTP routes for the device manager (v3.25).

Endpoints:
  GET  /devices/status       — full probe + per-model effective device
  POST /devices/preference   — set the user's preferred device for one model
  POST /devices/sam/reload   — drop the loaded SAM model so it reloads on
                                the currently-preferred device

The api service mirrors these on its public surface (``/api/devices/*``)
so the web client can render the device picker and react to OOM /
unavailability rejections.
"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from carve_model import device_prefs
from carve_model.devices import (
    MIN_FREE_MB_DEFAULTS,
    DeviceInfo,
    DeviceResolution,
    probe_devices,
    resolve_device,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/devices", tags=["devices"])


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


class DeviceInfoOut(BaseModel):
    id: str
    kind: Literal["cuda", "mps", "cpu"]
    name: str
    available: bool
    total_mb: int
    free_mb: int
    reason: str = ""


class DeviceResolutionOut(BaseModel):
    device: str
    requested: str
    fallback_used: bool
    reason: str
    recommended: str


class ModelDeviceOut(BaseModel):
    """Per-model preference + the resolved (effective) device right now."""

    kind: str
    preference: str  # "auto" or the user's specific pick
    resolution: DeviceResolutionOut


class StatusOut(BaseModel):
    devices: list[DeviceInfoOut]
    recommended: str
    models: list[ModelDeviceOut]
    min_free_mb: dict[str, int]


class SetPreferenceIn(BaseModel):
    kind: Literal["sam", "yolo", "yoloe"]
    device: str = Field(..., description="'auto' or a specific id like 'cuda:0' / 'mps' / 'cpu'")


class SetPreferenceOut(BaseModel):
    """Echoes the resolved device + whether we honoured the request."""

    kind: str
    preference: str
    resolution: DeviceResolutionOut
    fallback_used: bool
    reason: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_out(d: DeviceInfo) -> DeviceInfoOut:
    return DeviceInfoOut(
        id=d.id,
        kind=d.kind,
        name=d.name,
        available=d.available,
        total_mb=d.total_mb,
        free_mb=d.free_mb,
        reason=d.reason,
    )


def _resolution_out(r: DeviceResolution) -> DeviceResolutionOut:
    return DeviceResolutionOut(
        device=r.device,
        requested=r.requested,
        fallback_used=r.fallback_used,
        reason=r.reason,
        recommended=r.recommended,
    )


def _model_status(kind: str, probe: list[DeviceInfo]) -> ModelDeviceOut:
    pref = device_prefs.get_pref(kind)
    min_free = MIN_FREE_MB_DEFAULTS.get(kind, MIN_FREE_MB_DEFAULTS["*"])
    res = resolve_device(pref, min_free_mb=min_free, probe=probe)
    return ModelDeviceOut(
        kind=kind,
        preference=pref or "auto",
        resolution=_resolution_out(res),
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/status", response_model=StatusOut)
def status() -> StatusOut:
    """Probe + per-model effective device."""
    probe = probe_devices()
    return StatusOut(
        devices=[_to_out(d) for d in probe],
        recommended=resolve_device(None, probe=probe).device,
        models=[_model_status(k, probe) for k in ("sam", "yolo", "yoloe")],
        min_free_mb=dict(MIN_FREE_MB_DEFAULTS),
    )


@router.post("/preference", response_model=SetPreferenceOut)
def set_preference(payload: SetPreferenceIn) -> SetPreferenceOut:
    """Update the preferred device for one model.

    Behaviour:
      * ``device == "auto"`` clears the preference; resolver picks best.
      * Specific device id is validated against the live probe. If the
        device is missing / OOM / unavailable, we still accept the
        preference but mark ``fallback_used`` and explain in ``reason``.
        The next predict call will use the recommended device — the
        frontend surfaces this and lets the user re-pick.
    """
    kind = payload.kind
    raw = payload.device.strip().lower()
    new_pref: str | None = None if raw in ("", "auto") else raw
    device_prefs.set_pref(kind, new_pref)

    probe = probe_devices()
    min_free = MIN_FREE_MB_DEFAULTS.get(kind, MIN_FREE_MB_DEFAULTS["*"])
    resolution = resolve_device(new_pref, min_free_mb=min_free, probe=probe)
    log.info(
        "device_preference kind=%s requested=%s -> device=%s fallback=%s",
        kind,
        raw or "auto",
        resolution.device,
        resolution.fallback_used,
    )
    return SetPreferenceOut(
        kind=kind,
        preference=new_pref or "auto",
        resolution=_resolution_out(resolution),
        fallback_used=resolution.fallback_used,
        reason=resolution.reason,
    )


@router.post("/sam/reload")
def sam_reload() -> dict:
    """Drop the loaded SAM image-predictor so it reloads on the chosen device.

    SAM is loaded once at startup with a baked-in device. Switching the
    SAM device requires unloading the model and letting the next
    /sam/* request recreate it on the new device. Idempotent: when no
    SAM model is loaded this is a no-op.
    """
    from carve_model.sam.predictor import force_evict_predictor

    try:
        evicted = force_evict_predictor()
    except Exception:  # noqa: BLE001 — never crash the API
        log.exception("sam reload eviction failed")
        evicted = False

    probe = probe_devices()
    pref = device_prefs.get_pref("sam")
    res = resolve_device(pref, min_free_mb=MIN_FREE_MB_DEFAULTS["sam"], probe=probe)
    return {
        "evicted": evicted,
        "device": res.device,
        "fallback_used": res.fallback_used,
        "reason": res.reason,
        "recommended": res.recommended,
    }
