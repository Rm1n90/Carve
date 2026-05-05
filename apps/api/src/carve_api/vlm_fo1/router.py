"""Per-user VLM-FO1 precision-filter toggle.

Mirrors the per-user shortcuts pattern (``apps/api/src/carve_api/
shortcuts/router.py``) — small, focused, two endpoints:

  - GET  /me/vlm-fo1 → ``{enabled: bool}``
  - PUT  /me/vlm-fo1 body ``{enabled: bool}`` → ``{enabled: bool}``

The user's stored value gates whether the editor opts /sam/text-prompt
and Auto-mode requests into the VLM-FO1 server-side filter. The
toggle is **hidden** in the UI when the model service reports
``vlm_fo1_available=false`` via ``/models/sam-status``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db


router = APIRouter(prefix="/me/vlm-fo1", tags=["vlm_fo1"])


class VlmFo1Pref(BaseModel):
    """Per-user VLM-FO1 toggle payload (request + response)."""

    enabled: bool


@router.get("", response_model=VlmFo1Pref)
def get_vlm_fo1_pref(
    user: User = Depends(get_current_user),
    _db: Session = Depends(get_db),
) -> VlmFo1Pref:
    """Return the calling user's VLM-FO1 toggle state."""
    return VlmFo1Pref(enabled=bool(user.vlm_fo1_enabled))


@router.put("", response_model=VlmFo1Pref)
def set_vlm_fo1_pref(
    payload: VlmFo1Pref,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> VlmFo1Pref:
    """Update the calling user's VLM-FO1 toggle state.

    No-op when the value is unchanged. Commits on the dependency-managed
    session so the change survives the request.
    """
    if user.vlm_fo1_enabled != bool(payload.enabled):
        user.vlm_fo1_enabled = bool(payload.enabled)
        db.add(user)
        db.commit()
        db.refresh(user)
    return VlmFo1Pref(enabled=bool(user.vlm_fo1_enabled))
