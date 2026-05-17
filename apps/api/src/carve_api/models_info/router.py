# Armin Mehri — mehri.armin@gmail.com
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from carve_api.auth.models import User, UserRole
from carve_api.config import get_settings
from carve_api.deps import get_current_user, get_db
from carve_api.inference.batch import (
    SAM_USING_BATCH_KINDS,
    count_active_jobs,
)
from carve_api.projects.models import Project
from redis import Redis

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
    # v3.32 -- per-project preferred SAM variant, surfaced when the
    # caller passed ``?project_id=<uuid>``. ``None`` means the project
    # has no preference set (or no project_id was passed). The editor
    # uses this to detect "preferred differs from loaded" so it can
    # offer a one-click load-and-switch.
    preferred_variant: str | None = None
    # v3.32 -- when the model service is idle / unreachable but the
    # project has a preferred variant, ``active`` echoes the preference
    # so the editor's variant label stays stable. This flag tells the
    # editor "the preferred variant is the right one but it's not yet
    # loaded -- offer to load it" rather than treating ``active`` as
    # an already-loaded variant.
    preferred_loaded: bool = True


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
    # v3.21+ — proxied from the model service's /sam/status. Tells the
    # editor whether the per-user VLM-FO1 toggle should be visible.
    vlm_fo1_available: bool = False
    # v3.28 — proxied from /sam/status. Tells the editor whether the
    # SAM Visual Prompt tab should be available in Auto-Annotate.
    visual_prompt_available: bool = False


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


def _redis_client_or_none() -> "Redis | None":
    """Best-effort Redis handle for the SAM-switch active-jobs gate.

    Mirrors the helper in ``carve_api.inference.router`` (intentionally
    duplicated to avoid cross-importing a router module). Returns
    ``None`` if Redis is unreachable; the caller treats that as
    "no active jobs to consult" and proceeds.
    """
    s = get_settings()
    try:
        client = Redis(
            host=s.redis_host, port=s.redis_port, socket_connect_timeout=1
        )
        client.ping()
        return client
    except Exception:  # noqa: BLE001
        return None


@router.get("/sam-active", response_model=SamActiveOut)
def sam_active(
    project_id: uuid.UUID | None = Query(
        default=None,
        description=(
            "Optional project context. When supplied, the response carries"
            " the project's preferred SAM variant so the editor can pre-"
            "flight a switch."
        ),
    ),
    db: Session = Depends(get_db),
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

    v3.32 — accepts ``?project_id=<uuid>`` so the editor can read the
    project's persisted preference in the same round-trip. When the
    model service reports the predictor as idle / errored / unreachable
    AND the project has a preference set, ``active`` echoes the
    preference and ``preferred_loaded=False`` so the editor knows to
    offer "Load <variant> for this project". This is the persistent-
    selection fix the user asked for: their choice survives API
    restarts and idle eviction.
    """
    settings = get_settings()
    base = settings.model_base_url.rstrip("/")
    reachable = False
    model_variant: str | None = None
    model_state: str | None = None
    try:
        with httpx.Client(timeout=1.5) as c:
            r = c.get(f"{base}/sam/status")
            if r.status_code == 200:
                reachable = True
                body = r.json() or {}
                v = body.get("variant")
                model_state = body.get("state")
                # Only trust the model service's variant when the
                # predictor is actually ready or in the middle of
                # loading; otherwise the field can carry a stale value.
                if (
                    isinstance(v, str)
                    and v
                    and model_state in {"ready", "loading"}
                ):
                    model_variant = _model_to_api(v)
    except Exception:
        # Fall through to the in-memory / settings fallback below.
        pass

    # v3.32 — resolve the project's preferred variant when a project_id
    # is supplied. Soft failures (project missing, FK gone) fall through
    # to None so we never block the editor on an orphaned lookup.
    preferred_variant: str | None = None
    if project_id is not None:
        try:
            project = db.get(Project, project_id)
            if project is not None and project.deleted_at is None:
                raw = getattr(project, "default_sam_variant", None)
                if isinstance(raw, str) and raw.strip():
                    preferred_variant = raw.strip()
        except Exception:
            preferred_variant = None

    # The "loaded" variant follows the legacy precedence: live model
    # variant > in-memory override > settings env default. ``active``
    # ALWAYS reflects what the model service actually has loaded so
    # the editor's SAM-picker label tells the truth. The mismatch
    # signal lives in ``preferred_variant`` + ``preferred_loaded`` so
    # the reconcile dialog can correctly say "preferred X, but Y is
    # currently loaded".
    loaded_active = model_variant or _active_sam_variant or settings.sam_model
    preferred_loaded = (
        preferred_variant is None or preferred_variant == loaded_active
    )

    return SamActiveOut(
        active=loaded_active,
        available=list(_AVAILABLE_SAM_VARIANTS),
        reachable=reachable,
        preferred_variant=preferred_variant,
        preferred_loaded=preferred_loaded,
    )


@router.post("/sam-active", response_model=SamSwitchOut, status_code=202)
def sam_set_active(
    payload: SamActiveIn,
    force: bool = Query(
        default=False,
        description=(
            "Workspace admins only. When true, the active-batch guard is"
            " bypassed (running batches will fail with sam_not_ready)."
        ),
    ),
    user: User = Depends(get_current_user),
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

    v3.32 -- before forwarding, scans Redis for active auto-annotate
    batch jobs. If any are running (status in {queued, running,
    waiting_for_gpu}) and the caller is NOT a workspace admin, returns
    409 ``switch_blocked_by_active_jobs`` with the running jobs'
    progress. Admins may pass ``?force=true`` to bypass the guard; the
    running batches will then see the variant change mid-flight and
    fall back to their own error path (typically ``sam_not_ready``).
    """
    if payload.variant not in _AVAILABLE_SAM_VARIANTS:
        raise HTTPException(
            status_code=422,
            detail=f"unknown_variant; allowed: {', '.join(_AVAILABLE_SAM_VARIANTS)}",
        )

    # v3.32 -- active-batch guard. Only SAM-using batches block the
    # switch: YOLO / YOLOE batches use their own weights and don't
    # touch SAM, so switching the SAM variant while they're running
    # is safe and must not be refused. Soft-fail when Redis is
    # unavailable (count_active_jobs returns []) so a Redis outage
    # doesn't lock the SAM picker indefinitely.
    redis_client = _redis_client_or_none()
    active_jobs = count_active_jobs(redis_client, kinds=SAM_USING_BATCH_KINDS)
    is_admin = user.role == UserRole.admin
    if active_jobs and not (is_admin and force):
        raise HTTPException(
            status_code=409,
            detail={
                "error": "switch_blocked_by_active_jobs",
                "code": "switch_blocked_by_active_jobs",
                "active_jobs": active_jobs,
                "can_force": is_admin,
                "message": (
                    f"{len(active_jobs)} SAM batch job(s) are currently "
                    "running. Wait for them to finish, "
                    + (
                        "or pass ?force=true to switch anyway "
                        "(running jobs will be cancelled)."
                        if is_admin
                        else "or ask a workspace admin to force the switch."
                    )
                ),
            },
        )

    # v3.32 -- admin force-switch path: cancel every SAM-using active
    # job before forwarding the switch so workers stop quickly instead
    # of grinding through retries and posting sam_not_ready errors per
    # asset. Innocent YOLO/YOLOE batches are NOT in ``active_jobs``
    # (kind filter) and therefore not cancelled. Best-effort; a cancel
    # that fails (worker already exited, etc.) just lets the worker
    # discover sam_not_ready on its next iteration.
    if active_jobs and is_admin and force and redis_client is not None:
        try:
            from carve_api.jobs.queue import try_cancel_rq_job

            for j in active_jobs:
                try:
                    try_cancel_rq_job(redis_client, j["job_id"])
                except Exception:  # noqa: BLE001
                    continue
        except Exception:  # noqa: BLE001
            pass

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
        vlm_fo1_available=bool(body.get("vlm_fo1_available", False)),
        visual_prompt_available=bool(body.get("visual_prompt_available", False)),
    )
