# Armin Mehri — mehri.armin@gmail.com
"""v3.31 — cross-class hierarchical NMS resolver.

Used by every auto-annotate write path (SAM auto-text, SAM auto-visual,
YOLOE, YOLO predict) to drop the **more general** (ancestor) annotation
when it overlaps a **more specific** (descendant) annotation above an
IoU floor.

Why
---
Text-prompt detectors don't know your class taxonomy. Asking SAM 3.1
for both ``car`` and ``Racing Car, Formula 1 Car, Formula E Car``
returns BOTH detections over the same racing-car pixels — because a
racing car IS a car. The intra-class NMS dedup (per-class) leaves
cross-class overlap untouched, so the editor saves two boxes on the
same object and a YOLO export carries conflicting labels at the same
pixels (poisoning training signal).

What
----
``resolve_hierarchy_overlaps`` walks each annotation's parent chain
(via ``Class.parent_class_id``, capped at depth 8). For any pair
(descendant, ancestor) of just-created annotations whose bboxes
overlap above the configured IoU floor, the ancestor is dropped.
Returns the list of deleted annotation ids so the caller can include
the count in its response payload.

Scope
-----
The resolver only considers annotations from the **current run**
(passed in as a UUID set). Manually-drawn or previously-saved
annotations are NOT auto-removed even if they would be ancestors of a
just-created descendant — that's the user's existing work, untouched.
"""
from __future__ import annotations

import uuid
from typing import Iterable

from sqlalchemy import delete as sa_delete, select
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation
from carve_api.projects.models import Class
from carve_api.projects.service import MAX_CLASS_HIERARCHY_DEPTH


# ---------------------------------------------------------------------------
# Geometry helpers — bbox extraction from the union geometry shapes the
# editor persists (``bbox`` / ``polygon`` / ``mask_rle``). Mask annotations
# are skipped at the resolver level: decoding RLE inside the API process
# is expensive and the user's hyponymy taxonomies overwhelmingly produce
# bbox / polygon kinds. We can revisit if a real use-case shows up.
# ---------------------------------------------------------------------------


def _bbox_from_geometry(geometry: dict | None) -> tuple[float, float, float, float] | None:
    """Return ``(x1, y1, x2, y2)`` for the geometry, or ``None`` when no
    usable rectangle can be derived. Polygon collapses to its axis-aligned
    bounding rect; mask_rle returns ``None`` (skipped by the resolver)."""
    if not isinstance(geometry, dict):
        return None
    kind = geometry.get("kind")
    if kind == "bbox":
        try:
            x = float(geometry["x"])
            y = float(geometry["y"])
            w = float(geometry["w"])
            h = float(geometry["h"])
        except (KeyError, TypeError, ValueError):
            return None
        if w <= 0 or h <= 0:
            return None
        return (x, y, x + w, y + h)
    if kind == "polygon":
        pts = geometry.get("points") or []
        if not isinstance(pts, list) or len(pts) < 3:
            return None
        try:
            xs = [float(p[0]) for p in pts]
            ys = [float(p[1]) for p in pts]
        except (TypeError, ValueError, IndexError):
            return None
        if not xs or not ys:
            return None
        x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
        if x2 - x1 <= 0 or y2 - y1 <= 0:
            return None
        return (x1, y1, x2, y2)
    # mask_rle and unknown kinds — not handled here.
    return None


def _bbox_iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    """Standard rectangle IoU. Returns 0.0 for degenerate / disjoint."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
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


# ---------------------------------------------------------------------------
# Ancestor walk — caps at MAX_CLASS_HIERARCHY_DEPTH and tolerates cycles
# defensively (the API forbids them on write but a pre-existing migration
# blip shouldn't be able to lock the resolver into an infinite loop).
# ---------------------------------------------------------------------------


def _ancestors_of(
    class_id: uuid.UUID,
    classes_by_id: dict[uuid.UUID, Class],
) -> set[uuid.UUID]:
    """Return the set of class ids that are ancestors of ``class_id``.

    Walks ``parent_class_id`` upward, capped at MAX_CLASS_HIERARCHY_DEPTH.
    Self is NOT included. Cycles short-circuit safely.
    """
    seen: set[uuid.UUID] = set()
    cur = classes_by_id.get(class_id)
    if cur is None:
        return seen
    depth = 0
    while cur is not None:
        parent_id = getattr(cur, "parent_class_id", None)
        if parent_id is None:
            return seen
        if parent_id == class_id or parent_id in seen:
            return seen
        seen.add(parent_id)
        depth += 1
        if depth >= MAX_CLASS_HIERARCHY_DEPTH:
            return seen
        cur = classes_by_id.get(parent_id)
    return seen


# ---------------------------------------------------------------------------
# Resolver entry point. Callers pass:
#   * the open ``session`` (caller commits)
#   * the set of annotation ids the current run produced
#   * a class map for the project the run is targeting
#   * the IoU floor (typically 0.7; surfaced as a slider in the dialog)
# Returns the list of deleted annotation ids. When ``enabled`` is False
# or the set is empty, the function is a no-op and returns ``[]``.
# ---------------------------------------------------------------------------


def resolve_hierarchy_overlaps(
    *,
    session: Session,
    new_annotation_ids: Iterable[uuid.UUID],
    classes_by_id: dict[uuid.UUID, Class],
    iou_threshold: float = 0.7,
    enabled: bool = True,
) -> list[uuid.UUID]:
    """Drop ancestor annotations that overlap descendant ones.

    Pairs are evaluated symmetrically: for each pair (A, B) in the
    new set, if A's class is an ancestor of B's class AND their bboxes
    overlap above ``iou_threshold``, A is marked for deletion.

    The walk is restricted to ``new_annotation_ids`` so manual edits
    and prior-run annotations remain untouched.
    """
    if not enabled:
        return []
    new_ids = {nid for nid in new_annotation_ids if nid is not None}
    if not new_ids:
        return []
    if iou_threshold <= 0.0 or iou_threshold > 1.0:
        # Defensive — caller already clamps but a malformed payload
        # shouldn't crash the worker mid-batch.
        return []

    rows: list[Annotation] = list(
        session.execute(
            select(Annotation).where(Annotation.id.in_(new_ids))
        ).scalars()
    )

    # Pre-compute (annotation, bbox, ancestor_set) for each candidate.
    # Mask annotations and degenerate geometry contribute None bboxes
    # and are dropped from the candidate list (we can't compute IoU
    # for them and silently skipping is the right thing).
    enriched: list[tuple[Annotation, tuple[float, float, float, float], set[uuid.UUID]]] = []
    for ann in rows:
        bbox = _bbox_from_geometry(ann.geometry)
        if bbox is None:
            continue
        ancestors = _ancestors_of(ann.class_id, classes_by_id)
        enriched.append((ann, bbox, ancestors))

    if len(enriched) < 2:
        return []

    to_delete: set[uuid.UUID] = set()
    # Pairwise: for each descendant, find every other annotation whose
    # class is in the descendant's ancestor set and whose bbox overlaps.
    # Bound is O(N^2). Realistic per-asset N is small (typically <100;
    # racing scenes with 50 cars are extreme). We accept the simple
    # cost over a spatial index in v1.
    for desc_ann, desc_bbox, desc_ancestors in enriched:
        if not desc_ancestors:
            continue
        for anc_ann, anc_bbox, _ in enriched:
            if anc_ann.id == desc_ann.id:
                continue
            if anc_ann.id in to_delete:
                continue
            if anc_ann.class_id not in desc_ancestors:
                continue
            if _bbox_iou(desc_bbox, anc_bbox) < iou_threshold:
                continue
            to_delete.add(anc_ann.id)

    if to_delete:
        session.execute(
            sa_delete(Annotation).where(Annotation.id.in_(to_delete))
        )
        session.flush()
    return list(to_delete)


def build_classes_by_id_for_project(
    session: Session, project_id: uuid.UUID
) -> dict[uuid.UUID, Class]:
    """Load every class for ``project_id`` into a {id: Class} map.

    Used by callers that need a stable lookup table for the resolver's
    ancestor walk. The caller's session is reused so we don't open a
    second connection just for the lookup.
    """
    rows = session.execute(
        select(Class).where(Class.project_id == project_id)
    ).scalars()
    return {c.id: c for c in rows}


__all__ = [
    "resolve_hierarchy_overlaps",
    "build_classes_by_id_for_project",
    "MAX_CLASS_HIERARCHY_DEPTH",
]
