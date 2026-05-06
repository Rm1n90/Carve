"""SAM 2 HTTP endpoints.

POST /sam/encode  — accepts {image_b64} → returns {image_hash, shape}.
                    The encoder runs once per image; the predictor is sticky
                    to a single instance (SAM 2 keeps embedded state inside
                    the predictor object, not externally serialisable).

POST /sam/decode  — accepts {image_hash, points, labels} → returns
                    {counts, size, score}. Returns 409 if the embedding for
                    image_hash isn't currently loaded (caller must re-encode).

POST /sam/text-prompt — SAM 3 only. Accepts {image_b64, text} → returns
                    [{counts, size, score, bbox}]. Returns 409
                    ``sam3_not_enabled`` when the configured SAM model is
                    not ``sam3``; 503 ``sam3_predictor_not_loaded`` when
                    SAM 3 is on but no predictor factory has been
                    registered.

POST /sam/box-prompt — SAM 3 only (one-shot). Accepts
                    {image_b64, boxes, box_labels, text?} → returns
                    [{counts, size, score, bbox}]. Boxes are xyxy floats;
                    box_labels are 1 (positive include) or 0 (negative
                    exclude). The optional ``text`` field combines with
                    boxes to refine a concept (e.g., text + negative
                    box). Returns 409 ``sam3_box_prompt_requires_sam3``
                    when SAM 3 is not the active model; 503
                    ``sam3_box_predictor_not_loaded`` when SAM 3 is on
                    but no box predictor factory has been registered.
"""

import base64
import hashlib
import threading
import time
from io import BytesIO
from typing import Any, Literal

import numpy as np
import xxhash
from fastapi import APIRouter, Body, HTTPException
from PIL import Image
from pydantic import BaseModel, Field

from carve_model.sam.codec import encode_mask_rle
from carve_model.sam.polygonize import mask_to_polygon
from carve_model.sam.predictor import (
    ALLOWED_SAM_MODELS,
    _reset_singleton,
    _set_load_state,
    autocast_ctx,
    extract_embedding,
    force_evict_predictor,
    get_box_predictor,
    get_load_state,
    get_predictor,
    get_sam_model,
    get_sam_variant,
    get_session,
    get_text_predictor,
    load_predictor,
    set_loaded_image,
)
from carve_model.sam.tracker import force_evict_all_sessions

router = APIRouter(prefix="/sam", tags=["sam"])


class EncodeIn(BaseModel):
    image_b64: str


class EncodeOut(BaseModel):
    image_hash: str
    shape: list[int]
    # Base64-encoded float16 image embedding when the active predictor
    # exposes one. ``None`` for the test fake or predictors without
    # ``_features``; callers fall back to server-side decode in that case.
    embedding_b64: str | None = None


class DecodeIn(BaseModel):
    image_hash: str
    # v3.8 Phase 2 — points/labels are now optional so the editor's BBox
    # mode can issue a box-only decode (and refine with clicks via
    # subsequent decodes that pass both). The endpoint validates at
    # least one of (points, box) is present.
    points: list[list[int]] = Field(default_factory=list)
    labels: list[int] = Field(default_factory=list)
    # v3.8 Phase 2 — optional xyxy box. Combines with points at decode
    # time so a box-then-click refinement loop reuses the embedding
    # cache, without forcing the SAM 3-only /sam/box-prompt path.
    box: list[float] | None = None
    # v3.22 — Douglas-Peucker simplification tolerance for the
    # returned polygon (fraction of the contour arc length). When
    # ``None`` the polygonize default is used. Surfaced as the
    # "Polygon approximation points" slider in editor settings — the
    # frontend converts slider 0-100 to a useful epsilon range, see
    # apps/web/src/state/editorSettings.ts.
    epsilon_factor: float | None = Field(default=None, gt=0.0, le=0.1)


class DecodeOut(BaseModel):
    counts: str
    size: list[int]
    score: float
    # v3.8 Phase 1 — Douglas-Peucker simplified outer contour of the
    # selected mask. Empty when the mask has no usable contour (single
    # pixel, all zero, etc). Lets the editor commit the result as an
    # editable polygon annotation without a client-side rasterise step.
    polygon: list[list[float]] = []


@router.post("/encode", response_model=EncodeOut)
def encode(payload: EncodeIn) -> EncodeOut:
    try:
        img_bytes = base64.b64decode(payload.image_b64)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="bad_image_b64") from exc

    h = xxhash.xxh3_128(img_bytes).hexdigest()
    img = np.array(Image.open(BytesIO(img_bytes)).convert("RGB"))
    p = get_predictor()
    p.set_image(img)
    shape = [int(img.shape[0]), int(img.shape[1])]
    # Record the loaded image's hash + shape on the active session so a
    # subsequent /sam/decode can verify the predictor still holds these
    # encoded features. Lifecycle ops (evict, force-evict, switch) drop
    # the session as a unit — preventing the v3.4 desync where the hash
    # gate passed but the predictor's _raw_image had been cleared.
    set_loaded_image(h, shape)
    embedding_bytes = extract_embedding(p)
    embedding_b64 = (
        base64.b64encode(embedding_bytes).decode("ascii")
        if embedding_bytes is not None
        else None
    )
    return EncodeOut(image_hash=h, shape=shape, embedding_b64=embedding_b64)


@router.post("/decode", response_model=DecodeOut)
def decode(payload: DecodeIn) -> DecodeOut:
    session = get_session()
    if session is None or session.loaded_hash != payload.image_hash:
        raise HTTPException(
            status_code=409,
            detail="embedding_not_loaded; call /sam/encode again",
        )
    if len(payload.points) != len(payload.labels):
        raise HTTPException(status_code=422, detail="points and labels must have equal length")
    if not payload.points and payload.box is None:
        raise HTTPException(
            status_code=422,
            detail="at least one of points or box must be provided",
        )
    if payload.box is not None and len(payload.box) != 4:
        raise HTTPException(
            status_code=422,
            detail="box must be [x1, y1, x2, y2]",
        )

    pts = np.asarray(payload.points) if payload.points else np.zeros((0, 2), dtype=np.float32)
    lbl = np.asarray(payload.labels) if payload.labels else np.zeros((0,), dtype=np.int64)

    # v3.22 — multimask semantics fix.
    #
    # Pre-fix: ``multimask_output=True`` was used unconditionally. SAM
    # returns 3 candidate masks at different scales/granularities; we
    # picked the highest-score one. That works for the very first
    # positive click (gives a "best size" mask), but for every
    # refinement click — especially when the user places a NEGATIVE
    # point to exclude part of the mask — the highest-scoring candidate
    # is often the broadest interpretation that ignores the negative.
    # Users reported the negative click being "ignored".
    #
    # Fix: any refinement context (multi-point, any negative, or a
    # box+points combo) uses ``multimask_output=False``. SAM then
    # returns a single mask that integrates all click constraints
    # rather than 3 alternative interpretations.
    has_negative = bool(payload.labels) and 0 in payload.labels
    is_refinement = (
        len(payload.points) > 1
        or has_negative
        or (payload.box is not None and len(payload.points) > 0)
    )
    multimask = not is_refinement

    p = get_predictor()
    with autocast_ctx():
        masks, scores, _ = p.predict(
            point_coords=pts,
            point_labels=lbl,
            multimask_output=multimask,
            box=payload.box,
        )

    masks_np = _to_numpy(masks)
    scores_np = _to_numpy(scores)
    if masks_np.ndim != 3 or scores_np.ndim < 1:
        raise HTTPException(status_code=500, detail="unexpected_predictor_output")
    best = int(np.argmax(scores_np))
    best_mask = masks_np[best]

    # v3.22 — clean the mask once (delete sub-pixel-wide spikes,
    # keep only the largest connected component) so BOTH the RLE the
    # editor renders AND the polygon derived from it come from the
    # same de-spiked source. Without this the RLE overlay painted
    # tendrils into excluded regions even when the polygon looked
    # smooth.
    from carve_model.sam.polygonize import cleanup_mask
    cleaned = cleanup_mask(best_mask)

    counts, size = encode_mask_rle(cleaned)
    # The polygon doesn't need a second cleanup pass; pass kernel=0.
    if payload.epsilon_factor is not None:
        polygon = mask_to_polygon(
            cleaned,
            epsilon_factor=payload.epsilon_factor,
            cleanup_kernel=0,
        )
    else:
        polygon = mask_to_polygon(cleaned, cleanup_kernel=0)
    return DecodeOut(
        counts=counts,
        size=size,
        score=float(scores_np[best]),
        polygon=polygon,
    )


def _to_numpy(arr: Any) -> np.ndarray:
    """Convert a torch tensor (or array-like) to numpy.

    v3.8 — bfloat16 tensors raise ``TypeError: Got unsupported ScalarType
    BFloat16`` on ``.numpy()`` because numpy has no native bfloat16
    dtype. The transformers SAM2 backend runs autocast in bfloat16 by
    default, so ``scores`` and sometimes ``masks`` come back as bf16.
    Cast non-float32 floating tensors up to float32 before the numpy
    bridge. ``.float()`` is the standard torch idiom for this; gracefully
    skip when ``arr`` lacks the method (e.g. raw numpy arrays).
    """
    if hasattr(arr, "cpu"):
        cpu_arr = arr.cpu()
        # `.dtype` exists on torch tensors; defensively gate via getattr.
        dtype = getattr(cpu_arr, "dtype", None)
        if dtype is not None and hasattr(cpu_arr, "float"):
            dname = str(dtype)
            if "bfloat16" in dname or "float16" in dname:
                cpu_arr = cpu_arr.float()
        return cpu_arr.numpy()
    return np.asarray(arr)


def _reset_for_test() -> None:
    """Clear the cached image hash. Used in tests to guarantee independence.

    The image hash now lives on ``predictor._SESSION``, so resetting the
    router's view of "what's loaded" is the same as resetting the
    predictor's session.
    """
    _reset_singleton()


# --- SAM 3 text-prompt endpoint ---------------------------------------------
#
# The endpoint is a thin shell: it gates on the configured SAM model
# (``SAM_MODEL`` with legacy ``SAM_VARIANT`` fallback — see
# ``carve_model.sam.predictor.get_sam_model``) and delegates the real
# inference to a predictor factory the operator registers at container
# start. The actual SAM 3 model loading (gated HF repo, license, HF token)
# happens outside this module — see ``apps/docs/admin.md``.


class TextPromptIn(BaseModel):
    image_b64: str
    text: str = Field(..., min_length=1, max_length=200)
    # v3.21+ — opt-in VLM-FO1 precision filter. Default False preserves
    # byte-for-byte the existing /sam/text-prompt behavior. Honored only
    # when the model service has a filter registered (reflected by
    # /sam/status.vlm_fo1_available).
    use_vlm_fo1: bool = False


class TextPromptOut(BaseModel):
    counts: str
    size: list[int]
    score: float
    bbox: list[float]  # xyxy
    # v3.8 Phase 1 — optional with default [] so SAM 3 text-prompt
    # factories can populate this incrementally. The editor falls back
    # to rasterising counts when polygon is empty.
    polygon: list[list[float]] = []


@router.post("/text-prompt", response_model=list[TextPromptOut])
def sam_text_prompt(payload: TextPromptIn) -> list[dict]:
    if get_sam_variant() != "sam3":
        raise HTTPException(status_code=409, detail="sam3_not_enabled")
    try:
        factory = get_text_predictor()
    except RuntimeError:
        # v3.22 — predictor was force-evicted (e.g. via the System
        # page's "Unload all models" button). Re-register lazily so
        # this request rebuilds the model on demand instead of 503'ing.
        try:
            load_predictor(get_sam_model())
            factory = get_text_predictor()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=503,
                detail="sam3_predictor_not_loaded",
            ) from exc
    # Forward use_vlm_fo1 only when the client opted in. Older factories
    # whose signature predates the kwarg keep working — they're called
    # exactly as before.
    if payload.use_vlm_fo1:
        return factory(
            image_b64=payload.image_b64,
            text=payload.text,
            use_vlm_fo1=True,
        )
    return factory(image_b64=payload.image_b64, text=payload.text)


# --- SAM 3 box-prompt endpoint ----------------------------------------------
#
# One-shot endpoint: takes image_b64 + boxes (+ optional text) and returns
# the masks. Mirrors the /sam/text-prompt pattern (no per-image cache; the
# image is encoded each call). The /sam/encode → /sam/decode flow remains
# the click-driven path; box prompts are typically used in single
# interactive selections in the editor UI, so a sticky cache is not worth
# the lifecycle complexity.


class BoxPromptIn(BaseModel):
    image_b64: str
    boxes: list[list[float]] = Field(min_length=1)  # each [x1, y1, x2, y2]
    box_labels: list[int] = Field(min_length=1)     # 1=positive, 0=negative
    text: str | None = Field(default=None, max_length=200)


class BoxPromptOut(BaseModel):
    counts: str
    size: list[int]
    score: float
    bbox: list[float]  # xyxy
    # v3.8 Phase 1 — see DecodeOut.polygon. Optional default for the
    # same factory-incremental reason as TextPromptOut.
    polygon: list[list[float]] = []


@router.post("/box-prompt", response_model=list[BoxPromptOut])
def sam_box_prompt(payload: BoxPromptIn) -> list[dict]:
    if get_sam_variant() != "sam3":
        raise HTTPException(status_code=409, detail="sam3_box_prompt_requires_sam3")
    if len(payload.boxes) != len(payload.box_labels):
        raise HTTPException(
            status_code=422,
            detail="boxes and box_labels must have equal length",
        )
    if any(label not in (0, 1) for label in payload.box_labels):
        raise HTTPException(
            status_code=422,
            detail="box_labels must be 0 or 1",
        )
    try:
        factory = get_box_predictor()
    except RuntimeError:
        # v3.22 — same lazy-rebuild as /sam/text-prompt above.
        try:
            load_predictor(get_sam_model())
            factory = get_box_predictor()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=503,
                detail="sam3_box_predictor_not_loaded",
            ) from exc
    return factory(
        image_b64=payload.image_b64,
        boxes=payload.boxes,
        box_labels=payload.box_labels,
        text=payload.text,
    )


# --- /sam/unload (admin force-evict) ----------------------------------------
#
# Only reachable on the internal Docker network — Caddy does not proxy
# ``/model/*``. The idle sweeper runs in main.py's lifespan; this endpoint
# lets the operator unload immediately (e.g. before a YOLO training run).


class UnloadIn(BaseModel):
    which: Literal["image", "tracker", "all"] = "all"


class UnloadOut(BaseModel):
    evicted: list[str]
    sessions_released: int
    # v3.22 — GPU bytes freed by this call (reserved-cache delta).
    # ``None`` when CUDA isn't available. Useful when the in-memory
    # bookkeeping says "nothing was loaded" but the GPU still shows
    # memory in use — the delta is the truth.
    gpu_freed_mb: int | None = None


@router.post("/unload", response_model=UnloadOut)
def unload(payload: UnloadIn = Body(default_factory=UnloadIn)) -> UnloadOut:
    """Force-unload SAM models from GPU memory. Idempotent."""
    from carve_model.sam.predictor import _gpu_used_bytes

    before = _gpu_used_bytes()
    evicted: list[str] = []
    sessions_released = 0
    if payload.which in ("image", "all"):
        if force_evict_predictor():
            evicted.append("image")
    if payload.which in ("tracker", "all"):
        sessions_released = force_evict_all_sessions()
        if sessions_released > 0:
            evicted.append("tracker")
    after = _gpu_used_bytes()
    freed_mb: int | None = None
    if before is not None and after is not None:
        freed_mb = max(0, (before - after) // (1024 * 1024))
        # If we measured a real drop but state-tracking thought nothing
        # was loaded, surface it as an "image" eviction so the operator
        # knows the closure-cached models were freed.
        if freed_mb > 0 and not evicted:
            evicted.append("image")
    return UnloadOut(
        evicted=evicted,
        sessions_released=sessions_released,
        gpu_freed_mb=freed_mb,
    )


# v3.22 — proxy endpoint so the API worker can free FO1 GPU memory at
# the end of a batch without learning the sidecar's URL itself. The
# model service already knows where the sidecar lives (via
# VLM_FO1_SIDECAR_URL); this endpoint forwards the request.
@router.post("/vlm-fo1/unload")
def sam_vlm_fo1_unload() -> dict[str, bool | int | None]:
    """Force-unload the FO1 weights on the sidecar. Best-effort, idempotent.

    Returns the sidecar's eviction flag and the GPU bytes it freed
    (when reported). ``gpu_freed_mb`` is sidecar-side, not local.
    """
    from carve_model.vlm_fo1.adapter import unload_sidecar
    result = unload_sidecar()
    if isinstance(result, dict):
        return {
            "evicted": bool(result.get("evicted", False)),
            "gpu_freed_mb": result.get("gpu_freed_mb"),
        }
    # Backwards-compat: helper used to return a bare bool.
    return {"evicted": bool(result), "gpu_freed_mb": None}


# --- /sam/status (load lifecycle inspection) --------------------------------
#
# v3.5 Phase C — surfaces the predictor's load state so the editor UI can
# show a "Loading SAM…" overlay during the 5-30s HF weight download / build.
# Mutated by ``predictor.get_predictor`` (lazy build), ``load_predictor``
# (variant switch), and ``force_evict_predictor`` (drop). The API service
# proxies this via ``GET /models/sam-status`` for the frontend.


class StatusOut(BaseModel):
    state: Literal["idle", "loading", "ready", "error"]
    variant: str | None
    progress_bytes: int | None
    progress_total: int | None
    loaded_at: str | None
    error: str | None
    job_id: str | None = None
    # v3.21+ — VLM-FO1 capability gate. ``True`` means the operator has
    # registered a filter and the per-request ``use_vlm_fo1`` flag will
    # be honored. The editor toggle hides itself when this is False.
    vlm_fo1_available: bool = False
    # v3.22 — diagnostic GPU memory readouts for the model service
    # process. ``gpu_allocated_mb`` is the truly in-use bytes (active
    # model weights + activations); ``gpu_reserved_mb`` is what the
    # CUDA caching allocator holds from the driver (≥ allocated). The
    # delta is allocator cache that ``empty_cache`` will return on
    # idle-eviction. Both ``None`` when CUDA isn't available.
    gpu_allocated_mb: int | None = None
    gpu_reserved_mb: int | None = None


@router.get("/status", response_model=StatusOut)
def sam_status() -> StatusOut:
    """Return the current load state of the SAM predictor.

    States:
      idle    — no predictor loaded, no load in progress
      loading — predictor is being initialised (variant download or build)
      ready   — predictor is loaded and ready to encode/decode
      error   — last load attempt failed; ``error`` carries the detail
    """
    from carve_model.sam.predictor import get_vlm_fo1_filter

    state = get_load_state()
    # In-process GPU memory readout — uses memory_allocated (truly
    # in-use) so the editor / System page can verify that exactly one
    # variant's weights are resident after a /sam/switch.
    gpu_allocated_mb: int | None = None
    gpu_reserved_mb: int | None = None
    try:
        import torch  # type: ignore[import-not-found]

        if torch.cuda.is_available():
            gpu_allocated_mb = int(torch.cuda.memory_allocated() // (1024 * 1024))
            gpu_reserved_mb = int(torch.cuda.memory_reserved() // (1024 * 1024))
    except Exception:  # noqa: BLE001
        pass

    # If the state machine has never been touched but the env already
    # names a variant (e.g. operator preset SAM_MODEL but nobody hit
    # encode yet), fall back to that name so the response is informative.
    return StatusOut(
        state=state.kind,
        variant=state.variant or get_sam_model(),
        progress_bytes=state.progress_bytes,
        progress_total=state.progress_total,
        loaded_at=state.loaded_at,
        error=state.error,
        job_id=state.job_id,
        vlm_fo1_available=get_vlm_fo1_filter() is not None,
        gpu_allocated_mb=gpu_allocated_mb,
        gpu_reserved_mb=gpu_reserved_mb,
    )


# --- /sam/switch (variant hot-swap) -----------------------------------------
#
# v3.0 Bug 7 — replaces the old "edit SAM_MODEL in .env and restart" flow.
# v3.5 Phase C — switched from synchronous to non-blocking 202 so the
# frontend can show a "loading…" overlay polling /sam/status instead of
# waiting on a 60s HTTP request. The model service serialises switches
# behind a small lock and returns 409 if a switch is already in flight.


class SwitchIn(BaseModel):
    variant: str = Field(..., min_length=1)


class SwitchOut(BaseModel):
    """202 response body for a non-blocking switch.

    The ``state`` field reflects the load-state machine immediately after
    the worker thread is spawned. Clients poll ``GET /sam/status`` until
    the state transitions to ``ready`` or ``error``.
    """

    job_id: str
    state: Literal["idle", "loading", "ready", "error"]
    variant: str


_SWITCH_INFLIGHT_LOCK = threading.Lock()
_SWITCH_INFLIGHT_JOB: str | None = None


def _job_id_for(variant: str) -> str:
    """Return a short hash correlation token for a switch job."""
    seed = f"{variant}-{time.time_ns()}".encode()
    return hashlib.sha1(seed).hexdigest()[:12]


def _spawn_switch(variant: str, job_id: str) -> None:
    """Run ``load_predictor`` in a worker thread; reflect status into machine."""

    def _worker() -> None:
        global _SWITCH_INFLIGHT_JOB
        try:
            # ``load_predictor`` itself updates _LOAD_STATE (idle/loading
            # → ready/error). We wrap it once more here so the job_id is
            # exposed via /sam/status while the load is in flight.
            current = get_load_state()
            _set_load_state(
                kind="loading",
                variant=variant,
                progress_bytes=current.progress_bytes,
                progress_total=current.progress_total,
                job_id=job_id,
            )
            load_predictor(variant)
        except Exception as exc:  # noqa: BLE001
            # ``load_predictor`` already wrote an error state, but make
            # absolutely sure the job_id rides along so the client can
            # correlate.
            current = get_load_state()
            _set_load_state(
                kind="error",
                variant=variant,
                error=current.error or str(exc),
                job_id=job_id,
            )
        finally:
            with _SWITCH_INFLIGHT_LOCK:
                _SWITCH_INFLIGHT_JOB = None

    t = threading.Thread(target=_worker, name=f"sam-switch-{job_id}", daemon=True)
    t.start()


@router.post("/switch", status_code=202, response_model=SwitchOut)
def switch(payload: SwitchIn) -> SwitchOut:
    """Hot-swap the active SAM variant (non-blocking).

    Returns 202 immediately with a job_id; the client polls
    ``GET /sam/status`` until the load state transitions to ``ready`` or
    ``error``. Returns 409 ``switch_in_progress`` if another switch is
    already running. 422 on unknown variant.
    """
    if payload.variant not in ALLOWED_SAM_MODELS:
        raise HTTPException(
            status_code=422,
            detail=f"unknown_variant; allowed: {', '.join(ALLOWED_SAM_MODELS)}",
        )

    global _SWITCH_INFLIGHT_JOB
    with _SWITCH_INFLIGHT_LOCK:
        if _SWITCH_INFLIGHT_JOB is not None:
            raise HTTPException(
                status_code=409,
                detail="switch_in_progress",
            )
        job_id = _job_id_for(payload.variant)
        _SWITCH_INFLIGHT_JOB = job_id

    # Pre-flip the state machine so an immediate /sam/status read after
    # this 202 already reads "loading" (eliminates the race where the
    # worker thread hasn't started yet).
    _set_load_state(
        kind="loading",
        variant=payload.variant,
        job_id=job_id,
    )
    _spawn_switch(payload.variant, job_id)

    return SwitchOut(job_id=job_id, state="loading", variant=payload.variant)


def _reset_switch_inflight_for_test() -> None:
    """Test helper — drop the in-flight job lock so independent tests don't deadlock."""
    global _SWITCH_INFLIGHT_JOB
    with _SWITCH_INFLIGHT_LOCK:
        _SWITCH_INFLIGHT_JOB = None
