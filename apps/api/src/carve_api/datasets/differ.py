"""Differ for two ``DatasetVersion`` YOLO bundles (Plan-13 Phase 7 Task 6).

Given two dataset versions whose ``blob_key`` points at a YOLO bundle in
MinIO (``data.yaml`` + ``labels/<split>/*.txt`` + ``images/<split>/*``),
download both bundles, parse the per-image label files, and report:

  * ``added``    -- class_name -> bbox/poly count present only in B
  * ``removed``  -- class_name -> bbox/poly count present only in A
  * ``changed``  -- class_name -> count moved/edited (heuristic, see below)
  * ``by_image`` -- per-image breakdown of added/removed/changed
  * ``summary_a`` / ``summary_b`` -- aggregate counts per side

Heuristic for ``changed``: same image + same class index, but the bbox
center moved by more than 5% of the corresponding image dimension (so a
50px shift on a 1000px-wide image counts as a change). For polygons the
heuristic uses the centroid of the polygon's points. Annotations beyond
the count common to both sides are NOT counted as changes -- they fall
into ``added`` / ``removed`` so totals reconcile.

COCO bundles are not supported in v1; if either side is a COCO bundle
(missing ``data.yaml`` and ``labels/`` tree, or has ``coco.json``) the
differ returns an empty diff with ``note='coco_unsupported_v1'`` so
callers can surface a clear UI message.
"""

from __future__ import annotations

import io
import logging
import zipfile
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)

_CENTER_THRESHOLD = 0.05  # 5% of image dimension


@dataclass
class DatasetDiff:
    added: dict[str, int] = field(default_factory=dict)
    removed: dict[str, int] = field(default_factory=dict)
    changed: dict[str, int] = field(default_factory=dict)
    by_image: list[dict[str, Any]] = field(default_factory=list)
    summary_a: dict[str, Any] = field(default_factory=dict)
    summary_b: dict[str, Any] = field(default_factory=dict)
    note: str | None = None


def _parse_data_yaml_names(text: str) -> list[str]:
    """Minimal YAML parser for the ``names: [...]`` line we emit.

    The YOLO writer in :mod:`carve_api.io.yolo_out` always renders names
    as a single inline list (`names: ["a", "b"]`), so we don't pull in a
    full YAML dependency just for this. Returns an empty list when the
    line isn't found or can't be parsed.
    """
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith("names:"):
            continue
        body = line.split("names:", 1)[1].strip()
        if not body.startswith("[") or not body.endswith("]"):
            return []
        inner = body[1:-1].strip()
        if not inner:
            return []
        out: list[str] = []
        for token in inner.split(","):
            tok = token.strip()
            if (tok.startswith('"') and tok.endswith('"')) or (
                tok.startswith("'") and tok.endswith("'")
            ):
                tok = tok[1:-1]
            out.append(tok)
        return out
    return []


@dataclass
class _ParsedAnn:
    class_idx: int
    cx: float  # normalised 0..1
    cy: float  # normalised 0..1


def _parse_label_line(line: str) -> _ParsedAnn | None:
    parts = line.strip().split()
    if not parts:
        return None
    try:
        idx = int(parts[0])
    except ValueError:
        return None
    coords = parts[1:]
    if not coords:
        # Tag line (just the class index) -- treat center as (0, 0) so
        # any subsequent edit looks like a change rather than a new
        # tag. The 5% threshold is only meaningful for geometry kinds;
        # tags compare by class only.
        return _ParsedAnn(class_idx=idx, cx=0.0, cy=0.0)
    try:
        floats = [float(x) for x in coords]
    except ValueError:
        return None
    if len(floats) == 4:
        # YOLO bbox: cx cy w h (already normalised)
        return _ParsedAnn(class_idx=idx, cx=floats[0], cy=floats[1])
    # Polygon: pairs of (x, y) -- compute centroid.
    pairs = [(floats[i], floats[i + 1]) for i in range(0, len(floats) - 1, 2)]
    if not pairs:
        return None
    cx = sum(p[0] for p in pairs) / len(pairs)
    cy = sum(p[1] for p in pairs) / len(pairs)
    return _ParsedAnn(class_idx=idx, cx=cx, cy=cy)


@dataclass
class _ParsedBundle:
    class_names: list[str]
    by_image: dict[str, list[_ParsedAnn]]  # image stem -> [_ParsedAnn]
    is_coco: bool = False


def _parse_bundle(zip_bytes: bytes) -> _ParsedBundle:
    """Parse a YOLO zip bundle in memory. COCO is detected and flagged."""
    by_image: dict[str, list[_ParsedAnn]] = defaultdict(list)
    class_names: list[str] = []
    is_coco = False
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
            names = zf.namelist()
            if any(n == "coco.json" or n.endswith("/coco.json") for n in names):
                is_coco = True
            for name in names:
                if name == "data.yaml":
                    try:
                        text = zf.read(name).decode("utf-8")
                    except UnicodeDecodeError:
                        text = ""
                    class_names = _parse_data_yaml_names(text)
                    continue
                # YOLO label files live under labels/<split>/<stem>.txt
                if not name.startswith("labels/"):
                    continue
                if not name.endswith(".txt"):
                    continue
                # Use the basename (stem) as the image key so train/val/test
                # don't double-count the same image across splits.
                stem = name.rsplit("/", 1)[-1].rsplit(".", 1)[0]
                if not stem:
                    continue
                try:
                    body = zf.read(name).decode("utf-8")
                except UnicodeDecodeError:
                    continue
                for line in body.splitlines():
                    parsed = _parse_label_line(line)
                    if parsed is not None:
                        by_image[stem].append(parsed)
    except zipfile.BadZipFile:
        log.warning("dataset.differ: bad zip; treating as empty")
    return _ParsedBundle(
        class_names=class_names, by_image=dict(by_image), is_coco=is_coco
    )


def _name_for(idx: int, names: list[str]) -> str:
    if 0 <= idx < len(names):
        return names[idx]
    return f"class_{idx}"


def _summary(bundle: _ParsedBundle) -> dict[str, Any]:
    counts: dict[str, int] = defaultdict(int)
    total = 0
    for anns in bundle.by_image.values():
        for ann in anns:
            counts[_name_for(ann.class_idx, bundle.class_names)] += 1
            total += 1
    return {
        "total_annotations": total,
        "by_class": dict(counts),
        "image_count": len(bundle.by_image),
        "classes": list(bundle.class_names),
    }


def diff_bundles(zip_a: bytes, zip_b: bytes) -> DatasetDiff:
    """Compute the diff between two YOLO bundles. Public entry point.

    The bundles are parsed in-memory; nothing is written to disk.
    """
    a = _parse_bundle(zip_a)
    b = _parse_bundle(zip_b)
    diff = DatasetDiff(summary_a=_summary(a), summary_b=_summary(b))
    if a.is_coco or b.is_coco:
        diff.note = "coco_unsupported_v1"
        return diff

    added: dict[str, int] = defaultdict(int)
    removed: dict[str, int] = defaultdict(int)
    changed: dict[str, int] = defaultdict(int)
    by_image_rows: list[dict[str, Any]] = []

    images = sorted(set(a.by_image) | set(b.by_image))
    for image in images:
        per_added = 0
        per_removed = 0
        per_changed = 0
        a_anns = sorted(a.by_image.get(image, []), key=lambda x: x.class_idx)
        b_anns = sorted(b.by_image.get(image, []), key=lambda x: x.class_idx)
        # Bucket by class index so we can pair them up greedily.
        a_by_cls: dict[int, list[_ParsedAnn]] = defaultdict(list)
        b_by_cls: dict[int, list[_ParsedAnn]] = defaultdict(list)
        for ann in a_anns:
            a_by_cls[ann.class_idx].append(ann)
        for ann in b_anns:
            b_by_cls[ann.class_idx].append(ann)
        all_classes = set(a_by_cls) | set(b_by_cls)
        for cls in all_classes:
            la = a_by_cls.get(cls, [])
            lb = b_by_cls.get(cls, [])
            common = min(len(la), len(lb))
            # Reconcile common pairs in order; anything past ``common``
            # is a pure add or remove.
            for i in range(common):
                aa = la[i]
                bb = lb[i]
                dx = abs(aa.cx - bb.cx)
                dy = abs(aa.cy - bb.cy)
                if dx > _CENTER_THRESHOLD or dy > _CENTER_THRESHOLD:
                    name = _name_for(cls, b.class_names or a.class_names)
                    changed[name] += 1
                    per_changed += 1
            if len(lb) > len(la):
                name = _name_for(cls, b.class_names or a.class_names)
                added[name] += len(lb) - len(la)
                per_added += len(lb) - len(la)
            elif len(la) > len(lb):
                name = _name_for(cls, a.class_names or b.class_names)
                removed[name] += len(la) - len(lb)
                per_removed += len(la) - len(lb)
        if per_added or per_removed or per_changed:
            by_image_rows.append({
                "image": image,
                "added": per_added,
                "removed": per_removed,
                "changed": per_changed,
            })

    diff.added = dict(added)
    diff.removed = dict(removed)
    diff.changed = dict(changed)
    diff.by_image = by_image_rows
    return diff


def parse_bundle_for_rollback(
    zip_bytes: bytes,
) -> tuple[list[str], dict[str, list[dict[str, Any]]]]:
    """Parse a YOLO bundle and return (class_names, image_stem -> annotations).

    Each annotation is ``{"class_idx": int, "kind": "bbox"|"polygon",
    "geometry": {...}}`` — geometry is stored in the same shape the
    Annotation model already uses, with normalised YOLO coords scaled
    back to absolute pixels by the rollback service when image
    dimensions are known. We keep coords normalised here because the
    rollback service is the layer that joins back to ``Asset.width/height``.
    """
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    class_names: list[str] = []
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
            for name in zf.namelist():
                if name == "data.yaml":
                    try:
                        text = zf.read(name).decode("utf-8")
                    except UnicodeDecodeError:
                        text = ""
                    class_names = _parse_data_yaml_names(text)
                    continue
                if not name.startswith("labels/") or not name.endswith(".txt"):
                    continue
                stem = name.rsplit("/", 1)[-1].rsplit(".", 1)[0]
                try:
                    body = zf.read(name).decode("utf-8")
                except UnicodeDecodeError:
                    continue
                for line in body.splitlines():
                    parts = line.strip().split()
                    if not parts:
                        continue
                    try:
                        cls_idx = int(parts[0])
                    except ValueError:
                        continue
                    coords = parts[1:]
                    if len(coords) == 4:
                        try:
                            cx, cy, w, h = (float(x) for x in coords)
                        except ValueError:
                            continue
                        out[stem].append({
                            "class_idx": cls_idx,
                            "kind": "bbox",
                            "geometry_norm": {
                                "cx": cx, "cy": cy, "w": w, "h": h
                            },
                        })
                    elif len(coords) >= 6 and len(coords) % 2 == 0:
                        try:
                            floats = [float(x) for x in coords]
                        except ValueError:
                            continue
                        pts = [
                            (floats[i], floats[i + 1])
                            for i in range(0, len(floats) - 1, 2)
                        ]
                        out[stem].append({
                            "class_idx": cls_idx,
                            "kind": "polygon",
                            "geometry_norm": {"points": pts},
                        })
    except zipfile.BadZipFile:
        log.warning("dataset.rollback: bad zip; nothing to restore")
    return class_names, dict(out)
