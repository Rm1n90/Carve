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
class YoloeTextPrompt:
    """A single (project class -> text prompt) mapping for text mode.

    The user picks a project class and writes a YOLOE text prompt that
    describes what that class looks like. Multiple pairs per run let
    the user target several project classes at once with one model
    forward pass.
    """

    class_id: uuid.UUID
    prompt: str


@dataclass
class YoloeTextParams:
    """Text-prompt config — list of (class, prompt) entries.

    The model service runs a single ``set_classes(unique_prompts)``
    plus a single ``predict``. Detections come back tagged with the
    prompt string, which the persistence layer maps back to the
    project class via the prompt -> class_id table built here.
    """

    prompts: list[YoloeTextPrompt]
    conf: float = 0.25
    iou: float = 0.7


@dataclass
class YoloeVisualGroup:
    """One (project class -> reference bbox(es)) group for visual mode.

    The user picks 1-N reference bboxes from a source image and
    assigns them to a project class. YOLOE finds visually similar
    objects in the target image(s) and labels each match with the
    group index. The persistence layer maps the group index back to
    ``class_id``.
    """

    class_id: uuid.UUID
    bboxes: list[list[float]]  # xyxy (image-space pixels of the source)


@dataclass
class YoloeVisualSource:
    """One reference image and the class-keyed bboxes inside it.

    Multi-source visual prompts (v3.24): the user can pick refs from
    several different assets. Each ``YoloeVisualSource`` carries the
    bytes of one source image plus the bboxes/groups inside that
    image's coordinate space. The orchestrator runs YOLOE once per
    (source, target) pair and merges per-target detections via
    cross-source NMS.

    ``refer_bytes`` may be ``None`` to mean "use the target asset's
    own bytes as this source's reference" — the canonical Ultralytics
    "same image as reference" path. The orchestrator substitutes the
    target bytes per-target in that case.
    """

    asset_id: uuid.UUID | None
    refer_bytes: bytes | None
    groups: list[YoloeVisualGroup]


@dataclass
class YoloeVisualParams:
    """Visual-prompt config — list of source images, each with its
    own class-keyed bbox groups.

    Single-source flows are the special case ``len(sources) == 1``.
    The orchestrator handles N>=1 uniformly: one YOLOE call per
    (source, target) pair, then cross-source NMS to dedupe overlapping
    detections of the same class.
    """

    sources: list[YoloeVisualSource]
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


# ---------------------------------------------------------------------------
# Cross-source NMS (v3.24).
#
# When the user's visual prompt has refs from multiple source images,
# the api runs YOLOE once per (source, target) pair. Different sources
# often detect the same physical object in the target — without
# merging, we'd save N near-identical annotations per object. Greedy
# per-class NMS picks the highest-confidence detection of each pair
# (or cluster) above the IoU threshold and drops the rest.
#
# IoU is computed on the enclosing bbox for both ``detections`` (which
# carry an ``x/y/w/h`` bbox) and ``polygons`` (where the enclosing
# bbox is min/max of points). A 0.6 threshold is slightly stricter
# than standard 0.5 because cross-source false positives tend to
# cluster tightly; loosening to 0.5 risks merging genuinely separate
# nearby objects.
# ---------------------------------------------------------------------------

_NMS_IOU = 0.6


def _bbox_xyxy(d: dict) -> tuple[float, float, float, float]:
    """Return the enclosing xyxy of a detection or polygon dict.

    For bbox-shaped detections, derive xyxy from ``{x, y, w, h}``.
    For polygon-shaped detections, take min/max over ``points``.
    Empty / malformed entries collapse to a degenerate (0,0,0,0)
    box; their IoU with anything else is 0 so they survive without
    interfering — they'll be filtered out elsewhere.
    """
    if "bbox" in d:
        b = d["bbox"]
        try:
            x, y = float(b["x"]), float(b["y"])
            w, h = float(b["w"]), float(b["h"])
        except (KeyError, TypeError, ValueError):
            return (0.0, 0.0, 0.0, 0.0)
        return (x, y, x + w, y + h)
    pts = d.get("points") or []
    if not pts:
        return (0.0, 0.0, 0.0, 0.0)
    try:
        xs = [float(p[0]) for p in pts]
        ys = [float(p[1]) for p in pts]
    except (TypeError, ValueError, IndexError):
        return (0.0, 0.0, 0.0, 0.0)
    return (min(xs), min(ys), max(xs), max(ys))


def _iou(
    a: tuple[float, float, float, float],
    b: tuple[float, float, float, float],
) -> float:
    """Standard axis-aligned bbox IoU."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    ua = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    ub = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = ua + ub - inter
    return (inter / union) if union > 0.0 else 0.0


def _nms_dedupe(dets: list[dict], iou_threshold: float) -> list[dict]:
    """Per-class greedy NMS across detections from multiple sources.

    Detections of different classes never compete (only same-class
    pairs are checked). Within each class, sort by confidence
    descending and keep each candidate iff its IoU with all already-
    kept boxes of that class is below the threshold.
    """
    if not dets:
        return []
    by_class: dict[str, list[dict]] = {}
    for d in dets:
        by_class.setdefault(str(d.get("class_name", "")), []).append(d)
    out: list[dict] = []
    for _class_name, group in by_class.items():
        group.sort(
            key=lambda d: float(d.get("confidence", 0.0)),
            reverse=True,
        )
        kept_xyxy: list[tuple[float, float, float, float]] = []
        for cand in group:
            cx = _bbox_xyxy(cand)
            if any(_iou(cx, kx) > iou_threshold for kx in kept_xyxy):
                continue
            kept_xyxy.append(cx)
            out.append(cand)
    return out


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
        # Dedupe prompts (case-sensitive) while remembering which
        # project class each unique prompt came from. If the same
        # prompt is supplied for two different classes (unusual but
        # possible), the first wins — second is skipped at persist.
        unique_prompts: list[str] = []
        prompt_to_class_id: dict[str, uuid.UUID] = {}
        for entry in params.prompts:
            p = (entry.prompt or "").strip()
            if not p:
                continue
            if p not in prompt_to_class_id:
                unique_prompts.append(p)
                prompt_to_class_id[p] = entry.class_id
        if not unique_prompts:
            raise YoloeBadRequest("prompts_empty")
        result = _wrap_predict_errors(
            "yoloe/text-predict",
            lambda: yoloe_text_predict(
                image_b64, unique_prompts, conf=params.conf, iou=params.iou,
            ),
        )
        # Stash the resolver into the dict so apply_yoloe_to_asset
        # can map detection.class_name (= the prompt string) back to
        # a project class id without re-deduping.
        result["_prompt_to_class_id"] = prompt_to_class_id
        return result
    if mode is YoloeMode.visual:
        assert isinstance(params, YoloeVisualParams)
        if not params.sources:
            raise YoloeBadRequest("sources_empty")
        # Validate at least one bbox somewhere in the request.
        if not any(g.bboxes for s in params.sources for g in s.groups):
            raise YoloeBadRequest("bboxes_empty")

        all_detections: list[dict] = []
        all_polygons: list[dict] = []
        token_to_class_id: dict[str, uuid.UUID] = {}

        for source in params.sources:
            # Per-source: flatten this source's groups into the YOLOE
            # wire shape. Each pass uses the group's class_id (string)
            # as the cls-name token so detections come back tagged
            # with the project class id directly.
            flat_bboxes: list[list[float]] = []
            flat_cls: list[int] = []
            class_name_tokens: list[str] = []
            for group_idx, g in enumerate(source.groups):
                if not g.bboxes:
                    continue
                token = str(g.class_id)
                token_to_class_id[token] = g.class_id
                class_name_tokens.append(token)
                for b in g.bboxes:
                    flat_bboxes.append(list(b))
                    flat_cls.append(group_idx)
            if not flat_bboxes:
                continue

            # When this source has no separate refer image, use the
            # target image bytes (canonical Ultralytics "same image
            # as reference"). The model service's predict_visual
            # already omits the ``refer_image`` kwarg when target
            # bytes equal reference bytes.
            refer_bytes = (
                source.refer_bytes
                if source.refer_bytes is not None
                else image_bytes
            )

            sub = _wrap_predict_errors(
                "yoloe/visual-predict",
                lambda rb=refer_bytes, fb=flat_bboxes, fc=flat_cls,
                cn=class_name_tokens: yoloe_visual_predict(
                    image_b64,
                    _b64(rb),
                    fb,
                    fc,
                    cn,
                    conf=params.conf,
                    iou=params.iou,
                ),
            )
            all_detections.extend(sub.get("detections") or [])
            all_polygons.extend(sub.get("polygons") or [])

        # Cross-source NMS — when refs from two different source
        # assets both detect the same object in the target, we get
        # two near-duplicate boxes. Greedy per-class NMS picks the
        # higher-confidence one and drops the rest.
        merged_detections = _nms_dedupe(
            all_detections, iou_threshold=_NMS_IOU,
        )
        merged_polygons = _nms_dedupe(
            all_polygons, iou_threshold=_NMS_IOU,
        )

        return {
            "detections": merged_detections,
            "polygons": merged_polygons,
            "_token_to_class_id": token_to_class_id,
        }
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
    result: dict,
):
    """Return a function that maps a YOLOE detection's class_name to a
    project class id (or ``None`` to skip the detection).

    Each mode supplies its own resolver source built into ``result``
    by ``predict_for_asset``:

    * text mode: ``_prompt_to_class_id[detection.class_name]`` —
      detection.class_name is exactly the prompt string we sent in
      ``set_classes``.
    * visual mode: ``_token_to_class_id[detection.class_name]`` —
      detection.class_name is the str(class_id) token we wired
      through ``class_names``.
    * prompt-free mode: pinned to ``annotate_as_class_id`` if set,
      else fall back to case-insensitive name-match against the
      project's classes.
    """
    valid_class_ids = {c.id for c in project_classes}
    classes_by_name = {c.name.lower(): c.id for c in project_classes}

    if mode is YoloeMode.text:
        prompt_to_class_id: dict[str, uuid.UUID] = result.get(
            "_prompt_to_class_id", {},
        )

        def _text_resolver(class_name: str, _det_idx: int) -> uuid.UUID | None:
            cid = prompt_to_class_id.get(class_name)
            return cid if cid in valid_class_ids else None

        return _text_resolver

    if mode is YoloeMode.visual:
        token_to_class_id: dict[str, uuid.UUID] = result.get(
            "_token_to_class_id", {},
        )

        def _visual_resolver(class_name: str, _det_idx: int) -> uuid.UUID | None:
            cid = token_to_class_id.get(class_name)
            return cid if cid in valid_class_ids else None

        return _visual_resolver

    # prompt_free
    assert isinstance(params, YoloePromptFreeParams)
    target_id = params.annotate_as_class_id
    if target_id is not None:
        def _pf_pinned(_class_name: str, _det_idx: int) -> uuid.UUID | None:
            return target_id if target_id in valid_class_ids else None

        return _pf_pinned

    def _pf_name_resolver(class_name: str, _det_idx: int) -> uuid.UUID | None:
        return classes_by_name.get(class_name.lower())

    return _pf_name_resolver


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
    output_kind: YoloeOutputKind = YoloeOutputKind.bbox,
) -> AutoAnnotateResult:
    """Run YOLOE on a single asset and persist new annotations.

    Reuses ``AutoAnnotateResult`` as the return shape so the api router
    can serialise YOLOE responses through the same Pydantic model the
    YOLO predict path uses (``AutoAnnotateResponse`` in router.py).
    """
    project_classes = list(
        session.execute(select(Class).where(Class.project_id == task.project_id)).scalars()
    )

    result = predict_for_asset(image_bytes, mode, params)
    resolve_class = _resolver_for_mode(mode, params, project_classes, result)

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
