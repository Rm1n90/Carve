# Armin Mehri — mehri.armin@gmail.com
"""Multi-class SAM 3 text-prompt auto-annotate.

Phase 3.5 -- runs SAM 3 ``/sam/text-prompt`` once per selected class
(using each class's stored ``text_prompt``), filters candidates by
score, and persists polygon (preferred) / mask (fallback) annotations
on the asset's frame. Single-asset sync entry point. The multi-asset
RQ-backed flow lives in ``inference.batch`` and reuses this function
per asset.

Key rules carried over from YOLO auto-annotate:

- Compute all new annotations BEFORE deleting existing ones, so an
  ``overwrite=true`` with zero matches doesn't destroy the user's
  prior work (mirrors the v3.7.2 safety fix in autoannotate.py).
- ``overwrite`` is scoped to the selected ``class_ids`` only -- never
  touches other classes' annotations.
- Idempotent on no-op (empty class set / no eligible class with a
  prompt -> returns 0 created without any DB write).
"""

from __future__ import annotations

import uuid

from sqlalchemy import delete as sa_delete
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset
from carve_api.errors import AppError
from carve_api.inference.autoannotate import _resolve_frame_id
from carve_api.inference.sam import (
    Sam3NotEnabled,
    SamModelFailed,
    SamModelUnreachable,
    sam_text_prompt_for_asset,
)
from carve_api.projects.models import Class, Task


class AutoTextNoEligibleClasses(AppError):
    """Raised when none of the selected classes have a text_prompt."""

    http_status = 422
    code = "no_eligible_classes"


# IoU floor above which two SAM detections are treated as the same object.
# 0.70 is the standard "near-duplicate" line — true duplicates land at
# 0.85+, while two adjacent same-class instances (e.g. two pants on two
# people standing close) typically sit well under 0.50. Picking 0.70
# keeps real instances and drops the SAM-side near-duplicate masks the
# model occasionally emits for a single object.
_NMS_IOU_THRESHOLD = 0.70


def _iou_xyxy(a: list[float], b: list[float]) -> float:
    """Intersection-over-Union for two xyxy bboxes.

    Degenerate / zero-area boxes return 0.0 (rather than NaN or
    raising) so the NMS pass treats them as non-overlapping.
    """
    if len(a) < 4 or len(b) < 4:
        return 0.0
    ax1, ay1, ax2, ay2 = a[0], a[1], a[2], a[3]
    bx1, by1, bx2, by2 = b[0], b[1], b[2], b[3]
    inter_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = inter_w * inter_h
    if inter <= 0.0:
        return 0.0
    a_area = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    b_area = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = a_area + b_area - inter
    if union <= 0.0:
        return 0.0
    return inter / union


def _nms_dedupe(
    candidates: list[dict], iou_threshold: float = _NMS_IOU_THRESHOLD,
) -> list[dict]:
    """Drop near-duplicate detections by bbox IoU, keeping highest score.

    SAM 3 / 3.1's grounding head can emit multiple overlapping proposals
    for the same object (especially with multi-fragment prompts where
    each fragment may rediscover the same region). Without this pass
    the editor renders 2–3 near-identical polygons on the same object —
    confusing and a chore to clean up manually.

    Bbox IoU is cheap and a good proxy for mask similarity at this
    overlap threshold; mask-level IoU would be more precise but would
    require materialising the masks here.
    """
    if len(candidates) <= 1:
        return list(candidates)
    sorted_candidates = sorted(
        candidates,
        key=lambda r: float(r.get("score", 0.0)),
        reverse=True,
    )
    kept: list[dict] = []
    for r in sorted_candidates:
        rbox = r.get("bbox") or [0.0, 0.0, 0.0, 0.0]
        is_duplicate = False
        for k in kept:
            kbox = k.get("bbox") or [0.0, 0.0, 0.0, 0.0]
            if _iou_xyxy(rbox, kbox) >= iou_threshold:
                is_duplicate = True
                break
        if not is_duplicate:
            kept.append(r)
    return kept


def auto_text_for_asset(
    *,
    session: Session,
    asset: Asset,
    task: Task,
    classes: list[Class],
    threshold: float,
    find_all: bool,
    overwrite: bool,
    actor_id: uuid.UUID | None,
    use_vlm_fo1: bool = False,
    iou_threshold: float | None = None,
    epsilon_factor: float | None = None,
    # v3.31 -- cross-class hierarchical NMS. When ``resolve_hierarchy``
    # is True, the resolver runs after the per-class detections are
    # saved and drops ancestor annotations that overlap descendants
    # above ``hierarchy_iou``. Callers default this OFF for backward
    # compatibility; the dialog flips it ON when any project class has
    # a parent.
    resolve_hierarchy: bool = False,
    hierarchy_iou: float = 0.7,
    classes_by_id: dict[uuid.UUID, Class] | None = None,
) -> dict:
    """Run SAM 3 text-prompt for each selected class and persist results.

    Args:
        session: open SQLAlchemy session; the function flushes but does
            NOT commit -- caller commits.
        asset: target Asset row.
        task: parent Task (annotations are scoped to task + frame_id).
        classes: project classes the user picked. Only those with a
            non-empty ``text_prompt`` are queried; others are reported
            as ``ineligible`` in the response.
        threshold: minimum SAM score to keep (0.0..1.0). Defaults at
            the router boundary.
        find_all: when True, every candidate above threshold is saved
            for the class. When False, only the highest-scored is saved.
        overwrite: when True AND at least one new annotation is going
            to be created, existing annotations of the selected classes
            on this asset's frame are deleted first.
        actor_id: optional user id stamped onto each annotation's
            ``created_by`` column.

    Returns:
        ``{"annotations_created": int, "per_class": {class_id: count},
           "ineligible": [class_id, ...]}``
    """
    eligible: list[Class] = [c for c in classes if (c.text_prompt or "").strip()]
    ineligible_ids: list[str] = [
        str(c.id) for c in classes if not (c.text_prompt or "").strip()
    ]
    if not eligible:
        raise AutoTextNoEligibleClasses(
            "selected classes have no text_prompt; configure prompts in the Classes editor"
        )

    frame_id = _resolve_frame_id(session, asset)

    # Compute all new annotations BEFORE deleting -- v3.7.2 safety
    # parity with YOLO autoannotate.
    new_anns: list[Annotation] = []
    per_class: dict[str, int] = {}

    for cls in eligible:
        prompt = (cls.text_prompt or "").strip()
        # Multi-concept prompts. SAM 3 / 3.1's text encoder embeds the
        # whole string as a SINGLE concept — comma-separated lists give
        # unpredictable results because the model isn't a vocabulary
        # parser. We split on commas client-side and run SAM once per
        # non-empty fragment, merging the results under the same class.
        # Case-insensitive dedup so "Pants, pants" doesn't double-call.
        # A single-token prompt (no commas) lands in a one-element list
        # and runs exactly as before — fully backwards compatible.
        fragments: list[str] = []
        seen_lower: set[str] = set()
        for raw in prompt.split(","):
            frag = raw.strip()
            if not frag:
                continue
            key = frag.lower()
            if key in seen_lower:
                continue
            seen_lower.add(key)
            fragments.append(frag)
        if not fragments:
            # Defensive — the eligible filter above already rejected
            # empty/whitespace prompts, but a string of only commas
            # would slip through. Skip silently rather than calling SAM
            # with an empty string.
            per_class[str(cls.id)] = 0
            continue

        # v3.21+ — Auto mode coverage: every class iteration honors the
        # use_vlm_fo1 flag so the toggle behaves consistently across
        # single-asset and batch surfaces.
        # Also pipe the user's UI threshold all the way to SAM 3's
        # post_process_instance_segmentation. The legacy path hardcoded
        # 0.5 inside the model service, so the user's score gate below
        # silently observed an already-truncated candidate list and
        # "obvious" objects with mid-confidence scores were never seen.
        results: list[dict] = []
        for fragment in fragments:
            frag_results = sam_text_prompt_for_asset(
                asset,
                fragment,
                use_vlm_fo1=use_vlm_fo1,
                threshold=float(threshold),
                epsilon_factor=epsilon_factor,
            )
            results.extend(frag_results)

        # Score filter. Applied once across the merged candidate pool so
        # find_all / best-only / overwrite semantics behave identically
        # whether the class had one fragment or several.
        kept = [r for r in results if float(r.get("score", 0.0)) >= threshold]
        # Drop near-duplicate detections (same object, multiple overlapping
        # masks) by bbox-IoU NMS. Runs before find_all so "Best match only"
        # still picks one annotation across the deduplicated pool. The
        # user-configurable iou_threshold lets operators dial how
        # aggressive the dedupe is — high (e.g. 0.85) only collapses
        # nearly-identical masks; low (e.g. 0.30) treats anything with
        # meaningful overlap as the same object.
        kept = _nms_dedupe(
            kept,
            iou_threshold=iou_threshold
            if iou_threshold is not None
            else _NMS_IOU_THRESHOLD,
        )
        # Best-only collapses to argmax after filtering so the threshold
        # still applies (best of nothing is nothing). With multi-fragment
        # prompts this picks the single best match across all concepts —
        # matching the UX promise of "Best match only".
        if not find_all and kept:
            kept = [max(kept, key=lambda r: float(r.get("score", 0.0)))]

        per_class[str(cls.id)] = 0
        for r in kept:
            polygon = r.get("polygon") or []
            if isinstance(polygon, list) and len(polygon) >= 3:
                new_anns.append(
                    Annotation(
                        task_id=task.id,
                        frame_id=frame_id,
                        class_id=cls.id,
                        kind=AnnotationKind.polygon,
                        geometry={
                            "kind": "polygon",
                            "points": [[float(p[0]), float(p[1])] for p in polygon],
                        },
                        track_id=None,
                        created_by=actor_id,
                    )
                )
            else:
                # Fall back to mask_rle when polygon is empty / degenerate.
                counts = r.get("counts")
                size = r.get("size")
                if not (
                    isinstance(counts, str)
                    and isinstance(size, list)
                    and len(size) == 2
                ):
                    continue
                new_anns.append(
                    Annotation(
                        task_id=task.id,
                        frame_id=frame_id,
                        class_id=cls.id,
                        kind=AnnotationKind.mask,
                        geometry={
                            "kind": "mask_rle",
                            "size": [int(size[0]), int(size[1])],
                            "counts": counts,
                        },
                        track_id=None,
                        created_by=actor_id,
                    )
                )
            per_class[str(cls.id)] += 1

    # Only delete existing annotations when at least one new annotation
    # is going to land. v3.7.2 safety pattern -- avoids zero-match wipes.
    if overwrite and new_anns and frame_id is not None:
        eligible_ids = [c.id for c in eligible]
        session.execute(
            sa_delete(Annotation).where(
                Annotation.task_id == task.id,
                Annotation.frame_id == frame_id,
                Annotation.class_id.in_(eligible_ids),
            )
        )

    for ann in new_anns:
        session.add(ann)
    session.flush()

    # v3.31 -- cross-class hierarchical NMS. Walks each new annotation's
    # parent chain (Class.parent_class_id) and drops the ancestor when
    # it overlaps a descendant in this run above ``hierarchy_iou``. The
    # resolver runs ONLY within new_anns -- manual edits and previous
    # runs are untouched.
    hierarchy_deleted = 0
    if resolve_hierarchy and new_anns:
        from carve_api.inference.hierarchy_nms import (
            build_classes_by_id_for_project,
            resolve_hierarchy_overlaps,
        )

        cmap = classes_by_id
        if cmap is None:
            cmap = build_classes_by_id_for_project(session, task.project_id)
        deleted = resolve_hierarchy_overlaps(
            session=session,
            new_annotation_ids=[a.id for a in new_anns],
            classes_by_id=cmap,
            iou_threshold=hierarchy_iou,
            enabled=True,
        )
        hierarchy_deleted = len(deleted)
        # Adjust per_class so the response accurately reflects what
        # actually persisted. Per-class subtraction means the user
        # sees "Created 12 Racing Car (0 Car kept; hierarchy dropped 12)"
        # instead of "Created 12 Racing Car and 12 Car" then mysteriously
        # losing the Cars to the resolver.
        if deleted:
            deleted_set = set(deleted)
            for ann in new_anns:
                if ann.id in deleted_set:
                    key = str(ann.class_id)
                    if key in per_class and per_class[key] > 0:
                        per_class[key] -= 1

    return {
        "annotations_created": len(new_anns) - hierarchy_deleted,
        "per_class": per_class,
        "ineligible": ineligible_ids,
        # v3.31 -- exposed so the dialog can show "Resolved N overlaps"
        # in the success toast.
        "hierarchy_resolved": hierarchy_deleted,
    }


# Re-export the SAM error classes so the router can map them onto
# HTTP responses without importing both modules.
__all__ = [
    "AutoTextNoEligibleClasses",
    "Sam3NotEnabled",
    "SamModelFailed",
    "SamModelUnreachable",
    "auto_text_for_asset",
]
