from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from carve_api.auth.router import router as auth_router
from carve_api.config import get_settings
from carve_api.errors import AppError
from carve_api.health import router as health_router
from carve_api.ratelimit import limiter


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Carve API", version="0.1.0")

    app.state.limiter = limiter
    app.add_middleware(SlowAPIMiddleware)

    if settings.cors_origin_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origin_list,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    app.include_router(health_router)
    app.include_router(auth_router)

    from carve_api.api_keys.router import router as api_keys_router
    app.include_router(api_keys_router)

    from carve_api.members.router import router as members_router
    app.include_router(members_router)

    from carve_api.workspace.router import router as workspace_router
    app.include_router(workspace_router)

    from carve_api.projects.router import router as projects_router
    app.include_router(projects_router)

    from carve_api.trash.router import router as trash_router
    app.include_router(trash_router)

    from carve_api.models_info.router import router as models_info_router
    app.include_router(models_info_router)

    from carve_api.assets.router import asset_router, router as task_assets_router
    app.include_router(task_assets_router)
    app.include_router(asset_router)

    from carve_api.annotations.router import ann_router, router as task_annotations_router
    app.include_router(task_annotations_router)
    app.include_router(ann_router)

    # Phase 5 review workflow (plan-09 task-02): single + batch review.
    from carve_api.reviews.router import router as reviews_router
    app.include_router(reviews_router)

    from carve_api.weights.router import project_weights_router, router as weights_router
    app.include_router(project_weights_router)
    app.include_router(weights_router)

    from carve_api.inference.router import router as inference_router
    app.include_router(inference_router)

    from carve_api.inference.router import task_inference_router
    app.include_router(task_inference_router)

    # Plan-09 task-05 — active-learning retrain endpoints.
    from carve_api.inference.retrain_router import router as retrain_router
    app.include_router(retrain_router)

    from carve_api.io.import_router import router as import_router
    app.include_router(import_router)

    from carve_api.exports.router import router as export_router
    app.include_router(export_router)

    from carve_api.stats.router import project_router as stats_project_router, router as stats_router
    app.include_router(stats_router)
    app.include_router(stats_project_router)

    # Plan-13 Phase 7 Task 3 — audit log read endpoint.
    from carve_api.audit.router import router as audit_router
    app.include_router(audit_router)

    from fastapi import APIRouter, Depends

    from carve_api.auth.models import UserRole
    from carve_api.deps import require_role

    admin_router = APIRouter(prefix="/admin", tags=["admin"])

    @admin_router.get("/ping")
    def admin_ping(_=Depends(require_role(UserRole.admin))) -> dict[str, str]:
        return {"pong": "admin"}

    app.include_router(admin_router)

    @app.exception_handler(RateLimitExceeded)
    async def _rate_limited(_request: Request, exc: RateLimitExceeded) -> JSONResponse:
        # v2.6: Surface enough info for clients to back off intelligently.
        # The web upload dialog reads `retry_after_seconds` to decide how
        # long to wait before retrying a 429'd batch. Falls back gracefully
        # if the slowapi internals shift shape across versions.
        retry_after = 60
        amount = 0
        try:
            limit_item = exc.limit.limit  # type: ignore[union-attr]
            retry_after = max(1, int(limit_item.get_expiry()))
            amount = int(limit_item.amount)
        except Exception:  # noqa: BLE001 — defensive against slowapi internals
            pass
        detail = (
            f"Slow down — limit is {amount} requests per minute. "
            f"Wait {retry_after} seconds."
            if amount
            else f"Slow down — rate limit hit. Wait {retry_after} seconds."
        )
        return JSONResponse(
            status_code=429,
            content={
                "error": "rate_limited",
                "retry_after_seconds": retry_after,
                "detail": detail,
            },
            headers={"Retry-After": str(retry_after)},
        )

    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.http_status, content={"error": exc.code})

    @app.exception_handler(HTTPException)
    async def _http_error(_: Request, exc: HTTPException) -> JSONResponse:
        if isinstance(exc.detail, dict):
            return JSONResponse(status_code=exc.status_code, content=exc.detail)
        return JSONResponse(status_code=exc.status_code, content={"error": str(exc.detail)})

    return app


app = create_app()
