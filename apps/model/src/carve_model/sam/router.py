"""SAM HTTP endpoints.

All endpoints route through the lifecycle manager
(``carve_model.sam.lifecycle.manager``), which is the canonical entry
point for variant selection, load/unload, and lease acquisition. The
manager raises ``SamNotReadyError`` when a lease is requested while the
manager is not in ``ready`` state; the router maps it to HTTP 503 with a
spec-aligned detail string:

  - ``idle``    → ``sam_not_loaded``
  - ``loading`` → ``sam_loading``
  - ``error``   → ``sam_load_failed: <error>`` (preserving the manager's
                  stored error message)

Capability gating is variant-agnostic: when the active variant does not
support a prompt mode (e.g. sam2.x asked for text/box/visual), the
endpoint returns HTTP 409 with
``<op>_prompt_not_supported_for_variant``.

POST /sam/encode  — accepts {image_b64} → returns {image_hash, shape}.
                    The encoder runs once per image; the predictor is sticky
                    to a single instance (SAM 2 keeps embedded state inside
                    the predictor object, not externally serialisable).

POST /sam/decode  — accepts {image_hash, points, labels} → returns
                    {counts, size, score}. Returns 409 if the embedding for
                    image_hash isn't currently loaded (caller must re-encode).

POST /sam/text-prompt — Accepts {image_b64, text} → returns
                    [{counts, size, score, bbox}]. Returns 409
                    ``text_prompt_not_supported_for_variant`` when the
                    active variant doesn't expose text prompting (e.g.
                    sam2.x).

POST /sam/box-prompt — One-shot. Accepts
                    {image_b64, boxes, box_labels, text?} → returns
                    [{counts, size, score, bbox}]. Boxes are xyxy floats;
                    box_labels are 1 (positive include) or 0 (negative
                    exclude). The optional ``text`` field combines with
                    boxes to refine a concept (e.g., text + negative
                    box). Returns 409
                    ``box_prompt_not_supported_for_variant`` when the
                    active variant doesn't expose box prompting.

POST /sam/visual-prompt — SAM 3.1 only. Returns 409
                    ``visual_prompt_not_supported_for_variant`` when the
                    active variant doesn't expose visual prompting.
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

from carve_model.admission import CostClass, admit
from pydantic import BaseModel, Field

from carve_model.sam.codec import encode_mask_rle
from carve_model.sam.polygonize import mask_to_polygon
from carve_model.sam.predictor import (
    ALLOWED_SAM_MODELS,
    _reset_singleton,
    autocast_ctx,
    extract_embedding,
    force_evict_predictor,
    get_box_predictor,
    get_sam_model,
    get_sam_variant,
    get_text_predictor,
)
from carve_model.sam.track_session import force_evict_all_sessions

router = APIRouter(prefix="/sam", tags=["sam"])


def _sam_not_ready_detail(state: str, error: str | None) -> str:
    """Map a ``SamNotReadyError`` state to the spec-defined HTTP 503 detail.

    Spec §7 (Error handling — HTTP mapping):
      - ``idle``    → ``sam_not_loaded``
      - ``loading`` → ``sam_loading``
      - ``error``   → ``sam_load_failed: <error>`` (preserving the
        manager's stored error message; falls back to bare
        ``sam_load_failed`` when no message is available).

    Any unrecognised state falls through to ``sam_<state>`` so future
    states surface diagnostically rather than silently dropping.
    """
    if state == "idle":
        return "sam_not_loaded"
    if state == "loading":
        return "sam_loading"
    if state == "error":
        return f"sam_load_failed: {error}" if error else "sam_load_failed"
    return f"sam_{state}"


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
    shape = [int(img.shape[0]), int(img.shape[1])]

    # Route through the lifecycle manager — the canonical SAM entry
    # point. The manager hands us the active variant (or a test variant
    # installed via predictor.set_test_predictor), and we delegate the
    # image-set + embedding extraction to the variant. We pass the
    # xxhash-derived ``h`` as the cache key so the wire format stays
    # stable; the variant stores it as its ``cached_image_hash`` and a
    # subsequent /sam/decode can verify the embedding is still loaded.
    from carve_model.sam.lifecycle import manager, SamNotReadyError

    try:
        with admit(CostClass.SAM_IMAGE):
            with manager.lease_or_load() as sam:
                sam.set_image(img, image_hash=h)
                embedding_bytes = sam.extract_embedding()
                # Fallback for sam2.x and legacy test fakes: when the
                # variant returns None, fall back to the legacy
                # module-level helper that unpacks
                # ``_features['image_embed']`` from the underlying
                # predictor object. This preserves the existing
                # browser-side ONNX decoder contract.
                #
                # - Sam2Variant: real SAM 2 adapter doesn't expose
                #   ``.extract_embedding()`` so the variant returns
                #   None; the adapter holds ``_features``.
                # - _LegacyTestVariant: fake test predictors may set
                #   ``_features`` on the injected point impl directly.
                if embedding_bytes is None:
                    raw: Any = (
                        getattr(sam, "_adapter", None)
                        or getattr(sam, "_point_impl", None)
                    )
                    if raw is not None:
                        try:
                            embedding_bytes = extract_embedding(raw)
                        except Exception:  # noqa: BLE001
                            embedding_bytes = None
    except SamNotReadyError as e:
        err_msg = manager.status().error
        raise HTTPException(
            status_code=503,
            detail=_sam_not_ready_detail(e.state, err_msg),
        ) from e

    embedding_b64 = (
        base64.b64encode(embedding_bytes).decode("ascii")
        if embedding_bytes is not None
        else None
    )
    return EncodeOut(image_hash=h, shape=shape, embedding_b64=embedding_b64)


@router.post("/decode", response_model=DecodeOut)
def decode(payload: DecodeIn) -> DecodeOut:
    # --- 422 validations (cheap, no lock needed) ---------------------
    if len(payload.points) != len(payload.labels):
        raise HTTPException(
            status_code=422,
            detail="points and labels must have equal length",
        )
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

    # v3.22 — multimask semantics + iterative-refinement (mask_input).
    #
    # Two related fixes for the "negatives don't exclude / mask has
    # holes / boundary jagged" complaints:
    #
    # 1. ``multimask_output=True`` only on the very first positive
    #    click (gives a "best size" mask). Any refinement context
    #    (multi-point, any negative, or box+points) uses
    #    ``multimask_output=False`` so SAM returns one mask that
    #    integrates all clicks instead of 3 alternative
    #    interpretations.
    #
    # 2. Pass ``mask_input`` (the previous decode's chosen low-res
    #    logits) on every refinement call. THIS is the canonical
    #    SAM 2 / CVAT iterative-refinement signal: each click then
    #    refines the SAME mask instead of re-deriving the mask from
    #    scratch with the new prompt set. Without it, click 2 with a
    #    negative produces a mask that ignores the negative because
    #    the model has no notion of "build on the previous mask"; it
    #    just sees one positive + one negative and picks whatever
    #    high-score candidate matches the positives best.
    #
    # ``prev_logits`` is taken from the active variant — stored there
    # by the previous /sam/decode call. We only use it when the click
    # set has strictly grown (``n_now > prev_n``); otherwise (undo, or
    # a fresh chain) we treat the call as a fresh prompt.
    has_negative = bool(payload.labels) and 0 in payload.labels
    n_now = len(payload.points)
    is_refinement = (
        n_now > 1
        or has_negative
        or (payload.box is not None and n_now > 0)
    )
    multimask = not is_refinement

    pts = (
        np.asarray(payload.points)
        if payload.points
        else np.zeros((0, 2), dtype=np.float32)
    )
    lbl = (
        np.asarray(payload.labels)
        if payload.labels
        else np.zeros((0,), dtype=np.int64)
    )

    # --- Inference under the manager lease ---------------------------
    # All variant access happens inside the lease block:
    #   * cached_image_hash() check — embedding must match payload's hash
    #   * get_prev_logits() — iterative refinement input
    #   * predict_point(**kw) — the actual inference
    #   * set_prev_logits(chosen, n_now) — stash for next call
    # Building ``kw`` conditionally keeps legacy test fakes happy —
    # their narrow signatures (e.g. predict(point_coords, point_labels,
    # multimask_output=True, box=None, mask_input=None)) accept these
    # names, while a fake without ``mask_input``/``box`` would only
    # receive the kwargs we pass.
    from carve_model.sam.lifecycle import manager, SamNotReadyError

    try:
        with admit(CostClass.SAM_IMAGE), autocast_ctx():
            with manager.lease_or_load() as sam:
                if sam.cached_image_hash() != payload.image_hash:
                    raise HTTPException(
                        status_code=409,
                        detail="embedding_not_loaded; call /sam/encode again",
                    )

                prev_logits, prev_n = sam.get_prev_logits()
                use_prev = (
                    is_refinement
                    and prev_logits is not None
                    and n_now > prev_n
                )
                mask_input = prev_logits if use_prev else None

                kw: dict[str, Any] = {
                    "point_coords": pts,
                    "point_labels": lbl,
                    "multimask_output": multimask,
                }
                if payload.box is not None:
                    kw["box"] = payload.box
                if mask_input is not None:
                    kw["mask_input"] = mask_input

                masks, scores, low_res_all = sam.predict_point(**kw)

                # Compute chosen_low_res while we still hold the lease
                # so set_prev_logits stays atomic with the inference
                # that produced it. Pure CPU post-processing (cleanup,
                # RLE, polygon) runs after the lease releases.
                masks_np = _to_numpy(masks)
                scores_np = _to_numpy(scores)
                if masks_np.ndim != 3 or scores_np.ndim < 1:
                    raise HTTPException(
                        status_code=500,
                        detail="unexpected_predictor_output",
                    )
                best = int(np.argmax(scores_np))
                best_mask = masks_np[best]

                chosen_low_res: Any = None
                if low_res_all is not None and hasattr(low_res_all, "shape"):
                    try:
                        lr_shape = tuple(low_res_all.shape)
                        if len(lr_shape) == 5:
                            # Sam2 / Sam3 transformers: [B=1, num_obj=1,
                            # K, H, W]. ``input_masks`` flows into
                            # ``mask_embed`` (a Conv2d) which expects 4D
                            # [B, 1, H, W]. Slice the chosen K channel
                            # and squeeze it out so the result is 4D.
                            sliced = low_res_all[:, :, best : best + 1, :, :]
                            chosen_low_res = sliced.squeeze(2)
                            if hasattr(chosen_low_res, "detach"):
                                chosen_low_res = chosen_low_res.detach()
                            if hasattr(chosen_low_res, "contiguous"):
                                chosen_low_res = chosen_low_res.contiguous()
                        elif len(lr_shape) == 3:
                            # sam3.1 native predictor: (K, H, W). The
                            # native SAM2 InteractivePredictor.predict
                            # accepts mask_input shape (1, H, W) —
                            # slice to a single K=1 channel.
                            chosen_low_res = low_res_all[best : best + 1]
                    except Exception:  # noqa: BLE001 — best-effort
                        chosen_low_res = None

                sam.set_prev_logits(chosen_low_res, n_now)
                best_score = float(scores_np[best])
    except SamNotReadyError as e:
        err_msg = manager.status().error
        raise HTTPException(
            status_code=503,
            detail=_sam_not_ready_detail(e.state, err_msg),
        ) from e

    # v3.22 — clean the mask once (delete sub-pixel-wide spikes,
    # keep only the largest connected component, optionally fill
    # internal holes when no negative click is present) so BOTH the
    # RLE the editor renders AND the polygon derived from it come
    # from the same de-spiked source. ``fill_holes`` is gated on
    # ``not has_negative`` because a negative click is the user's
    # explicit "make this region a hole" signal — filling would
    # defeat it.
    from carve_model.sam.polygonize import cleanup_mask
    cleaned = cleanup_mask(best_mask, fill_holes=not has_negative)

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
        score=best_score,
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
    # Confidence floor passed to SAM 3's post_process_instance_segmentation
    # so the user's UI threshold actually changes what the model returns.
    # Without this the predictor hardcoded 0.5 (or 0.2 with VLM-FO1) and
    # silently discarded everything below — even when the API's user-side
    # filter was set to 0.2, SAM had already dropped sub-0.5 candidates,
    # so "obvious" objects with mid-range scores were never surfaced.
    # ``None`` preserves the legacy hardcoded defaults for older callers.
    threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    # Douglas-Peucker tolerance for the returned polygon. Mirrors the
    # /sam/decode contract so the editor's "Polygon approximation
    # points" slider affects auto-annotate output too (previously this
    # path ignored the slider). ``None`` keeps the polygonize default.
    epsilon_factor: float | None = Field(default=None, gt=0.0, le=0.1)


class TextPromptOut(BaseModel):
    counts: str
    size: list[int]
    score: float
    bbox: list[float]  # xyxy
    # v3.8 Phase 1 — optional with default [] so SAM 3 text-prompt
    # factories can populate this incrementally. The editor falls back
    # to rasterising counts when polygon is empty.
    polygon: list[list[float]] = []


# --- SAM 3.1 batched text-prompt (encode-once) -------------------------------
#
# The auto-annotate path runs one text prompt per project class (and per
# comma-fragment) on the SAME image. The single /sam/text-prompt re-runs
# the (expensive) image backbone every call. This endpoint encodes the
# image ONCE and evaluates every text against the cached features —
# ``result[i]`` is byte-identical to ``/sam/text-prompt`` with
# ``text=texts[i]`` (see Sam3p1Variant.predict_text_multi for the
# correctness argument). This is the dominant multi-class speed win.


class TextPromptMultiIn(BaseModel):
    image_b64: str
    # One entry per concept; result is aligned 1:1 to this list. Bounded
    # so a pathological payload can't pin the inference lock forever.
    texts: list[str] = Field(..., min_length=1, max_length=128)
    # Shared across every text (same semantics as TextPromptIn — these
    # are per-image-run settings, not per-concept).
    use_vlm_fo1: bool = False
    threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    epsilon_factor: float | None = Field(default=None, gt=0.0, le=0.1)


# --- SAM 3.1 visual-prompt endpoint ------------------------------------------
#
# One-shot endpoint: SAM 3.1 Promptable Concept Segmentation via image
# exemplars (visual prompts). Accepts a target image and reference regions
# (all same type: either all bbox or all polygon). Returns masks as masks
# + bounding boxes + optional polygons. Requires native SAM 3.1 (not sam3,
# not sam2) because the backbone exposes the dense feature pyramid that the
# visual-prompt encoder needs.


class VisualPromptRegion(BaseModel):
    kind: Literal["bbox", "polygon"]
    xyxy: list[float] | None = None
    points: list[list[float]] | None = None


class VisualPromptIn(BaseModel):
    refer_b64: str = Field(..., min_length=1)
    regions: list[VisualPromptRegion] = Field(..., min_length=1, max_length=64)
    target_b64: str = Field(..., min_length=1)
    # v3.28 — confidence floor (0..1) passed to SAM 3.1's text-prompt
    # path. Mapped directly from the user's UI threshold.
    threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    # v3.28 — fallback text concept when FO1 captioning fails or returns
    # blank. The api supplies the project class's text_prompt or name.
    text_hint: str | None = Field(default=None, max_length=300)
    # Douglas-Peucker tolerance for the returned polygon — see
    # TextPromptIn.epsilon_factor for the full rationale.
    epsilon_factor: float | None = Field(default=None, gt=0.0, le=0.1)


class VisualPromptOut(BaseModel):
    counts: str
    size: list[int]
    score: float
    bbox: list[float]
    polygon: list[list[float]] = []
    # v3.28 — surfaced so the UI can tell the user what concept SAM
    # was actually looking for (e.g. "wooden chair") when the visual
    # prompt was bridged through FO1 captioning.
    concept: str = ""


@router.post("/text-prompt", response_model=list[TextPromptOut])
def sam_text_prompt(payload: TextPromptIn) -> list[dict]:
    # Route through the lifecycle manager — the canonical SAM entry
    # point. The variant decides whether it supports text prompts; if
    # not we 409 with a capability-based reason (not a variant name).
    # SamNotReadyError → 503 with state-specific detail
    # (sam_loading / sam_error). Pre-lease validations stay above the
    # lease so cheap client errors don't take the inference lock.
    from carve_model.sam.lifecycle import manager, SamNotReadyError

    try:
        with manager.lease_or_load() as sam:
            if not sam.supports_text:
                raise HTTPException(
                    status_code=409,
                    detail="text_prompt_not_supported_for_variant",
                )
            # Forward use_vlm_fo1 / threshold / epsilon_factor only when
            # the client supplied them so older factories whose
            # signatures predate the kwargs keep working — they're
            # called exactly as before.
            kwargs: dict = {"image_b64": payload.image_b64, "text": payload.text}
            if payload.use_vlm_fo1:
                kwargs["use_vlm_fo1"] = True
            if payload.threshold is not None:
                kwargs["threshold"] = payload.threshold
            if payload.epsilon_factor is not None:
                kwargs["epsilon_factor"] = payload.epsilon_factor
            with admit(CostClass.SAM_TEXT):
                return sam.predict_text(**kwargs)
    except SamNotReadyError as e:
        err_msg = manager.status().error
        raise HTTPException(
            status_code=503,
            detail=_sam_not_ready_detail(e.state, err_msg),
        ) from e


@router.post(
    "/text-prompt-multi", response_model=list[list[TextPromptOut]]
)
def sam_text_prompt_multi(payload: TextPromptMultiIn) -> list[list[dict]]:
    """Encode the image ONCE, evaluate every text against the cached
    backbone features. ``return[i]`` == ``/sam/text-prompt`` with
    ``text=payload.texts[i]`` (byte-identical — see
    Sam3p1Variant.predict_text_multi). Mirrors /sam/text-prompt's
    lease + capability + admission handling exactly; the whole prompt
    list runs under a single inference lease so no other inference
    interleaves mid-image.
    """
    from carve_model.sam.lifecycle import manager, SamNotReadyError

    try:
        with manager.lease_or_load() as sam:
            if not sam.supports_text:
                raise HTTPException(
                    status_code=409,
                    detail="text_prompt_not_supported_for_variant",
                )
            kwargs: dict = {
                "image_b64": payload.image_b64,
                "texts": list(payload.texts),
            }
            if payload.use_vlm_fo1:
                kwargs["use_vlm_fo1"] = True
            if payload.threshold is not None:
                kwargs["threshold"] = payload.threshold
            if payload.epsilon_factor is not None:
                kwargs["epsilon_factor"] = payload.epsilon_factor
            with admit(CostClass.SAM_TEXT):
                return sam.predict_text_multi(**kwargs)
    except SamNotReadyError as e:
        err_msg = manager.status().error
        raise HTTPException(
            status_code=503,
            detail=_sam_not_ready_detail(e.state, err_msg),
        ) from e


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
    # Douglas-Peucker tolerance for the returned polygon — see
    # TextPromptIn.epsilon_factor for the full rationale.
    epsilon_factor: float | None = Field(default=None, gt=0.0, le=0.1)


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
    # 422 client-error validations BEFORE the lease — cheap; no need to
    # hold the inference lock for shape/value errors that don't depend
    # on the variant. Capability gating (409) and SamNotReadyError (503)
    # happen inside the manager block below.
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

    from carve_model.sam.lifecycle import manager, SamNotReadyError

    try:
        with manager.lease_or_load() as sam:
            if not sam.supports_box:
                raise HTTPException(
                    status_code=409,
                    detail="box_prompt_not_supported_for_variant",
                )
            with admit(CostClass.SAM_BOX):
                box_kwargs: dict = {
                    "image_b64": payload.image_b64,
                    "boxes": payload.boxes,
                    "box_labels": payload.box_labels,
                    "text": payload.text,
                }
                if payload.epsilon_factor is not None:
                    box_kwargs["epsilon_factor"] = payload.epsilon_factor
                return sam.predict_box(**box_kwargs)
    except SamNotReadyError as e:
        err_msg = manager.status().error
        raise HTTPException(
            status_code=503,
            detail=_sam_not_ready_detail(e.state, err_msg),
        ) from e


@router.post("/visual-prompt", response_model=list[VisualPromptOut])
def sam_visual_prompt(payload: VisualPromptIn) -> list[dict]:
    """SAM 3.1 Promptable Concept Segmentation via image exemplars.

    Capability-gated through the manager: only variants exposing
    ``supports_visual`` (today, the native SAM 3.1 variant) accept
    visual prompts. Other variants 409 with
    ``visual_prompt_not_supported_for_variant`` because their backbones
    don't expose the dense feature pyramid the visual-prompt encoder
    needs. See spec §5.5–§5.7.
    """
    # 422 client-error validation BEFORE the lease — mixed-kind regions
    # is a shape error that doesn't depend on the variant.
    kinds = {r.kind for r in payload.regions}
    if len(kinds) > 1:
        raise HTTPException(status_code=422, detail="mixed_ref_types")

    from carve_model.sam.lifecycle import manager, SamNotReadyError

    try:
        with manager.lease_or_load() as sam:
            if not sam.supports_visual:
                raise HTTPException(
                    status_code=409,
                    detail="visual_prompt_not_supported_for_variant",
                )
            regions = [r.model_dump(exclude_none=True) for r in payload.regions]
            with admit(CostClass.SAM_VISUAL):
                visual_kwargs: dict = {
                    "target_b64": payload.target_b64,
                    "refer_b64": payload.refer_b64,
                    "regions": regions,
                    "threshold": payload.threshold,
                    "text_hint": payload.text_hint,
                }
                if payload.epsilon_factor is not None:
                    visual_kwargs["epsilon_factor"] = payload.epsilon_factor
                return sam.predict_visual(**visual_kwargs)
    except SamNotReadyError as e:
        err_msg = manager.status().error
        raise HTTPException(
            status_code=503,
            detail=_sam_not_ready_detail(e.state, err_msg),
        ) from e


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
    from carve_model.sam.lifecycle import manager
    from carve_model.sam.predictor import _gpu_used_bytes

    before = _gpu_used_bytes()
    evicted: list[str] = []
    sessions_released = 0
    if payload.which in ("image", "all"):
        # Task 3.5 — route through the lifecycle manager directly. The
        # manager's force_unload() drops the active variant + runs the
        # full CUDA cleanup (3x gc + synchronize + empty_cache +
        # ipc_collect + dynamo.reset). Legacy ``force_evict_predictor``
        # is still called below to mop up any closure-cached factories
        # and the legacy ``_SESSION`` that pre-migration code paths may
        # still populate. Both are idempotent.
        manager_freed = manager.force_unload()
        legacy_freed = force_evict_predictor()
        if manager_freed or legacy_freed:
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
# Sourced from ``lifecycle.manager.status()`` — the manager is the single
# source of truth post-Task 3.6. The API service proxies this via
# ``GET /models/sam-status`` for the frontend.


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
    # v3.24+ — visual-prompt capability gate. ``True`` means SAM 3.1 is
    # the active model and the visual predictor factory has been registered.
    visual_prompt_available: bool = False
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
    from carve_model.sam.lifecycle import manager
    from carve_model.sam.predictor import get_vlm_fo1_filter

    # Task 3.6 — the lifecycle manager is the single source of truth for
    # load state. Every router endpoint (encode/decode/switch/unload/…)
    # now mutates state via the manager, so the legacy
    # ``predictor._LOAD_STATE`` fallback added in 3.5 is no longer
    # needed.
    state = manager.status()
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

    # Visual-prompt capability gate: ask the active variant directly.
    # After Phase 6 (sam3_adapter deletion) nothing registers the legacy
    # _VISUAL_PREDICTOR_FACTORY in production, so the old factory probe
    # always returned False — hiding the Visual tab in the editor even
    # though /sam/visual-prompt worked end-to-end. The manager's variant
    # is the single source of truth for capability.
    _v = manager._test_variant or manager._active
    visual_prompt_available = bool(_v and getattr(_v, "supports_visual", False))

    # The new lifecycle.LoadState does not carry progress_bytes /
    # progress_total / job_id — those were UI hints wired up to the
    # legacy HF-download progress hooks. The wire shape stays unchanged
    # (spec goal #6); these fields are now constant None.
    return StatusOut(
        state=state.kind,
        variant=state.variant or get_sam_model(),
        progress_bytes=None,
        progress_total=None,
        loaded_at=state.loaded_at,
        error=state.error,
        job_id=None,
        vlm_fo1_available=get_vlm_fo1_filter() is not None,
        visual_prompt_available=visual_prompt_available,
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
    """Run ``manager.ensure_loaded`` in a worker thread.

    The manager updates its ``LoadState`` (idle → loading → ready |
    error) internally; the worker just kicks it off and clears the
    inflight job on completion. The ``job_id`` is preserved at the
    router level for the 202 wire contract — the new
    ``lifecycle.LoadState`` does not carry it (the client correlates
    via /sam/status polling).
    """
    from carve_model.sam.lifecycle import manager

    def _worker() -> None:
        global _SWITCH_INFLIGHT_JOB
        try:
            manager.ensure_loaded(variant)
        except Exception:  # noqa: BLE001
            # ``ensure_loaded`` already wrote ``state=error`` on
            # failure. There is no caller to report to — the client
            # correlates via /sam/status polling.
            pass
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

    _spawn_switch(payload.variant, job_id)

    return SwitchOut(job_id=job_id, state="loading", variant=payload.variant)


def _reset_switch_inflight_for_test() -> None:
    """Test helper — drop the in-flight job lock so independent tests don't deadlock."""
    global _SWITCH_INFLIGHT_JOB
    with _SWITCH_INFLIGHT_LOCK:
        _SWITCH_INFLIGHT_JOB = None
