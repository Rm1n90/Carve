# Armin Mehri — mehri.armin@gmail.com
"""COCO writer — builds a coco.json dict from Annotation rows + image metadata.

Pure function. Caller groups annotations by image and supplies an ``images``
list with `{id, file_name, width, height}` dicts. Returns the full COCO json.
"""

from typing import Any

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.io.rle import _decode_runs, rle_count_pixels, rle_to_bbox
from carve_api.io.yolo_out import _normalise_remap


def build_coco(
    *,
    images: list[dict],
    annotations_by_image_id: dict[int, list[Annotation]],
    remap: dict,
) -> dict[str, Any]:
    """Build a COCO-format dict.

    Per-kind handling (Plan-20):

    * ``bbox``    — emitted as ``bbox: [x, y, w, h]`` with ``area = w*h``
                    and its rectangle as ``segmentation``: COCO readers
                    (pycocotools, mask trainers) expect one on every
                    annotation.
    * ``polygon`` — emitted with ``segmentation: [[flat coords]]`` and
                    a derived ``bbox``/``area`` from the polygon's
                    axis-aligned bounding box.
    * ``mask``    — emitted with ``segmentation: {size, counts}`` (COCO
                    RLE), and crucially ``bbox`` is the mask's own
                    tight bounding box and ``area`` is the foreground
                    pixel count (decoded once via the RLE helper).
                    Earlier code used ``[0,0,W,H]`` and ``W*H`` for
                    both, which is technically COCO-shaped but useless
                    for any IoU / area-based filtering downstream.
    * ``tag``     — NOT emitted into ``annotations``. The export job
                    pulls these via ``extract_image_tags_for_coco`` and
                    writes them to a separate ``image_tags.json`` so
                    consumers don't see whole-image bboxes pretending
                    to be image-level labels.

    ``images`` — list of {id (int), file_name, width, height}.
    ``annotations_by_image_id`` — image_id (int) → annotations on that image.
    ``remap`` — same shape as YOLO writer.

    Category ids are the export ids plus one: COCO ids start at 1, and
    readers that keep 0 for the background (torchvision) or subtract one
    (Ultralytics' converter) lose the first class otherwise. Every class
    of the remap is a category, used or not, so the class count matches
    ``classes.json`` and the YOLO export.
    """
    targets = _normalise_remap(remap)
    images_by_id = {img["id"]: img for img in images}

    categories: dict[int, dict] = {}
    for target in targets.values():
        if target is not None:
            categories.setdefault(
                target.export_id + 1, {"id": target.export_id + 1, "name": target.name},
            )
    coco_anns: list[dict] = []
    next_id = 1

    for img_id, anns in annotations_by_image_id.items():
        if img_id not in images_by_id:
            raise ValueError(f"annotations reference unknown image id {img_id}")
        for ann in anns:
            if ann.kind == AnnotationKind.tag:
                # Image-level labels live in the sidecar, not in the
                # COCO annotations array.
                continue
            target = targets.get(str(ann.class_id))
            if target is None:
                continue
            cat_id = target.export_id + 1
            entry: dict[str, Any] = {
                "id": next_id,
                "image_id": img_id,
                "category_id": cat_id,
                "iscrowd": 0,
            }
            next_id += 1
            g = ann.geometry
            if ann.kind == AnnotationKind.bbox:
                x, y, w, h = float(g["x"]), float(g["y"]), float(g["w"]), float(g["h"])
                entry["bbox"] = [x, y, w, h]
                entry["area"] = w * h
                entry["segmentation"] = [[x, y, x + w, y, x + w, y + h, x, y + h]]
            elif ann.kind == AnnotationKind.polygon:
                pts = [[float(p[0]), float(p[1])] for p in g["points"]]
                flat = [c for p in pts for c in p]
                bbox = _polygon_bbox(pts)
                entry["bbox"] = bbox
                entry["area"] = _polygon_area(pts)
                entry["segmentation"] = [flat]
            elif ann.kind == AnnotationKind.mask:
                counts = str(g["counts"])
                size = (int(g["size"][0]), int(g["size"][1]))
                box = rle_to_bbox(counts, size)
                if box is None:
                    # Empty mask — drop the row entirely. A [0,0,0,0]
                    # bbox would silently break IoU/area filters
                    # downstream.
                    next_id -= 1  # roll back the reserved id
                    continue
                # Uncompressed COCO RLE: counts as a list of ints, which
                # pycocotools and every COCO reader understand.
                entry["segmentation"] = {"size": list(size), "counts": _decode_runs(counts)}
                x, y, mw, mh = box
                entry["bbox"] = [float(x), float(y), float(mw), float(mh)]
                entry["area"] = float(rle_count_pixels(counts))
            coco_anns.append(entry)

    return {
        "info": {"description": "Carve export", "version": "1.0"},
        "images": list(images),  # preserve caller order
        "annotations": coco_anns,
        "categories": [categories[k] for k in sorted(categories)],
    }


def extract_image_tags_for_coco(
    images: list[dict],
    annotations_by_image_id: dict[int, list[Annotation]],
    remap: dict,
) -> list[dict[str, Any]]:
    """Plan-20 — collect ``kind=tag`` annotations per image into a
    sidecar payload.

    Returns a list of ``{image_id, file_name, tags: [{category_id, name}]}``
    entries with stable image ordering. COCO has no canonical image-level
    classification field, so the export job writes this as
    ``image_tags.json`` next to ``coco.json``.
    """
    targets = _normalise_remap(remap)
    images_by_id = {img["id"]: img for img in images}
    out: list[dict[str, Any]] = []
    for img_id, anns in annotations_by_image_id.items():
        img = images_by_id.get(img_id)
        if img is None:
            continue
        tags: list[dict[str, Any]] = []
        for ann in anns:
            if ann.kind != AnnotationKind.tag:
                continue
            target = targets.get(str(ann.class_id))
            if target is None:
                continue
            tags.append(
                {"category_id": int(target.export_id) + 1, "name": str(target.name)},
            )
        if tags:
            out.append(
                {
                    "image_id": int(img_id),
                    "file_name": str(img["file_name"]),
                    "tags": tags,
                },
            )
    out.sort(key=lambda e: e["image_id"])
    return out


def _polygon_area(points: list[list[float]]) -> float:
    """Shoelace area: COCO's ``area`` is the region's, not its box's."""
    n = len(points)
    s = sum(
        points[i][0] * points[(i + 1) % n][1] - points[(i + 1) % n][0] * points[i][1]
        for i in range(n)
    )
    return abs(s) / 2.0


def _polygon_bbox(points: list[list[float]]) -> list[float]:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    x = min(xs)
    y = min(ys)
    w = max(xs) - x
    h = max(ys) - y
    return [x, y, w, h]
