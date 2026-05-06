# Armin Mehri — mehri.armin@gmail.com
"""YOLOE service-layer orchestration (v3.23).

Three modes:

* ``text``         — caller supplies a list of class names; YOLOE finds
                     instances of each, text-prompt + open vocabulary.
* ``visual``       — caller supplies a reference image + bbox(es); YOLOE
                     finds visually similar objects in the target image.
* ``prompt_free``  — no prompts; YOLOE-PF returns its 1200-class internal
                     vocabulary detections.

All three return the same Ultralytics-shaped ``{detections, polygons}``
dict the YOLO path produces, so persistence is uniform: build
``Annotation`` rows from the detections, run an optional overwrite, and
hand back an ``AutoAnnotateResult``-shaped summary.

Class resolution differs from YOLO:

* ``text``        : the user-typed class is matched against the project's
                    ``Class`` rows by case-insensitive name. An optional
                    ``class_overrides`` map can pin specific YOLOE class
                    indices to a project class id (or ``None`` to skip).
* ``visual``      : the user pre-picks ONE project class for the run, so
                    every detection lands on that class. Overrides aren't
                    needed.
* ``prompt_free`` : the user picks one project class as ``annotate_as``
                    (overrides every detection's class) OR leaves it
                    unset and falls back to name-match against the
                    project's classes — same behaviour as ``text`` mode
                    when YOLOE-PF emits LVIS labels.
"""

from __future__ import annotations

import base64
import enum
import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import delete as sa_delete, select
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset
from carve_api.auth.models import User
from carve_api.errors import AppError
from carve_api.inference.autoannotate import AutoAnnotateResult
from carve_api.inference.model_client import (
    ModelServiceError,
    yoloe_prompt_free_predict,
    yoloe_status,
    yoloe_text_predict,
    yoloe_visual_predict,
)
from carve_api.projects.models import Class, Task

log = logging.getLogger(__name__)


class YoloeMode(str, enum.Enum):
    text = "text"
    visual = "visual"
    prompt_free = "prompt_free"


class YoloeOutputKind(str, enum.Enum):
    """What annotation kind YOLOE-seg should commit per detection.

    YOLOE-seg always returns BOTH a bounding box and an instance-mask
    polygon for every detection. Persisting both produces two
    overlapping annotations per object, which is rarely what the user
    wants. The user picks one — either keep the boxes or keep the
    polygons — and the persistence layer drops the other.
    """

    bbox = "bbox"
    polygon = "polygon"


# ---------------------------------------------------------------------------
# Errors — re-use the model_service_* envelope shape so the api router maps
# them to the same HTTP responses as YOLO/SAM.
# ---------------------------------------------------------------------------


class YoloeNotAvailable(AppError):
    """The model service has no YOLOE checkpoints on disk."""

    http_status = 409
    code = "yoloe_not_available"


class YoloeModelFailed(AppError):
    http_status = 502
    code = "model_service_failed"


class YoloeModelUnreachable(AppError):
    http_status = 503
    code = "model_service_unreachable"


class YoloeBadRequest(AppError):
    http_status = 422
    code = "yoloe_bad_request"


# ---------------------------------------------------------------------------
# Params — small dataclasses keep the call site clean and let the batch
# worker pickle them across RQ boundaries.
# ---------------------------------------------------------------------------


@dataclass
class YoloeTextParams:
    classes: list[str]
    conf: float = 0.25
    iou: float = 0.7


@dataclass
class YoloeVisualParams:
    """Visual-prompt config.

    ``refer_bytes`` is optional: when ``None`` (the v1 single-asset
    flow), the target asset's own bytes are used as the reference. This
    matches the Ultralytics "use the same image as reference" pattern
    and saves the frontend a round-trip through MinIO.
    """

    bboxes: list[list[float]]
    cls_indices: list[int]
    class_names: list[str]
    annotate_as_class_id: uuid.UUID
    refer_bytes: bytes | None = None
    conf: float = 0.25
    iou: float = 0.7


@dataclass
class YoloePromptFreeParams:
    """Prompt-free run config.

    ``annotate_as_class_id`` overrides every detection to a single
    project class. When ``None``, fall back to case-insensitive name-
    match against the project's classes (same as text mode).
    """

    annotate_as_class_id: uuid.UUID | None = None
    conf: float = 0.25
    iou: float = 0.7
    max_detections: int | None = None


# ---------------------------------------------------------------------------
# Public capability probe — used by GET /inference/yoloe/status.
# ---------------------------------------------------------------------------


def get_status() -> dict:
    """Probe the model service for YOLOE availability.

    Returns a normalised dict — never raises. When the model service is
    offline or YOLOE isn't configured, ``available`` is ``False`` and
    callers can hide the UI without surfacing an error to the user.
    """
    try:
        return yoloe_status()
    except ModelServiceError:
        return {
            "available": False,
            "text_available": False,
            "pf_available": False,
            "text_loaded": False,
            "pf_loaded": False,
            "device": "unknown",
        }


# ---------------------------------------------------------------------------
# Per-mode predict — calls the model service and returns the raw
# ``{detections, polygons}`` shape.
# ---------------------------------------------------------------------------


def _b64(image_bytes: bytes) -> str:
    return base64.b64encode(image_bytes).decode("ascii")


def _wrap_predict_errors(label: str, fn):
    """Run ``fn``, mapping ModelServiceError to our typed AppErrors."""
    try:
        return fn()
    except ModelServiceError as exc:
        if exc.status_code == 503:
            raise YoloeModelUnreachable(f"{label}: {exc.body!r}") from exc
        if exc.status_code in (409, 404):
            raise YoloeNotAvailable(f"{label}: {exc.body!r}") from exc
        if exc.status_code == 422:
            raise YoloeBadRequest(f"{label}: {exc.body!r}") from exc
        raise YoloeModelFailed(f"{label}: {exc.body!r}") from exc


def predict_for_asset(
    image_bytes: bytes,
    mode: YoloeMode,
    params: YoloeTextParams | YoloeVisualParams | YoloePromptFreeParams,
) -> dict:
    """Dispatch to the correct model service endpoint and return its body.

    Image bytes for the target asset are supplied by the caller (so the
    same code path serves image and per-frame video assets).
    """
    image_b64 = _b64(image_bytes)
    if mode is YoloeMode.text:
        assert isinstance(params, YoloeTextParams)
        cleaned = [c.strip() for c in params.classes if c and c.strip()]
        if not cleaned:
            raise YoloeBadRequest("classes_empty")
        return _wrap_predict_errors(
            "yoloe/text-predict",
            lambda: yoloe_text_predict(
                image_b64, cleaned, conf=params.conf, iou=params.iou,
            ),
        )
    if mode is YoloeMode.visual:
        assert isinstance(params, YoloeVisualParams)
        if not params.bboxes:
            raise YoloeBadRequest("bboxes_empty")
        # When the caller didn't supply a separate reference image, use
        # the target image as the reference. The model service's
        # predict_visual now omits the ``refer_image`` kwarg when
        # target == reference (Ultralytics canonical path).
        refer_bytes = (
            params.refer_bytes
            if params.refer_bytes is not None
            else image_bytes
        )
        return _wrap_predict_errors(
            "yoloe/visual-predict",
            lambda: yoloe_visual_predict(
                image_b64,
                _b64(refer_bytes),
                params.bboxes,
                params.cls_indices,
                params.class_names,
                conf=params.conf,
                iou=params.iou,
            ),
        )
    if mode is YoloeMode.prompt_free:
        assert isinstance(params, YoloePromptFreeParams)
        return _wrap_predict_errors(
            "yoloe/prompt-free-predict",
            lambda: yoloe_prompt_free_predict(
                image_b64,
                conf=params.conf,
                iou=params.iou,
                max_detections=params.max_detections,
            ),
        )
    raise YoloeBadRequest(f"unknown_mode:{mode}")


# ---------------------------------------------------------------------------
# Persistence — turns the model service response into Annotation rows.
# ---------------------------------------------------------------------------


def _resolve_frame_id(session: Session, asset: Asset) -> uuid.UUID | None:
    """Return the asset's first Frame id (idx=0) if present."""
    from carve_api.assets.models import Frame

    row = session.execute(
        select(Frame).where(Frame.asset_id == asset.id).order_by(Frame.idx).limit(1)
    ).scalar_one_or_none()
    return row.id if row else None


def _resolver_for_mode(
    mode: YoloeMode,
    params: YoloeTextParams | YoloeVisualParams | YoloePromptFreeParams,
    project_classes: list[Class],
    class_overrides: dict[int, uuid.UUID | None] | None,
):
    """Return a function that maps a YOLOE detection's class_name + index
    to a project class id (or ``None`` to skip the detection)."""
    classes_by_name = {c.name.lower(): c.id for c in project_classes}
    valid_class_ids = {c.id for c in project_classes}

    overrides_by_idx: dict[int, uuid.UUID | None] = {}
    if class_overrides:
        for idx, cid in class_overrides.items():
            if cid is not None and cid not in valid_class_ids:
                continue
            overrides_by_idx[idx] = cid

    if mode is YoloeMode.visual:
        assert isinstance(params, YoloeVisualParams)
        target_id = params.annotate_as_class_id

        # Visual mode pins every detection onto one project class.
        def _visual_resolver(_class_name: str, _det_idx: int) -> uuid.UUID | None:
            return target_id if target_id in valid_class_ids else None

        return _visual_resolver

    if mode is YoloeMode.prompt_free:
        assert isinstance(params, YoloePromptFreeParams)
        target_id = params.annotate_as_class_id
        if target_id is not None:
            def _pf_pinned(_class_name: str, _det_idx: int) -> uuid.UUID | None:
                return target_id if target_id in valid_class_ids else None

            return _pf_pinned

    # text mode (and prompt_free without a pinned class): name-match,
    # honouring per-index overrides for text mode.
    def _name_resolver(class_name: str, det_idx: int) -> uuid.UUID | None:
        if det_idx in overrides_by_idx:
            return overrides_by_idx[det_idx]
        return classes_by_name.get(class_name.lower())

    return _name_resolver


def apply_yoloe_to_asset(
    *,
    session: Session,
    actor: User,
    task: Task,
    asset: Asset,
    image_bytes: bytes,
    mode: YoloeMode,
    params: YoloeTextParams | YoloeVisualParams | YoloePromptFreeParams,
    overwrite: bool = False,
    min_confidence: float = 0.0,
    class_overrides: dict[int, uuid.UUID | None] | None = None,
    output_kind: YoloeOutputKind = YoloeOutputKind.polygon,
) -> AutoAnnotateResult:
    """Run YOLOE on a single asset and persist new annotations.

    Reuses ``AutoAnnotateResult`` as the return shape so the api router
    can serialise YOLOE responses through the same Pydantic model the
    YOLO predict path uses (``AutoAnnotateResponse`` in router.py).
    """
    project_classes = list(
        session.execute(select(Class).where(Class.project_id == task.project_id)).scalars()
    )
    resolve_class = _resolver_for_mode(mode, params, project_classes, class_overrides)

    result = predict_for_asset(image_bytes, mode, params)

    frame_id = _resolve_frame_id(session, asset)

    new_anns: list[Annotation] = []
    skipped_by_class: dict[str, int] = {}

    def _bump_skipped(class_name: str) -> None:
        skipped_by_class[class_name] = skipped_by_class.get(class_name, 0) + 1

    # YOLOE-seg returns both boxes and polygons for the same detections.
    # Commit only the user-selected output kind so a single object turns
    # into a single annotation, not a stacked bbox+polygon pair. When
    # the chosen kind is unavailable (rare — e.g. a future detection-only
    # checkpoint), we fall through to the other kind so the user still
    # gets results rather than a silent no-op.
    have_polys = bool(result.get("polygons"))
    have_dets = bool(result.get("detections"))
    effective_kind = output_kind
    if effective_kind is YoloeOutputKind.polygon and not have_polys and have_dets:
        effective_kind = YoloeOutputKind.bbox
    elif effective_kind is YoloeOutputKind.bbox and not have_dets and have_polys:
        effective_kind = YoloeOutputKind.polygon

    if effective_kind is YoloeOutputKind.bbox:
        for idx, det in enumerate(result.get("detections", [])):
            class_name = str(det.get("class_name", "") or "")
            cls_id = resolve_class(class_name, idx)
            if cls_id is None:
                _bump_skipped(class_name or "<unknown>")
                continue
            score = float(det.get("confidence", det.get("score", 1.0)))
            if score < min_confidence:
                continue
            b = det["bbox"]
            new_anns.append(
                Annotation(
                    task_id=task.id,
                    frame_id=frame_id,
                    class_id=cls_id,
                    kind=AnnotationKind.bbox,
                    geometry={"kind": "bbox", "x": b["x"], "y": b["y"], "w": b["w"], "h": b["h"]},
                    track_id=None,
                    created_by=actor.id,
                )
            )
    else:  # polygon
        for idx, poly in enumerate(result.get("polygons", [])):
            class_name = str(poly.get("class_name", "") or "")
            cls_id = resolve_class(class_name, idx)
            if cls_id is None:
                _bump_skipped(class_name or "<unknown>")
                continue
            score = float(poly.get("confidence", poly.get("score", 1.0)))
            if score < min_confidence:
                continue
            pts = [[float(p[0]), float(p[1])] for p in poly.get("points", [])]
            if len(pts) < 3:
                continue
            new_anns.append(
                Annotation(
                    task_id=task.id,
                    frame_id=frame_id,
                    class_id=cls_id,
                    kind=AnnotationKind.polygon,
                    geometry={"kind": "polygon", "points": pts},
                    track_id=None,
                    created_by=actor.id,
                )
            )

    overwrite_skipped = False
    if overwrite and frame_id is not None:
        if len(new_anns) > 0:
            session.execute(
                sa_delete(Annotation).where(
                    Annotation.task_id == task.id,
                    Annotation.frame_id == frame_id,
                )
            )
        else:
            overwrite_skipped = True

    for ann in new_anns:
        session.add(ann)

    session.flush()
    return AutoAnnotateResult(
        annotations=new_anns,
        skipped_by_class=skipped_by_class,
        overwrite_skipped=overwrite_skipped,
    )
