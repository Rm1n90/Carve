# Armin Mehri — mehri.armin@gmail.com
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
    "sam3.1",
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
    """Response from ``POST /models/sam-active``.

    v3.5 Phase C — the model service's ``/sam/switch`` is non-blocking
    and returns 202 + ``{job_id, state, variant}``. The API mirrors that
    contract so the frontend can poll ``/models/sam-status`` for
    completion. ``active_variant`` is preserved as an alias of
    ``variant`` so legacy callers keep working.
    """

    job_id: str
    state: str
    variant: str
    active_variant: str  # alias of `variant` for legacy clients


class SamStatusOut(BaseModel):
    """Mirror of the model service's ``GET /sam/status`` response.

    State machine:
      idle    — no predictor loaded
      loading — predictor is being initialised (HF download or build)
      ready   — predictor loaded and ready
      error   — last load attempt failed; ``error`` carries the detail

    ``model_service_unreachable`` is surfaced as ``state="error"`` with
    ``error="model_service_unreachable"`` when the model container is
    unreachable, so the frontend overlay can dismiss without a network
    spinner that never resolves.
    """

    state: str
    variant: str | None = None
    progress_bytes: int | None = None
    progress_total: int | None = None
    loaded_at: str | None = None
    error: str | None = None
    job_id: str | None = None


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
    """Return the variant that is *actually loaded* on the model service,
    falling back to the API's in-memory override and then to settings
    when the service is unreachable.

    Plan-17 — previously this returned ``_active_sam_variant or
    settings.sam_model``, which was wrong after API restarts: the
    in-memory cache is wiped but the model service keeps its loaded
    variant, so the editor would show the stale ``sam2.1-tiny`` fallback
    while SAM 3.1 was actually mounted. Now we ask the model service.
    """
    settings = get_settings()
    base = settings.model_base_url.rstrip("/")
    reachable = False
    model_variant: str | None = None
    try:
        with httpx.Client(timeout=1.5) as c:
            r = c.get(f"{base}/sam/status")
            if r.status_code == 200:
                reachable = True
                body = r.json() or {}
                v = body.get("variant")
                state = body.get("state")
                # Only trust the model service's variant when the
                # predictor is actually ready or in the middle of
                # loading; otherwise the field can carry a stale value.
                if isinstance(v, str) and v and state in {"ready", "loading"}:
                    model_variant = _model_to_api(v)
    except Exception:
        # Fall through to the in-memory / settings fallback below.
        pass
    active = model_variant or _active_sam_variant or settings.sam_model
    return SamActiveOut(
        active=active,
        available=list(_AVAILABLE_SAM_VARIANTS),
        reachable=reachable,
    )


@router.post("/sam-active", response_model=SamSwitchOut, status_code=202)
def sam_set_active(
    payload: SamActiveIn,
    user: User = Depends(get_current_user),  # noqa: ARG001 — auth required
) -> SamSwitchOut:
    """Hot-swap the active SAM variant (non-blocking).

    Validates the variant against the API's allow-list (returns 422 on
    miss), proxies to the model service's ``POST /sam/switch`` (which is
    itself non-blocking since v3.5 Phase C), and updates the in-memory
    ``_active_sam_variant`` so the matching GET reflects the requested
    target. The frontend polls ``GET /models/sam-status`` until the load
    state machine settles.

    Returns 503 ``model_service_unavailable`` when the model service is
    down or returns 5xx; 422 when the model service rejects the variant;
    409 when another switch is already in flight on the model service.
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
        # Short timeout — the model service returns 202 immediately, so
        # 5s is more than enough headroom. Loading still happens in the
        # background and the frontend polls /models/sam-status.
        with httpx.Client(timeout=5.0) as c:
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
    if r.status_code == 409:
        raise HTTPException(
            status_code=409,
            detail="switch_in_progress",
        )
    if r.status_code >= 500:
        raise HTTPException(
            status_code=503,
            detail={"error": "model_service_unavailable"},
        )
    if r.status_code not in (200, 202):
        raise HTTPException(
            status_code=502,
            detail=f"model_service_unexpected_status: {r.status_code}",
        )

    body = r.json()
    raw_variant = body.get("variant") or body.get("active_variant") or model_variant
    api_variant = _model_to_api(raw_variant)

    # Update the module-level cache so the matching GET reflects the
    # requested switch on this API instance.
    global _active_sam_variant
    _active_sam_variant = api_variant

    return SamSwitchOut(
        job_id=body.get("job_id", ""),
        state=body.get("state", "loading"),
        variant=api_variant,
        active_variant=api_variant,
    )


@router.get("/sam-status", response_model=SamStatusOut)
def sam_status_endpoint(
    user: User = Depends(get_current_user),  # noqa: ARG001 — auth required
) -> SamStatusOut:
    """Proxy ``GET /sam/status`` from the model service.

    The frontend polls this every ~1.5s while the variant-switch overlay
    is open. When the model service is unreachable we synthesise an
    ``error`` state so the overlay can dismiss instead of spinning.
    """
    settings = get_settings()
    base = settings.model_base_url.rstrip("/")
    try:
        with httpx.Client(timeout=5.0) as c:
            r = c.get(f"{base}/sam/status")
            r.raise_for_status()
    except (httpx.ConnectError, httpx.TimeoutException, httpx.HTTPError):
        return SamStatusOut(
            state="error",
            variant=None,
            error="model_service_unreachable",
        )
    body = r.json()
    raw_variant = body.get("variant")
    api_variant = (
        _model_to_api(raw_variant) if isinstance(raw_variant, str) else None
    )
    return SamStatusOut(
        state=body.get("state", "idle"),
        variant=api_variant,
        progress_bytes=body.get("progress_bytes"),
        progress_total=body.get("progress_total"),
        loaded_at=body.get("loaded_at"),
        error=body.get("error"),
        job_id=body.get("job_id"),
    )
