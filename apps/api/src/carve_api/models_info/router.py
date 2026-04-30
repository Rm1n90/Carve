import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from carve_api.auth.models import User
from carve_api.config import get_settings
from carve_api.deps import get_current_user

router = APIRouter(prefix="/models", tags=["models"])

# Variants the model service supports today. Hard-coded for the v2 UI; the
# v3.0 hot-swap (POST /models/sam-active) lets users change the active
# variant at runtime. The list is duplicated by intent: changing it should
# be a deliberate code edit, not a config-driven runtime surprise.
_AVAILABLE_SAM_VARIANTS: tuple[str, ...] = (
    "sam2.1-tiny",
    "sam2.1-small",
    "sam2.1-base+",
    "sam2.1-large",
    "sam3",
)

# Module-level override of the active variant. Populated by a successful
# POST /models/sam-active. ``None`` means "fall back to the settings value
# (SAM_MODEL env var)". This is intentionally process-local — the model
# service is the source of truth for what's actually loaded; this var is
# just so the GET reflects the most recent successful switch in the same
# API process. Multi-replica deployments should round-trip via the model
# service's ``get_sam_model()`` instead.
_active_sam_variant: str | None = None


# The API's public list uses ``sam2.1-base+`` for historical compatibility
# with the v2 frontend. The model service's ALLOWED_SAM_MODELS uses
# ``sam2.1-base-plus`` (matching the canonical HF repo naming). Translate
# at the proxy boundary so neither side has to change its public contract.
_API_TO_MODEL_VARIANT = {
    "sam2.1-base+": "sam2.1-base-plus",
}
_MODEL_TO_API_VARIANT = {v: k for k, v in _API_TO_MODEL_VARIANT.items()}


def _api_to_model(variant: str) -> str:
    return _API_TO_MODEL_VARIANT.get(variant, variant)


def _model_to_api(variant: str) -> str:
    return _MODEL_TO_API_VARIANT.get(variant, variant)


class SamActiveOut(BaseModel):
    active: str
    available: list[str]
    # `reachable` is true only when the model service is actually
    # responding to a quick health probe. The v2 frontend uses this to
    # render the SAM-unavailable banner without a separate request.
    reachable: bool = False


class SamActiveIn(BaseModel):
    variant: str = Field(..., min_length=1)


class SamSwitchOut(BaseModel):
    active_variant: str


def _probe_model_service() -> bool:
    """Return whether the model service is responding to a quick health
    probe. Short timeout — we don't want this endpoint to stall the UI
    if the service is hung."""
    settings = get_settings()
    base = settings.model_base_url.rstrip("/")
    try:
        with httpx.Client(timeout=1.5) as c:
            r = c.get(f"{base}/health")
            return r.status_code == 200
    except Exception:
        return False


@router.get("/sam-active", response_model=SamActiveOut)
def sam_active(
    user: User = Depends(get_current_user),  # noqa: ARG001 — auth required
) -> SamActiveOut:
    settings = get_settings()
    active = _active_sam_variant or settings.sam_model
    return SamActiveOut(
        active=active,
        available=list(_AVAILABLE_SAM_VARIANTS),
        reachable=_probe_model_service(),
    )


@router.post("/sam-active", response_model=SamSwitchOut)
def sam_set_active(
    payload: SamActiveIn,
    user: User = Depends(get_current_user),  # noqa: ARG001 — auth required
) -> SamSwitchOut:
    """Hot-swap the active SAM variant.

    Validates the variant against the API's allow-list (returns 422 on
    miss), proxies to the model service's ``POST /sam/switch`` (60s
    timeout — loading a SAM variant takes 5-30s), and updates the
    in-memory ``_active_sam_variant`` so the matching GET reflects the
    change.

    Returns 503 ``model_service_unavailable`` when the model service is
    down or returns 5xx; 422 when the model service rejects the variant.
    """
    if payload.variant not in _AVAILABLE_SAM_VARIANTS:
        raise HTTPException(
            status_code=422,
            detail=f"unknown_variant; allowed: {', '.join(_AVAILABLE_SAM_VARIANTS)}",
        )

    settings = get_settings()
    base = settings.model_base_url.rstrip("/")
    model_variant = _api_to_model(payload.variant)
    try:
        with httpx.Client(timeout=60.0) as c:
            r = c.post(f"{base}/sam/switch", json={"variant": model_variant})
    except (httpx.TimeoutException, httpx.HTTPError):
        raise HTTPException(
            status_code=503,
            detail={"error": "model_service_unavailable"},
        ) from None

    if r.status_code == 422:
        raise HTTPException(
            status_code=422,
            detail=f"unknown_variant; rejected by model service: {payload.variant}",
        )
    if r.status_code >= 500:
        raise HTTPException(
            status_code=503,
            detail={"error": "model_service_unavailable"},
        )
    if r.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"model_service_unexpected_status: {r.status_code}",
        )

    body = r.json()
    raw_active = body.get("active_variant", model_variant)
    api_active = _model_to_api(raw_active)

    # Update the module-level cache so the matching GET reflects the
    # successful switch on this API instance.
    global _active_sam_variant
    _active_sam_variant = api_active

    return SamSwitchOut(active_variant=api_active)
