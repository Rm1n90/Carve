# Armin Mehri — mehri.armin@gmail.com
"""v3.33 -- cross-class winner-takes-all NMS resolver.

Companion to :mod:`carve_api.inference.hierarchy_nms`. While the
hierarchy resolver drops the more-general (ancestor) annotation when a
more-specific (descendant) one overlaps it, *this* resolver tackles
the orthogonal problem: detections from UNRELATED classes that land on
the same object because the underlying model (SAM 3.1 multi-prompt,
YOLOE, etc.) was matched too aggressively.

Concrete example reported by Armin: a motorbike sometimes received
both a ``Motorbike`` annotation (high confidence) AND a
``Racing Car`` annotation (low confidence) when the text prompt was
``"Racing Car, Formula 1 Car, Formula E Car"``. ``Motorbike`` is
neither an ancestor nor a descendant of ``Racing Car`` -- they're
unrelated classes -- so the hierarchy resolver intentionally left
them alone. The result was a wrong second annotation on every racing
motorbike.

This resolver, when enabled, walks each pair of just-created
annotations and drops the lower-confidence one when:

* The pair's classes are different, AND
* Neither class is an ancestor of the other (those are deferred to
  the hierarchy resolver -- chaining both unconditionally would let
  this resolver undo the hierarchy fix when a high-confidence Car
  outscores a low-confidence Racing Car at the same pixels), AND
* The bbox IoU is at or above ``iou_threshold``.

Sibling classes under a shared parent (e.g. ``Sedan`` and
``Racing Car`` both under ``Car``) ARE considered -- the hierarchy
resolver intentionally leaves siblings alone, but a user who opted
into cross-class NMS wants the higher-confidence sibling to win.

Scope mirrors the hierarchy resolver: only annotations from the
current run are touched (the caller passes their ids). Manually-drawn
or previously-saved annotations are NEVER auto-removed even if a
just-created detection would have outscored them.

Confidence comes from a ``scores`` map keyed by annotation id. The
auto-annotate flows collect SAM ``score`` or YOLO ``confidence``
in-memory while building ``new_anns`` and pass the map here. No DB
column is added -- the resolver only needs scores within the lifetime
of one run.
"""
from __future__ import annotations

import uuid
from typing import Iterable

from sqlalchemy import delete as sa_delete, select
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation
from carve_api.inference.hierarchy_nms import (
    _ancestors_of,
    _bbox_from_geometry,
    _bbox_iou,
)
from carve_api.projects.models import Class


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def resolve_cross_class_overlaps(
    *,
    session: Session,
    new_annotation_ids: Iterable[uuid.UUID],
    scores: dict[uuid.UUID, float],
    classes_by_id: dict[uuid.UUID, Class],
    iou_threshold: float = 0.7,
    enabled: bool = True,
) -> list[uuid.UUID]:
    """Drop the lower-confidence annotation in each cross-class overlap.

    Args:
        session: open SQLAlchemy session; the function flushes but does
            NOT commit -- caller commits.
        new_annotation_ids: ids of annotations created in the current
            run. Manual edits and previous runs are out of scope.
        scores: mapping of annotation id -> confidence in [0, 1]. Missing
            ids default to 0.0 (treated as "no preference"; the
            tie-breaker drops the larger-uuid one).
        classes_by_id: {class_id: Class} for the current project. Used
            to compute ancestor chains so we can defer ancestor/descendant
            pairs to the hierarchy resolver.
        iou_threshold: minimum bbox IoU for two annotations to be
            considered the "same object". Values outside (0, 1] short-
            circuit to no-op.
        enabled: master flag. When False the function is a no-op and
            returns ``[]`` so callers can wire the toggle without an
            extra branch.

    Returns:
        List of annotation ids that were deleted from the DB.
    """
    if not enabled:
        return []
    new_ids = {nid for nid in new_annotation_ids if nid is not None}
    if not new_ids:
        return []
    if iou_threshold <= 0.0 or iou_threshold > 1.0:
        return []

    rows: list[Annotation] = list(
        session.execute(
            select(Annotation).where(Annotation.id.in_(new_ids))
        ).scalars()
    )

    # Pre-compute (annotation, bbox, ancestor_set, score). Mask
    # annotations and degenerate geometry contribute None bboxes and
    # are dropped from the candidate list -- we can't compute IoU for
    # them, and silently skipping is the right thing (same behavior
    # as the hierarchy resolver).
    enriched: list[
        tuple[Annotation, tuple[float, float, float, float], set[uuid.UUID], float]
    ] = []
    for ann in rows:
        bbox = _bbox_from_geometry(ann.geometry)
        if bbox is None:
            continue
        ancestors = _ancestors_of(ann.class_id, classes_by_id)
        score = float(scores.get(ann.id, 0.0))
        enriched.append((ann, bbox, ancestors, score))

    if len(enriched) < 2:
        return []

    to_delete: set[uuid.UUID] = set()
    # Pairwise comparison. O(N^2). Realistic per-asset N is small.
    n = len(enriched)
    for i in range(n):
        ann_a, bbox_a, anc_a, score_a = enriched[i]
        if ann_a.id in to_delete:
            continue
        for j in range(i + 1, n):
            ann_b, bbox_b, anc_b, score_b = enriched[j]
            if ann_b.id in to_delete:
                continue
            # Same class -> intra-class NMS already deduped these
            # within the auto-annotate flow. Don't second-guess it.
            if ann_a.class_id == ann_b.class_id:
                continue
            # Ancestor / descendant -> hierarchy resolver's job. If
            # we acted here we'd unconditionally drop the lower-score
            # one, which would undo cases like high-conf Car +
            # low-conf Racing Car (hierarchy keeps Racing Car; we'd
            # incorrectly keep Car).
            if ann_b.class_id in anc_a or ann_a.class_id in anc_b:
                continue
            iou = _bbox_iou(bbox_a, bbox_b)
            if iou < iou_threshold:
                continue
            # Drop the lower-confidence one. Tie-breaker: drop the
            # one with the lexicographically larger uuid string so the
            # result is deterministic regardless of row order.
            if score_a < score_b or (
                score_a == score_b and str(ann_a.id) > str(ann_b.id)
            ):
                to_delete.add(ann_a.id)
                # ann_a is gone -- no point comparing it against the
                # remaining j's. Break the inner loop and move on to
                # i+1.
                break
            else:
                to_delete.add(ann_b.id)

    if to_delete:
        session.execute(
            sa_delete(Annotation).where(Annotation.id.in_(to_delete))
        )
        session.flush()
    return list(to_delete)


__all__ = ["resolve_cross_class_overlaps"]
