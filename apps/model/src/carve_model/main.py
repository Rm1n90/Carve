import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI

from carve_model.gpu import get_device
from carve_model.sam.predictor import evict_predictor_if_idle
from carve_model.sam.router import router as sam_router
from carve_model.sam.track_router import router as sam_track_router
from carve_model.sam.tracker import evict_idle_sessions
from carve_model.yolo.router import router as yolo_router

log = logging.getLogger(__name__)

# Background sweep runs every SWEEP_INTERVAL_S to evict idle SAM models.
# Daemon thread → never blocks shutdown. The Event-based wait exits early
# when the lifespan stops the sweeper.
_SWEEP_INTERVAL_S = 60.0
_SWEEPER_STOP = threading.Event()


def _sweep_loop() -> None:
    """Idle-eviction loop. Swallows all exceptions so it never crashes the app."""
    while not _SWEEPER_STOP.wait(_SWEEP_INTERVAL_S):
        try:
            evict_predictor_if_idle()
            evict_idle_sessions()
        except Exception:  # noqa: BLE001 — sweeper must never crash
            log.exception("sam idle sweeper iteration failed")


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    from carve_model.yolo.registry import install_default_loader
    install_default_loader()
    _SWEEPER_STOP.clear()
    t = threading.Thread(target=_sweep_loop, daemon=True, name="sam-sweeper")
    t.start()
    try:
        yield
    finally:
        _SWEEPER_STOP.set()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Carve Model Service",
        version="0.1.0",
        lifespan=_lifespan,
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/capabilities")
    def capabilities() -> dict:
        return {
            "models": ["yolo", "sam"],
            "device": get_device(),
        }

    app.include_router(yolo_router)
    app.include_router(sam_router)
    app.include_router(sam_track_router)
    return app


app = create_app()
