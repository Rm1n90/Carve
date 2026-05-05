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

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from model_vlm_fo1 import runner

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="VLM-FO1 sidecar", version="0.1.0")


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
