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
        results = sam_text_prompt_for_asset(asset, prompt)

        # Score filter.
        kept = [r for r in results if float(r.get("score", 0.0)) >= threshold]
        # Best-only collapses to argmax after filtering so the threshold
        # still applies (best of nothing is nothing).
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

    return {
        "annotations_created": len(new_anns),
        "per_class": per_class,
        "ineligible": ineligible_ids,
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
