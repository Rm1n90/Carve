"""HTTP proxy for the model service's /devices/* routes (v3.25).

The api service doesn't have its own torch / device awareness — every
device decision is delegated to the model container which actually
runs the inference. We forward shape-for-shape and surface any model
service error verbatim so the frontend can render the smart-fallback
explanation directly.

Endpoints:
  GET  /devices/status       — probe + per-model effective device
  POST /devices/preference   — body {kind, device}; "auto" or specific
  POST /devices/sam/reload   — drop SAM so it reloads on the chosen device
"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from carve_api.deps import get_current_user
from carve_api.permissions import gpu_admin_guard
from carve_api.inference.model_client import _client, _wrap_unreachable

log = logging.getLogger(__name__)

router = APIRouter(prefix="/devices", tags=["devices"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class SetPreferenceIn(BaseModel):
    kind: Literal["sam", "yolo", "yoloe"]
    device: str = Field(..., description="'auto' or a specific id like 'cuda:0' / 'mps' / 'cpu'")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/status")
def status(_user=Depends(get_current_user)) -> dict:
    """Forward the model service's full device snapshot."""
    with _wrap_unreachable("devices_status"), _client() as c:
        r = c.get("/devices/status")
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=r.json())
        return r.json()


@router.post("/preference")
def set_preference(
    payload: SetPreferenceIn,
    # Outsourcing hardening — device preference is workspace-wide (it
    # repoints the shared model service), so the per-task AI grant does
    # not apply. Admin only.
    _user=Depends(gpu_admin_guard),
) -> dict:
    """Update the user's preferred device for one model.

    The model service never rejects the preference outright — it
    accepts and explains via ``fallback_used`` + ``reason`` when the
    requested device isn't usable (OOM, missing, etc). The frontend
    surfaces the explanation as a toast so the user understands what
    we did.
    """
    with _wrap_unreachable("devices_preference"), _client() as c:
        r = c.post(
            "/devices/preference",
            json={"kind": payload.kind, "device": payload.device},
        )
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=r.json())
        return r.json()


@router.post("/sam/reload")
def sam_reload(_user=Depends(gpu_admin_guard)) -> dict:
    """Drop the loaded SAM so it reloads on the currently-preferred device."""
    with _wrap_unreachable("devices_sam_reload"), _client() as c:
        try:
            r = c.post("/devices/sam/reload", timeout=None)
        except TypeError:
            r = c.post("/devices/sam/reload")
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=r.json())
        return r.json()
