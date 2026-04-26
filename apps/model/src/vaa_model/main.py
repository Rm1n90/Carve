from fastapi import FastAPI

from vaa_model.gpu import get_device
from vaa_model.yolo.router import router as yolo_router


def create_app() -> FastAPI:
    app = FastAPI(title="VisualAutoAnnotator Model Service", version="0.1.0")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/capabilities")
    def capabilities() -> dict:
        return {
            "models": ["yolo"],
            "device": get_device(),
        }

    app.include_router(yolo_router)
    return app


app = create_app()
