"""Single-image auto-annotate orchestration."""

import base64
import uuid
from dataclasses import dataclass, field

from sqlalchemy import delete as sa_delete, select
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, Frame
from carve_api.auth.models import User
from carve_api.errors import AppError
from carve_api.inference.model_client import ModelServiceError, yolo_load, yolo_predict
from carve_api.projects.models import Class, Task
from carve_api.storage.client import MinioClient
from carve_api.weights.models import Weight, WeightAssignment


@dataclass
class AutoAnnotateResult:
    """Result returned by ``auto_annotate_asset``.

    v3.3 Issue 3c — extends the legacy ``list[Annotation]`` return into a
    summary the endpoint can surface to the user. Iterating the dataclass'
    ``annotations`` keeps the batch worker (which only counts) unchanged
    while letting the single-asset endpoint relay the skipped tally.

    v3.7.2 — adds ``overwrite_skipped`` so the API/UI can tell when an
    overwrite was requested but suppressed because the new prediction
    yielded zero annotations. This is the data-loss-prevention signal:
    when ``True``, the existing annotations were intentionally preserved.
    """

    annotations: list[Annotation] = field(default_factory=list)
    skipped_by_class: dict[str, int] = field(default_factory=dict)
    overwrite_skipped: bool = False

    @property
    def annotations_created(self) -> int:
        return len(self.annotations)

    @property
    def skipped_count(self) -> int:
        return sum(self.skipped_by_class.values())


class AutoAnnotateMismatch(AppError):
    http_status = 400
    code = "weight_project_mismatch"


class AutoAnnotateModelFailed(AppError):
    http_status = 502
    code = "model_service_failed"


class AutoAnnotateModelUnreachable(AppError):
    """Model service is offline (DNS/connect/timeout)."""

    http_status = 503
    code = "model_service_unreachable"


def _index_classes_by_lower_name(classes: list[Class]) -> dict[str, uuid.UUID]:
    return {c.name.lower(): c.id for c in classes}


def _resolve_frame_id(session: Session, asset: Asset) -> uuid.UUID | None:
    """Return the asset's first Frame id (idx=0) if present.

    Image assets always have exactly one Frame at idx=0 (created at upload).
    Video assets may have many — we use frame 0 here as the default for now.
    """
    row = session.execute(
        select(Frame).where(Frame.asset_id == asset.id).order_by(Frame.idx).limit(1)
    ).scalar_one_or_none()
    return row.id if row else None


def auto_annotate_asset(
    *,
    session: Session,
    actor: User,
    task: Task,
    asset: Asset,
    weight: Weight,
    overwrite: bool,
    presigned_url_for_weight: str,
    image_bytes: bytes,
    min_confidence: float = 0.0,
    iou: float = 0.7,
    class_overrides: dict[int, uuid.UUID | None] | None = None,
    skip_yolo_load: bool = False,
) -> AutoAnnotateResult:
    """Run the model service on a single asset and persist the detections.

    v3.5 Phase F2 — class binding moved from the persistent
    ``weight_class_mappings`` table to a transient per-call
    ``class_overrides`` map (decided in the predict popover). Lookup
    order:

    1. ``class_overrides[weight_class_idx]`` — explicit user pick. A
       value of ``None`` means "skip this weight class on this run".
    2. Fall back to case-insensitive name match against the project's
       classes for any weight class without an override entry.

    Unmapped detections are tallied per-class so the endpoint surfaces a
    "Created N · skipped M (unmapped: …)" summary.
    """
    # v3.5 Phase F5 — workspace-wide weights (project_id is null) work for any task.
    # v3.7 Phase 3 Issue 4 — explicit assignments via ``weight_assignments``
    # let the user make a single weight available to a curated set of
    # projects without making it workspace-wide. Three accept paths:
    #   1. workspace-wide (Weight.project_id IS NULL)
    #   2. legacy direct scope (Weight.project_id == task.project_id)
    #   3. explicit assignment row for (weight, task.project_id)
    project_id = task.project_id
    is_workspace_wide = weight.project_id is None
    is_legacy_scoped = weight.project_id == project_id
    is_assigned = False
    if not (is_workspace_wide or is_legacy_scoped):
        is_assigned = (
            session.execute(
                select(WeightAssignment).where(
                    WeightAssignment.weight_id == weight.id,
                    WeightAssignment.project_id == project_id,
                )
            ).scalar_one_or_none()
            is not None
        )
    if not (is_workspace_wide or is_legacy_scoped or is_assigned):
        raise AutoAnnotateMismatch("weight does not belong to this project")

    project_classes = list(
        session.execute(select(Class).where(Class.project_id == task.project_id)).scalars()
    )
    classes_by_name = _index_classes_by_lower_name(project_classes)
    valid_class_ids = {c.id for c in project_classes}

    # v3.5 Phase F2 — per-weight-class index → project-class-id map. Empty
    # / None means "no overrides; use name-match for everything". An
    # explicit None value for an index marks that weight class as "skip".
    overrides_by_idx: dict[int, uuid.UUID | None] = {}
    if class_overrides:
        for idx, cid in class_overrides.items():
            # Drop ids that don't belong to the task's project — defensive
            # against a stale popover state where the user picked a class
            # that's been deleted between fetch and predict.
            if cid is not None and cid not in valid_class_ids:
                continue
            overrides_by_idx[idx] = cid

    # ``class_names`` is ordered by weight-class idx; build a lower-name
    # lookup so we can fall back to name-match when an override entry is
    # missing for a given idx.
    weight_class_names = list(weight.class_names or [])
    weight_idx_by_lower_name: dict[str, int] = {}
    for i, n in enumerate(weight_class_names):
        weight_idx_by_lower_name.setdefault(str(n).lower(), i)

    def _resolve_class_id(class_name: str) -> uuid.UUID | None:
        key = class_name.lower()
        # First: locate this detection's weight-class idx by name and
        # honour any override (including the explicit "skip" sentinel).
        idx = weight_idx_by_lower_name.get(key)
        if idx is not None and idx in overrides_by_idx:
            return overrides_by_idx[idx]  # may be None → skip
        # Second: name-match fallback. Same case-insensitive logic the
        # pre-F2 path used for legacy weights.
        return classes_by_name.get(key)

    # Load weight on the model service (idempotent via LRU).
    #
    # v3.7.7 — ``skip_yolo_load`` lets the batch worker call ``yolo_load`` ONCE
    # before the asset loop instead of paying an HTTP roundtrip per asset
    # (~545 unnecessary calls on a 545-asset batch). The single-asset endpoint
    # keeps the default ``skip_yolo_load=False`` because the model service's
    # LRU still makes repeated loads cheap and the call surfaces a clear 5xx
    # if the weight URL has expired.
    if not skip_yolo_load:
        try:
            yolo_load(str(weight.id), presigned_url_for_weight)
        except ModelServiceError as exc:
            if exc.status_code == 503:
                raise AutoAnnotateModelUnreachable(f"yolo/load: {exc.body!r}") from exc
            raise AutoAnnotateModelFailed(f"yolo/load: {exc.body!r}") from exc

    image_b64 = base64.b64encode(image_bytes).decode("ascii")
    try:
        # v3.7.5 — thread the per-call IOU threshold through to the model
        # service. ``min_confidence`` is also a model-side filter; passing
        # it as ``conf`` lets Ultralytics drop low-score detections before
        # the box/mask transfer instead of relying on the post-filter loop.
        result = yolo_predict(
            str(weight.id),
            image_b64,
            conf=min_confidence,
            iou=iou,
        )
    except ModelServiceError as exc:
        if exc.status_code == 503:
            raise AutoAnnotateModelUnreachable(f"yolo/predict: {exc.body!r}") from exc
        raise AutoAnnotateModelFailed(f"yolo/predict: {exc.body!r}") from exc

    frame_id = _resolve_frame_id(session, asset)

    # v3.7.2 SAFETY: compute all new annotations FIRST (without persisting)
    # so we can decide whether to honour the ``overwrite`` flag. The previous
    # implementation deleted existing rows before checking detections, which
    # destroyed the user's work whenever zero detections matched the project's
    # classes (e.g. yolov8n COCO classes vs. a 3-class custom project).
    new_anns: list[Annotation] = []
    skipped_by_class: dict[str, int] = {}

    def _bump_skipped(class_name: str) -> None:
        skipped_by_class[class_name] = skipped_by_class.get(class_name, 0) + 1

    for det in result.get("detections", []):
        class_name = str(det.get("class_name", ""))
        cls_id = _resolve_class_id(class_name)
        if cls_id is None:
            _bump_skipped(class_name or "<unknown>")
            continue
        # Confidence filter — skip low-score detections. Defaults to 0.0
        # (no filter) so legacy callers keep their existing behavior.
        score = float(det.get("score", 1.0))
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

    for poly in result.get("polygons", []):
        class_name = str(poly.get("class_name", ""))
        cls_id = _resolve_class_id(class_name)
        if cls_id is None:
            _bump_skipped(class_name or "<unknown>")
            continue
        score = float(poly.get("score", 1.0))
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

    # v3.7.2 SAFETY: only delete existing annotations when we have at
    # least one new annotation to add. Otherwise overwrite=true with
    # zero detections (or zero matching classes) would destroy the
    # user's existing work and replace it with nothing.
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


def fetch_asset_bytes(asset: Asset) -> bytes:
    """Read the asset's original bytes from MinIO."""
    storage = MinioClient.from_settings()
    ext = asset.original_name.rsplit(".", 1)[-1] if "." in asset.original_name else "bin"
    body = storage.get_object(f"assets/{asset.xxh3_128}/original.{ext}").read()
    return body


def presigned_url_for_weight(weight: Weight) -> str:
    """URL handed to the MODEL SERVICE for downloading a weight; uses
    the internal minio endpoint so the model service container can
    resolve it via Docker DNS.

    v3.7.7 — TTL bumped from 600s (10 min) to 3600s (1 hour). On real
    batches a 545-asset job easily runs past 10 minutes due to early
    failures + retries, so the late assets receive an EXPIRED URL and
    the model service returns ``weight_download_failed`` for every
    remaining asset (cascade). 1 hour is still finite — a 5000-asset
    batch at ~200ms/asset is ~17 minutes, well within the window — but
    long enough to rule out URL expiry as the practical bottleneck.
    """
    storage = MinioClient.from_settings()
    return storage.presigned_get_internal(weight.minio_key, expires_seconds=3600)
