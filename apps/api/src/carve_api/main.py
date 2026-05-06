# Armin Mehri — mehri.armin@gmail.com
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from carve_api.auth.router import router as auth_router
from carve_api.config import get_settings
from carve_api.errors import AppError
from carve_api.health import router as health_router


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Carve API", version="0.1.0")
    # Plan-20.12 — SlowAPI removed application-wide. The app is
    # self-hosted behind an authenticated boundary; per-minute caps
    # caused real-user pain (uploads of 1000+ images returning 429)
    # and added no security value.

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

    from carve_api.system.router import router as system_router
    app.include_router(system_router)

    # v3.20 -- per-user keyboard shortcut overrides (/me/shortcuts).
    from carve_api.shortcuts.router import router as shortcuts_router
    app.include_router(shortcuts_router)

    # v3.21+ -- per-user VLM-FO1 precision-filter toggle (/me/vlm-fo1).
    from carve_api.vlm_fo1.router import router as vlm_fo1_router
    app.include_router(vlm_fo1_router)

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

    # v3.23 — YOLOE: Real-Time Seeing Anything. Mount at /inference/yoloe/*
    # so the capability probe (and any future non-asset/task scoped YOLOE
    # endpoints) live under a stable, predictable prefix.
    from carve_api.inference.router import inference_yoloe_router
    app.include_router(inference_yoloe_router)

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

    # Plan-13 Phase 7 Task 4 — per-project invitations + member admin.
    from carve_api.invites.router import router as invites_router
    app.include_router(invites_router)

    # Plan-13 Phase 7 Task 6 — dataset versioning + diff/rollback.
    from carve_api.datasets.router import router as datasets_router
    app.include_router(datasets_router)

    # Plan-13 Phase 7 Task 8 — workspace search + saved views.
    from carve_api.search.router import router as search_router
    app.include_router(search_router)
    from carve_api.views.router import router as views_router
    app.include_router(views_router)

    from fastapi import APIRouter, Depends

    from carve_api.auth.models import UserRole
    from carve_api.deps import require_role

    admin_router = APIRouter(prefix="/admin", tags=["admin"])

    @admin_router.get("/ping")
    def admin_ping(_=Depends(require_role(UserRole.admin))) -> dict[str, str]:
        return {"pong": "admin"}

    app.include_router(admin_router)

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
