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


def _hf_login_from_env() -> None:
    """Authenticate with Hugging Face at startup when ``HF_TOKEN`` is set.

    SAM 3 (``facebook/sam3``) is a gated repository: without a logged-in
    token, ``Sam3Model.from_pretrained`` returns 401/403. The model
    service receives ``HF_TOKEN`` via docker-compose env, but the
    huggingface_hub library only consults the token automatically when
    it has been written via ``login()`` (or to
    ``~/.cache/huggingface/token``). Calling login() at lifespan-start
    persists the token to the cache so every subsequent
    ``from_pretrained`` call authenticates -- SAM 3 image, SAM 3 video,
    and any future gated weights all benefit.
    """
    import os

    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        log.info("HF_TOKEN unset; gated repos (e.g. facebook/sam3) will fail")
        return
    try:
        from huggingface_hub import login as hf_login

        hf_login(token=token, add_to_git_credential=False)
        log.info("authenticated with Hugging Face Hub via HF_TOKEN")
    except Exception:  # noqa: BLE001 -- HF login is best-effort at startup
        log.exception(
            "huggingface_hub.login failed; gated repos may not download"
        )


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    _hf_login_from_env()
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

    @app.get("/gpus")
    def gpus() -> list[dict]:
        """Per-GPU stats sourced from nvidia-smi.

        Returns an empty list when nvidia-smi is unavailable or no GPU is
        attached. Used by the api service's /system/info endpoint, which
        cannot run nvidia-smi in its own container.
        """
        import shutil
        import subprocess

        if shutil.which("nvidia-smi") is None:
            return []
        try:
            proc = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=index,name,driver_version,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=2,
                check=False,
            )
        except (subprocess.TimeoutExpired, OSError):
            return []
        if proc.returncode != 0:
            return []
        out: list[dict] = []
        for line in proc.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 8:
                continue
            try:
                total_mb = int(parts[3])
                used_mb = int(parts[4])
                free_mb = int(parts[5])
            except ValueError:
                continue

            def _opt_float(s: str) -> float | None:
                if s in ("[N/A]", "N/A", ""):
                    return None
                try:
                    return float(s)
                except ValueError:
                    return None

            out.append(
                {
                    "index": int(parts[0]),
                    "name": parts[1],
                    "driver_version": parts[2] or None,
                    "memory_total_mb": total_mb,
                    "memory_used_mb": used_mb,
                    "memory_free_mb": free_mb,
                    "memory_percent": (
                        round((used_mb / total_mb) * 100, 1) if total_mb > 0 else 0.0
                    ),
                    "utilization_percent": _opt_float(parts[6]),
                    "temperature_c": _opt_float(parts[7]),
                }
            )
        return out

    app.include_router(yolo_router)
    app.include_router(sam_router)
    app.include_router(sam_track_router)
    return app


app = create_app()
