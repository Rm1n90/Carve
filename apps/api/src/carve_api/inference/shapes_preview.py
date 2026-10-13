# Armin Mehri — mehri.armin@gmail.com
"""An image with its annotations drawn on it, as a JPEG.

What the box-convert dialog shows for the images it just converted:
masks and polygons filled in their class colour and outlined, boxes
still left as boxes outlined only. Large shapes are drawn first so the
small objects on them stay visible.
"""

from __future__ import annotations

import io

import cv2
import numpy as np
from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, Frame
from carve_api.io.mask_polygon import decode_rle
from carve_api.projects.models import Class

MAX_WIDTH = 2048


def _rgb(hex_color: str | None) -> tuple[int, int, int]:
    s = (hex_color or "#ff00ff").lstrip("#")
    try:
        return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
    except (ValueError, IndexError):
        return 255, 0, 255


def _area(kind, g: dict) -> float:
    if kind == AnnotationKind.bbox:
        return float(g.get("w", 0)) * float(g.get("h", 0))
    if kind == AnnotationKind.polygon:
        pts = np.asarray(g.get("points") or [], dtype=np.float32)
        return float(cv2.contourArea(pts)) if len(pts) >= 3 else 0.0
    if kind == AnnotationKind.mask:
        runs = [int(r) for r in str(g.get("counts", "")).replace(" ", ",").split(",") if r]
        return float(sum(runs[1::2]))
    return 0.0


def render(
    session: Session, task_id, asset: Asset, image_bytes: bytes, *, width: int = 640
) -> bytes:
    img = np.array(Image.open(io.BytesIO(image_bytes)).convert("RGB"))
    h, w = img.shape[:2]
    scale = min(1.0, min(width, MAX_WIDTH) / max(1, w))
    pw, ph = max(1, round(w * scale)), max(1, round(h * scale))
    base = cv2.resize(img, (pw, ph), interpolation=cv2.INTER_AREA) if scale < 1 else img.copy()

    frame_id = session.execute(
        select(Frame.id).where(Frame.asset_id == asset.id).order_by(Frame.idx).limit(1)
    ).scalar_one_or_none()
    rows = []
    if frame_id is not None:
        rows = session.execute(
            select(Annotation.kind, Annotation.geometry, Class.color)
            .outerjoin(Class, Class.id == Annotation.class_id)
            .where(Annotation.task_id == task_id, Annotation.frame_id == frame_id)
        ).all()
    rows = sorted(rows, key=lambda r: -_area(r[0], r[1] or {}))

    fill = base.copy()
    outlines: list = []
    for kind, g, color in rows:
        g = g or {}
        c = _rgb(color)
        if kind == AnnotationKind.mask:
            m = decode_rle(str(g.get("counts", "")), tuple(g.get("size") or (0, 0)))
            if m is None:
                continue
            if m.shape != (ph, pw):
                m = cv2.resize(m, (pw, ph), interpolation=cv2.INTER_NEAREST)
            fill[m > 0] = c
            cs, _ = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
            outlines.append((cs, c))
        elif kind == AnnotationKind.polygon:
            pts = np.round(np.asarray(g.get("points") or [], dtype=np.float32) * scale).astype(
                np.int32
            )
            if len(pts) < 3:
                continue
            cv2.fillPoly(fill, [pts], c)
            outlines.append(([pts], c))
        elif kind == AnnotationKind.bbox:
            x, y = float(g.get("x", 0)) * scale, float(g.get("y", 0)) * scale
            bw, bh = float(g.get("w", 0)) * scale, float(g.get("h", 0)) * scale
            pts = np.round(np.array([[x, y], [x + bw, y], [x + bw, y + bh], [x, y + bh]])).astype(
                np.int32
            )
            outlines.append(([pts], c))
    out = cv2.addWeighted(fill, 0.45, base, 0.55, 0)
    thick = 1 if pw < 900 else 2
    for cs, c in outlines:
        cv2.polylines(out, cs, True, c, thick, cv2.LINE_AA)
    buf = io.BytesIO()
    Image.fromarray(out).save(buf, format="JPEG", quality=82)
    return buf.getvalue()
