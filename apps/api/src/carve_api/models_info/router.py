import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from carve_api.auth.models import User
from carve_api.config import get_settings
from carve_api.deps import get_current_user

router = APIRouter(prefix="/models", tags=["models"])

# Variants the model service supports today. Hard-coded for the v2 UI; the
# operator switches by editing SAM_MODEL in the api .env and bouncing the
# model service. The list is duplicated by intent: changing it should be a
# deliberate code edit, not a config-driven runtime surprise.
_AVAILABLE_SAM_VARIANTS: tuple[str, ...] = (
    "sam2.1-tiny",
    "sam2.1-small",
    "sam2.1-base+",
    "sam2.1-large",
    "sam3",
)


class SamActiveOut(BaseModel):
    active: str
    available: list[str]
    # `reachable` is true only when the model service is actually
    # responding to a quick health probe. The v2 frontend uses this to
    # render the SAM-unavailable banner without a separate request.
    reachable: bool = False


def _probe_model_service() -> bool:
    """Return whether the model service is responding to a quick health
    probe. Short timeout — we don't want this endpoint to stall the UI
    if the service is hung."""
    settings = get_settings()
    base = settings.model_base_url.rstrip("/")
    try:
        with httpx.Client(timeout=1.5) as c:
            r = c.get(f"{base}/healthz")
            return r.status_code == 200
    except Exception:
        return False


@router.get("/sam-active", response_model=SamActiveOut)
def sam_active(
    user: User = Depends(get_current_user),  # noqa: ARG001 — auth required
) -> SamActiveOut:
    settings = get_settings()
    return SamActiveOut(
        active=settings.sam_model,
        available=list(_AVAILABLE_SAM_VARIANTS),
        reachable=_probe_model_service(),
    )
