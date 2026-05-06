"""FastAPI surface for the VLM-FO1 sidecar.

Endpoints:

  - ``GET /healthz`` — process liveness; always 200 if uvicorn is up.
  - ``GET /readyz``  — model-loaded; 200 once weights are resident,
    503 otherwise. The model service uses /healthz for capability
    probing (cheap) and operators use /readyz for warm-up checks.
  - ``POST /filter`` — run FO1 filtering on a (image, text, boxes)
    triple. Lazy-loads the model on first call. Synchronous from the
    caller's perspective; first call may block 30–90s while weights
    download or load.

Request/response shapes intentionally match the in-process adapter
contract so the model-service refactor is a thin HTTP wrapper, not a
re-design.
"""

from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from model_vlm_fo1 import runner

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Background sweeper config — mirrors the model service's SAM sweeper.
# Daemon thread → never blocks shutdown. Event-based wait exits early
# when lifespan stops the sweeper.
_SWEEP_INTERVAL_S = 60.0
_SWEEPER_STOP = threading.Event()


def _sweep_loop() -> None:
    """Idle-eviction loop. Swallows all exceptions so it never crashes the app."""
    while not _SWEEPER_STOP.wait(_SWEEP_INTERVAL_S):
        try:
            runner.evict_if_idle()
        except Exception:  # noqa: BLE001 — sweeper must never crash
            logger.exception("FO1 idle sweeper iteration failed")


@asynccontextmanager
async def _lifespan(_app: FastAPI):  # noqa: ANN001
    sweeper = threading.Thread(target=_sweep_loop, daemon=True, name="fo1-sweeper")
    sweeper.start()
    try:
        yield
    finally:
        _SWEEPER_STOP.set()


app = FastAPI(title="VLM-FO1 sidecar", version="0.1.0", lifespan=_lifespan)


class FilterRequest(BaseModel):
    image_b64: str
    text: str
    boxes: list[list[float]]
    max_boxes: int = Field(default=runner.DEFAULT_MAX_BOXES, ge=1, le=512)
    max_new_tokens: int = Field(default=runner.DEFAULT_MAX_NEW_TOKENS, ge=1, le=8192)


class FilterResponse(BaseModel):
    indexes: list[int]
    raw_output: str
    model_path: str
    quant: str | None = None


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
def readyz() -> dict[str, str]:
    if runner.is_loaded():
        return {"status": "loaded"}
    raise HTTPException(status_code=503, detail="model not loaded yet")


@app.post("/filter", response_model=FilterResponse)
def filter_endpoint(req: FilterRequest) -> FilterResponse:
    try:
        result = runner.run_filter(
            image_b64=req.image_b64,
            text=req.text,
            boxes=req.boxes,
            max_boxes=req.max_boxes,
            max_new_tokens=req.max_new_tokens,
        )
    except Exception as exc:  # noqa: BLE001 — surfaced to caller as 500
        logger.exception("filter failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return FilterResponse(**result)


@app.post("/unload")
def unload_endpoint() -> dict[str, object]:
    """Free the loaded FO1 weights immediately.

    The API worker calls this at the end of an auto-annotate batch (or
    after a single-asset auto-annotate that opted into FO1) so the GPU
    isn't pinned by a model nobody's actively using. The System page's
    "Unload all models" button also reaches this via the model service.
    Idempotent — safe to call when nothing is loaded.

    v3.22 — also reports ``gpu_freed_mb`` (delta of
    ``torch.cuda.memory_reserved`` before/after) so the operator UI
    can show a true number even when the in-memory ``_state`` dict
    bookkeeping says nothing was loaded.
    """
    before = runner.gpu_used_bytes()
    evicted = runner.force_evict()
    after = runner.gpu_used_bytes()
    freed_mb: int | None = None
    if before is not None and after is not None:
        freed_mb = max(0, (before - after) // (1024 * 1024))
    logger.info(
        "/unload requested; evicted=%s gpu_freed_mb=%s", evicted, freed_mb,
    )
    return {"evicted": evicted, "gpu_freed_mb": freed_mb}
