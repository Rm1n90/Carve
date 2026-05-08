"""Multi-source SAM 3.1 visual-prompt auto-annotate.

Mirrors auto_text.py shape; replaces text concept with visual exemplars.
See spec docs/superpowers/specs/2026-05-08-sam-visual-prompt-design.md §5.3
for the (source, class) dispatch ordering.
"""
from __future__ import annotations

import uuid

from sqlalchemy import delete as sa_delete
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset
from carve_api.errors import AppError
from carve_api.inference.autoannotate import _resolve_frame_id
from carve_api.inference.sam import sam_visual_prompt_for_asset
from carve_api.projects.models import Task


class AutoVisualMixedRefs(AppError):
    """Mixed bbox + polygon refs in a single run."""

    http_status = 422
    code = "mixed_ref_types"


class AutoVisualNoRefs(AppError):
    """No source refs supplied (or filtered to empty)."""

    http_status = 422
    code = "no_refs"


class AutoVisualNoClass(AppError):
    """At least one ref group has an empty class_id."""

    http_status = 422
    code = "no_class_assignment"


def auto_visual_for_asset(
    *,
    session: Session,
    asset: Asset,
    task: Task,
    sources: list[dict],
    ref_kind: str,
    threshold: float,
    find_all: bool,
    overwrite: bool,
    actor_id: uuid.UUID | None,
) -> dict:
    """Run SAM 3.1 visual prompt for each (source asset, class) group.

    Args:
        sources: ``[{asset_id: str, groups: [{class_id, refs: [...]}]}, ...]``.
            ``refs`` are ``{kind: "bbox", xyxy} | {kind: "polygon", points}``.
        ref_kind: ``"bbox"`` or ``"polygon"`` -- must match every ref's kind.
        threshold: minimum SAM score to keep (0..1).
        find_all: True keeps every match above threshold; False collapses
            to the highest-scored match per (source, class).
        overwrite: when True AND at least one new annotation will land,
            existing annotations of the touched classes on this asset's
            frame are deleted first (compute-first/delete-second safety
            mirroring auto_text_for_asset).
        actor_id: stamped into ``Annotation.created_by``.

    Returns:
        ``{"annotations_created": int, "per_class": {class_id: count}}``.
    """
    if not sources:
        raise AutoVisualNoRefs("no_refs")

    seen_kinds: set[str] = set()
    for src in sources:
        for grp in src["groups"]:
            if not grp.get("class_id"):
                raise AutoVisualNoClass("no_class_assignment")
            for ref in grp["refs"]:
                seen_kinds.add(ref["kind"])
    if len(seen_kinds) > 1 or (seen_kinds and ref_kind not in seen_kinds):
        raise AutoVisualMixedRefs("mixed_ref_types")
    if not seen_kinds:
        raise AutoVisualNoRefs("no_refs")

    frame_id = _resolve_frame_id(session, asset)
    new_anns: list[Annotation] = []
    per_class: dict[str, int] = {}
    touched_class_ids: set[uuid.UUID] = set()

    asset_cache: dict[str, Asset] = {}

    def _refer_asset(asset_id: str) -> Asset:
        if asset_id not in asset_cache:
            asset_cache[asset_id] = session.get(Asset, uuid.UUID(asset_id))
        return asset_cache[asset_id]

    # v3.28 — class lookup: SAM 3.1 doesn't natively support cross-image
    # visual prompting, so we bridge the visual ref to TEXT via FO1
    # captioning + fall back to the project class's text_prompt or name
    # when the captioner returns blank. Cache per-class lookups.
    from carve_api.projects.models import Class as ClassModel

    class_cache: dict[uuid.UUID, ClassModel | None] = {}

    def _class(cls_id: uuid.UUID) -> ClassModel | None:
        if cls_id not in class_cache:
            class_cache[cls_id] = session.get(ClassModel, cls_id)
        return class_cache[cls_id]

    for src in sources:
        refer = _refer_asset(src["asset_id"])
        for grp in src["groups"]:
            cls_id = uuid.UUID(grp["class_id"])
            touched_class_ids.add(cls_id)
            # Build text_hint for the visual-prompt → SAM 3.1 text-prompt
            # bridge. Priority: class.text_prompt (curated, high-signal)
            # → class.name (low-signal but better than nothing). The
            # model service will prefer FO1 caption when available and
            # fall back to this hint when the captioner is unavailable
            # or returns blank.
            cls_obj = _class(cls_id)
            text_hint = ""
            if cls_obj is not None:
                tp = (cls_obj.text_prompt or "").strip()
                text_hint = tp if tp else (cls_obj.name or "").strip()

            # v3.28 — push the user's threshold + text hint through to
            # the model service. The api-side ``>= threshold`` check
            # below stays as a defence-in-depth for older model builds
            # that ignore the kwarg.
            results = sam_visual_prompt_for_asset(
                target_asset=asset,
                refer_asset=refer,
                regions=grp["refs"],
                threshold=threshold,
                text_hint=text_hint or None,
            )
            kept = [r for r in results if float(r.get("score", 0.0)) >= threshold]
            if not find_all and kept:
                kept = [max(kept, key=lambda r: float(r.get("score", 0.0)))]
            per_class[str(cls_id)] = per_class.get(str(cls_id), 0) + len(kept)
            for r in kept:
                new_anns.append(
                    _build_annotation(
                        task, frame_id, cls_id, r, actor_id, ref_kind,
                    )
                )

    if overwrite and new_anns and frame_id is not None:
        session.execute(
            sa_delete(Annotation).where(
                Annotation.task_id == task.id,
                Annotation.frame_id == frame_id,
                Annotation.class_id.in_(list(touched_class_ids)),
            )
        )
    for ann in new_anns:
        session.add(ann)
    session.flush()
    return {"annotations_created": len(new_anns), "per_class": per_class}


def _build_annotation(
    task: Task, frame_id, cls_id, r: dict, actor_id, ref_kind: str,
) -> Annotation:
    """Build an Annotation row from one model-service result.

    v3.28 — output kind mirrors the input ref kind:
      - ref_kind == "bbox"    → AnnotationKind.bbox    (xywh from r["bbox"])
      - ref_kind == "polygon" → AnnotationKind.polygon (r["polygon"] points)

    Falls back to mask_rle only when the requested kind cannot be built
    from the result (e.g. polygon requested but the polygonizer returned
    empty for a degenerate mask).
    """
    if ref_kind == "bbox":
        bbox = r.get("bbox") or []
        if isinstance(bbox, list) and len(bbox) == 4:
            x1, y1, x2, y2 = (float(v) for v in bbox)
            return Annotation(
                task_id=task.id,
                frame_id=frame_id,
                class_id=cls_id,
                kind=AnnotationKind.bbox,
                geometry={
                    "kind": "bbox",
                    "x": x1,
                    "y": y1,
                    "w": max(0.0, x2 - x1),
                    "h": max(0.0, y2 - y1),
                },
                track_id=None,
                created_by=actor_id,
            )
        # Degenerate bbox — fall through to polygon then mask fallback.

    polygon = r.get("polygon") or []
    if isinstance(polygon, list) and len(polygon) >= 3:
        return Annotation(
            task_id=task.id,
            frame_id=frame_id,
            class_id=cls_id,
            kind=AnnotationKind.polygon,
            geometry={
                "kind": "polygon",
                "points": [[float(p[0]), float(p[1])] for p in polygon],
            },
            track_id=None,
            created_by=actor_id,
        )

    # Last-resort mask_rle fallback. Reached when both bbox and polygon
    # are degenerate but the model still produced a valid mask.
    return Annotation(
        task_id=task.id,
        frame_id=frame_id,
        class_id=cls_id,
        kind=AnnotationKind.mask,
        geometry={
            "kind": "mask_rle",
            "size": [int(r["size"][0]), int(r["size"][1])],
            "counts": r["counts"],
        },
        track_id=None,
        created_by=actor_id,
    )
