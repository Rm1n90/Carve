from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from vaa_api.auth.router import router as auth_router
from vaa_api.config import get_settings
from vaa_api.errors import AppError
from vaa_api.health import router as health_router


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="VisualAutoAnnotator API", version="0.1.0")

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

    from vaa_api.projects.router import router as projects_router
    app.include_router(projects_router)

    from vaa_api.assets.router import asset_router, router as task_assets_router
    app.include_router(task_assets_router)
    app.include_router(asset_router)

    from vaa_api.annotations.router import ann_router, router as task_annotations_router
    app.include_router(task_annotations_router)
    app.include_router(ann_router)

    from fastapi import APIRouter, Depends

    from vaa_api.auth.models import UserRole
    from vaa_api.deps import require_role

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
