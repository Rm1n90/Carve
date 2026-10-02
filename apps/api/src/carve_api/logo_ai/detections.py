# Armin Mehri — mehri.armin@gmail.com
"""From a model's JSON answer to bbox annotations.

parse → map each view's boxes back to original pixels → merge the views
→ persist. The schema is enforced by the provider, but a refusal or a
truncated answer can still hand back something else, so parsing stays
defensive and a bad answer fails that one asset, never the run.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, replace

from sqlalchemy import delete as sa_delete
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.logo_ai.catalog import COORDS_GRID999
from carve_api.logo_ai.imaging import View
from carve_api.logo_ai.prompt import row_length

# Boxes thinner than this (in sent-image pixels) are noise, not logos.
_MIN_SIDE_PX = 2.0
# A tile box this close to an interior tile edge is assumed cut by it.
_EDGE_TOUCH_PX = 3.0
# Same-class boxes overlapping this much are one logo seen twice.
_DUPLICATE_IOU = 0.5


class BadModelOutput(ValueError):
    """The model's answer was not the JSON the schema promised."""


@dataclass(frozen=True)
class Detection:
    """One box in original-image pixels."""

    class_index: int  # 0-based into the run's target classes
    x1: float
    y1: float
    x2: float
    y2: float
    confidence: float
    # Percentage of the whole mark the model judged to be in view.
    visible: int = 100
    from_tile: bool = False
    # Touches an interior tile edge: probably a fragment of a logo that
    # continues in the neighbouring tile.
    edge_cut: bool = False

    @property
    def area(self) -> float:
        return max(0.0, self.x2 - self.x1) * max(0.0, self.y2 - self.y1)


def parse_detections(text: str, *, n_classes: int) -> list[dict]:
    """Validate the answer's shape; returns one dict per usable row.

    A row is ``[x1, y1, x2, y2, confidence, visible]``, with the class
    number in front when there is more than one class. OpenAI enforces
    the row length; Anthropic's schema cannot, so a row of the wrong
    length is dropped here rather than misread.
    """
    try:
        data = json.loads(text)
    except (TypeError, ValueError) as exc:
        raise BadModelOutput("answer is not valid JSON") from exc
    rows = data.get("detections") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise BadModelOutput("answer has no detections list")
    width = row_length(n_classes)
    out: list[dict] = []
    for row in rows:
        if not isinstance(row, list) or len(row) != width:
            continue
        try:
            values = [float(v) for v in row]
        except (TypeError, ValueError):
            continue
        label = int(values.pop(0)) if n_classes > 1 else 1
        if not 1 <= label <= n_classes:
            continue
        out.append(
            {
                "label": label,
                "box": values[:4],
                "confidence": values[4] / 100,
                "visible": int(values[5]),
            }
        )
    return out


def to_original(
    raw: list[dict], view: View, *, coords: str, image_w: int, image_h: int
) -> list[Detection]:
    """Map one view's boxes into original-image pixels."""
    dets: list[Detection] = []
    for item in raw:
        x1, y1, x2, y2 = item["box"]
        if coords == COORDS_GRID999:
            # The grid addresses pixel centres 0..w-1, as in OpenAI's
            # reference conversion.
            x1, x2 = (v * (view.out_w - 1) / 999 for v in (x1, x2))
            y1, y2 = (v * (view.out_h - 1) / 999 for v in (y1, y2))
        x1, x2 = sorted((min(max(x1, 0.0), view.out_w), min(max(x2, 0.0), view.out_w)))
        y1, y2 = sorted((min(max(y1, 0.0), view.out_h), min(max(y2, 0.0), view.out_h)))
        if x2 - x1 < _MIN_SIDE_PX or y2 - y1 < _MIN_SIDE_PX:
            continue
        edge_cut = view.is_tile and (
            (x1 <= _EDGE_TOUCH_PX and view.x0 > 0)
            or (y1 <= _EDGE_TOUCH_PX and view.y0 > 0)
            or (x2 >= view.out_w - _EDGE_TOUCH_PX and view.x1 < image_w)
            or (y2 >= view.out_h - _EDGE_TOUCH_PX and view.y1 < image_h)
        )
        ox1, oy1 = view.to_original(x1, y1)
        ox2, oy2 = view.to_original(x2, y2)
        dets.append(
            Detection(
                class_index=item["label"] - 1,
                x1=min(max(ox1, 0.0), image_w),
                y1=min(max(oy1, 0.0), image_h),
                x2=min(max(ox2, 0.0), image_w),
                y2=min(max(oy2, 0.0), image_h),
                confidence=min(max(item["confidence"], 0.0), 1.0),
                visible=min(max(item["visible"], 0), 100),
                from_tile=view.is_tile,
                edge_cut=edge_cut,
            )
        )
    return dets


def _intersection(a: Detection, b: Detection) -> float:
    w = min(a.x2, b.x2) - max(a.x1, b.x1)
    h = min(a.y2, b.y2) - max(a.y1, b.y1)
    return w * h if w > 0 and h > 0 else 0.0


def merge_detections(dets: list[Detection]) -> list[Detection]:
    """Collapse the same logo reported by several views into one box.

    Whole boxes beat edge-cut fragments, and among whole boxes a tile's
    beats the full frame's (it was drawn at higher resolution). Two
    fragments of one logo from neighbouring tiles are joined.
    """
    ordered = sorted(
        dets, key=lambda d: (d.edge_cut, not d.from_tile, -d.confidence)
    )
    kept: list[Detection] = []
    for d in ordered:
        if d.area <= 0:
            continue
        absorbed = False
        for i, k in enumerate(kept):
            if k.class_index != d.class_index:
                continue
            inter = _intersection(k, d)
            if inter <= 0:
                continue
            iou = inter / (k.area + d.area - inter)
            if iou >= _DUPLICATE_IOU:
                # The same logo in two views. A tile can cut a logo the
                # full frame shows whole, so the larger figure is the
                # one that describes the image.
                kept[i] = replace(
                    k,
                    confidence=max(k.confidence, d.confidence),
                    visible=max(k.visible, d.visible),
                )
                absorbed = True
                break
            if d.edge_cut and inter / d.area >= 0.7:
                kept[i] = replace(k, confidence=max(k.confidence, d.confidence))
                absorbed = True
                break
            if k.edge_cut and d.edge_cut and inter / min(k.area, d.area) >= 0.3:
                kept[i] = replace(
                    k,
                    x1=min(k.x1, d.x1), y1=min(k.y1, d.y1),
                    x2=max(k.x2, d.x2), y2=max(k.y2, d.y2),
                    confidence=max(k.confidence, d.confidence),
                    visible=max(k.visible, d.visible),
                )
                absorbed = True
                break
        if not absorbed:
            kept.append(d)
    return kept


@dataclass
class PersistResult:
    annotations: list[Annotation]
    # Overwrite was requested but nothing was detected, so the existing
    # annotations were left alone rather than replaced with nothing.
    overwrite_skipped: bool = False


def persist_detections(
    session: Session,
    *,
    task_id: uuid.UUID,
    frame_id: uuid.UUID | None,
    actor_id: uuid.UUID | None,
    class_ids: list[uuid.UUID],
    dets: list[Detection],
    min_confidence: float,
    min_visible: int = 0,
    overwrite: bool,
) -> PersistResult:
    """Write the boxes as ``proposed`` bbox annotations on one frame.

    Does not commit. Mirrors the other auto-annotate paths: ``overwrite``
    only clears the frame when there is something to put in its place.
    """
    new_anns = [
        Annotation(
            task_id=task_id,
            frame_id=frame_id,
            class_id=class_ids[d.class_index],
            kind=AnnotationKind.bbox,
            geometry={
                "kind": "bbox",
                "x": round(d.x1, 1),
                "y": round(d.y1, 1),
                "w": round(d.x2 - d.x1, 1),
                "h": round(d.y2 - d.y1, 1),
            },
            track_id=None,
            created_by=actor_id,
            # Kept so the box can be filtered later without a new run.
            confidence=round(d.confidence, 4),
            visible=d.visible,
        )
        for d in dets
        if d.confidence >= min_confidence and d.visible >= min_visible
    ]
    overwrite_skipped = False
    if overwrite and frame_id is not None:
        if new_anns:
            session.execute(
                sa_delete(Annotation).where(
                    Annotation.task_id == task_id,
                    Annotation.frame_id == frame_id,
                )
            )
        else:
            overwrite_skipped = True
    session.add_all(new_anns)
    session.flush()
    return PersistResult(annotations=new_anns, overwrite_skipped=overwrite_skipped)
