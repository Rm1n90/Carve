"""COCO writer — builds a coco.json dict from Annotation rows + image metadata.

Pure function. Caller groups annotations by image and supplies an ``images``
list with `{id, file_name, width, height}` dicts. Returns the full COCO json.
"""

from typing import Any

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.io.yolo_out import _normalise_remap


def build_coco(
    *,
    images: list[dict],
    annotations_by_image_id: dict[int, list[Annotation]],
    remap: dict,
) -> dict[str, Any]:
    """Build a COCO-format dict.

    ``images`` — list of {id (int), file_name, width, height}.
    ``annotations_by_image_id`` — image_id (int) → annotations on that image.
    ``remap`` — same shape as YOLO writer.
    """
    targets = _normalise_remap(remap)
    images_by_id = {img["id"]: img for img in images}

    categories: dict[int, dict] = {}
    coco_anns: list[dict] = []
    next_id = 1

    for img_id, anns in annotations_by_image_id.items():
        if img_id not in images_by_id:
            raise ValueError(f"annotations reference unknown image id {img_id}")
        img = images_by_id[img_id]
        for ann in anns:
            target = targets.get(str(ann.class_id))
            if target is None:
                continue
            cat_id = target.export_id
            categories.setdefault(cat_id, {"id": cat_id, "name": target.name})
            entry: dict[str, Any] = {
                "id": next_id,
                "image_id": img_id,
                "category_id": cat_id,
                "iscrowd": 0,
            }
            next_id += 1
            g = ann.geometry
            if ann.kind == AnnotationKind.bbox:
                entry["bbox"] = [
                    float(g["x"]), float(g["y"]),
                    float(g["w"]), float(g["h"]),
                ]
                entry["area"] = float(g["w"]) * float(g["h"])
            elif ann.kind == AnnotationKind.polygon:
                pts = [[float(p[0]), float(p[1])] for p in g["points"]]
                flat = [c for p in pts for c in p]
                bbox = _polygon_bbox(pts)
                entry["bbox"] = bbox
                entry["area"] = bbox[2] * bbox[3]
                entry["segmentation"] = [flat]
            elif ann.kind == AnnotationKind.mask:
                entry["segmentation"] = {"size": list(g["size"]), "counts": str(g["counts"])}
                entry["bbox"] = [0.0, 0.0, float(img["width"]), float(img["height"])]
                entry["area"] = float(img["width"]) * float(img["height"])
            elif ann.kind == AnnotationKind.tag:
                entry["bbox"] = [0.0, 0.0, float(img["width"]), float(img["height"])]
                entry["area"] = float(img["width"]) * float(img["height"])
            coco_anns.append(entry)

    return {
        "info": {"description": "Carve export", "version": "1.0"},
        "images": list(images),  # preserve caller order
        "annotations": coco_anns,
        "categories": [categories[k] for k in sorted(categories)],
    }


def _polygon_bbox(points: list[list[float]]) -> list[float]:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    x = min(xs)
    y = min(ys)
    w = max(xs) - x
    h = max(ys) - y
    return [x, y, w, h]
