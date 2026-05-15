import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI

from carve_model.devices_router import router as devices_router
from carve_model.gpu import get_device
from carve_model.sam.lifecycle import manager as sam_manager
from carve_model.sam.router import router as sam_router
# v3.27 — legacy /sam-track/* track_router + tracker.py removed.
from carve_model.sam.track_router import router as track_router
from carve_model.yolo.router import router as yolo_router
from carve_model.yoloe.registry import REGISTRY as _YOLOE_REGISTRY
from carve_model.yoloe.router import router as yoloe_router

log = logging.getLogger(__name__)

# v3.29 — surface app-side diagnostics under uvicorn's default handler
# config (which only configures uvicorn.* loggers). Without this, our
# logger.info() calls (e.g. SAM Visual Prompt's per-request score
# distribution) get filtered out at the root WARN level. Idempotent.
logging.getLogger("carve_model").setLevel(logging.INFO)
if not logging.getLogger("carve_model").handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(name)s %(levelname)s %(message)s"))
    logging.getLogger("carve_model").addHandler(_h)
    logging.getLogger("carve_model").propagate = False

# Background sweep runs every SWEEP_INTERVAL_S to evict idle SAM models.
# Daemon thread → never blocks shutdown. The Event-based wait exits early
# when the lifespan stops the sweeper.
_SWEEP_INTERVAL_S = 60.0
_SWEEPER_STOP = threading.Event()


def _sweep_loop() -> None:
    """Idle-eviction loop. Swallows all exceptions so it never crashes the app."""
    while not _SWEEPER_STOP.wait(_SWEEP_INTERVAL_S):
        try:
            sam_manager.evict_if_idle()
            from carve_model.sam.track_session import evict_idle_sessions as _evict_track_sessions
            _evict_track_sessions()
            # v3.23 — also free idle YOLOE checkpoints. Both the
            # text+visual model (yoloe-26l-seg.pt) and the prompt-free
            # model (yoloe-26l-seg-pf.pt) hold ~1 GB of GPU weights
            # once loaded; idle eviction returns the GPU to the
            # editor's SAM/YOLO traffic when YOLOE isn't in use.
            _YOLOE_REGISTRY.evict_idle()
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


def _vlm_fo1_can_load(model_path: str) -> tuple[bool, str]:  # noqa: ARG001 — kept for API compat
    """Probe whether the FO1 sidecar is reachable.

    FO1 inference was moved out of this process into the
    ``model-vlm-fo1`` sidecar container (transformers==4.50.1, separate
    GPU consumer). The capability check is now an HTTP ``GET /healthz``
    against the sidecar — cheap, sub-second, no model load triggered.

    Returns ``(ok, reason)``:
      - ``(True, "<sidecar-url>")`` — sidecar is reachable
      - ``(False, "<reason>")`` — feature should NOT be advertised; the
        toggle stays hidden so users don't see a dead control.
    """
    import httpx

    from carve_model.vlm_fo1.adapter import _resolve_sidecar_url

    base = _resolve_sidecar_url()
    try:
        with httpx.Client(timeout=2.0) as client:
            resp = client.get(f"{base}/healthz")
            resp.raise_for_status()
        return True, base
    except Exception as exc:  # noqa: BLE001
        return False, (
            f"vlm_fo1 sidecar unreachable at {base} ({exc}). "
            f"Start the model-vlm-fo1 service: "
            f"`docker compose --profile inference up -d model-vlm-fo1`."
        )


def _maybe_prewarm_yoloe() -> None:
    """Optionally pre-load both YOLOE checkpoints at startup.

    Default OFF: ``YOLOE_PREWARM=0`` keeps the lifespan fast and only
    loads each checkpoint on its first request (~3 s). Set to ``1``
    in production when YOLOE traffic is steady so the first user
    request doesn't pay the load cost.

    Failures here MUST NOT crash startup.
    """
    import os

    if os.environ.get("YOLOE_PREWARM", "0").lower() not in ("1", "true", "yes"):
        return
    for key in ("text", "pf"):
        try:
            if _YOLOE_REGISTRY.is_available(key):  # type: ignore[arg-type]
                _YOLOE_REGISTRY.get(key)  # type: ignore[arg-type]
                log.info("yoloe.prewarm key=%s", key)
        except Exception:  # noqa: BLE001 — prewarm is best-effort
            log.exception("yoloe.prewarm key=%s failed", key)


def _maybe_register_vlm_fo1() -> None:
    """Register the VLM-FO1 precision filter when the operator opts in
    AND the FO1 architecture is actually loadable.

    Default OFF: ``VLM_FO1_AVAILABLE=0`` (or unset) means no filter is
    registered, ``/sam/status.vlm_fo1_available`` reports ``false``,
    and the model service behaves byte-for-byte identical to today.

    Probe gate: when ``VLM_FO1_AVAILABLE=1``, run a cheap capability
    probe before registering. If FO1 can't load (e.g. upstream
    ``vlm_fo1`` package missing — see ``_vlm_fo1_can_load``), log a
    clear operator message and skip registration. This keeps the
    toggle hidden in the editor instead of showing a control that
    would silently degrade to passthrough on every click.

    Failures here MUST NOT crash startup.
    """
    import os

    if os.environ.get("VLM_FO1_AVAILABLE", "0").lower() not in ("1", "true", "yes"):
        log.info("VLM_FO1_AVAILABLE unset; skipping FO1 filter registration")
        return

    try:
        from carve_model.vlm_fo1 import DEFAULT_MODEL_PATH

        model_path = os.environ.get("VLM_FO1_MODEL_PATH") or DEFAULT_MODEL_PATH
        ok, reason = _vlm_fo1_can_load(model_path)
        if not ok:
            log.warning(
                "VLM_FO1_AVAILABLE=1 but FO1 sidecar is unreachable: %s. "
                "Toggle will stay hidden in the editor.",
                reason,
            )
            return

        from carve_model.sam.predictor import set_vlm_fo1_filter
        from carve_model.vlm_fo1 import make_vlm_fo1_filter

        quant = os.environ.get("VLM_FO1_QUANT") or None
        filter_fn = make_vlm_fo1_filter(model_path=model_path, quant=quant)
        set_vlm_fo1_filter(filter_fn)
        log.info(
            "VLM-FO1 precision filter registered (source=%s, quant=%s); "
            "lazy-load on first opted-in /sam/text-prompt request",
            reason,
            quant or "bf16",
        )
    except Exception:  # noqa: BLE001 — startup must never crash on FO1
        log.exception(
            "VLM_FO1_AVAILABLE=1 but filter registration failed; FO1 stays "
            "disabled, /sam/status.vlm_fo1_available will report false",
        )


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    _hf_login_from_env()
    from carve_model.yolo.registry import install_default_loader
    install_default_loader()
    # v3.23 — YOLOE has its own loader (Ultralytics' YOLOE class, not
    # YOLO). Install at lifespan so the /yoloe/* endpoints can lazy-
    # load the two checkpoints. Idempotent.
    from carve_model.yoloe.registry import install_default_loader as _install_yoloe_loader
    _install_yoloe_loader()
    _maybe_prewarm_yoloe()
    _maybe_register_vlm_fo1()
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
        models = ["yolo", "sam"]
        # v3.23 — advertise YOLOE only when at least one checkpoint
        # is on disk, so the api/frontend can hide UI when the
        # operator hasn't shipped the weights.
        if _YOLOE_REGISTRY.is_available("text") or _YOLOE_REGISTRY.is_available("pf"):
            models.append("yoloe")
        return {
            "models": models,
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
    app.include_router(yoloe_router)
    app.include_router(sam_router)
    app.include_router(track_router)
    # v3.25 — central device manager (probe + per-model preference +
    # validated SAM reload).
    app.include_router(devices_router)
    return app


app = create_app()
