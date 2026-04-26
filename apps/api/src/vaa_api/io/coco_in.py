"""COCO importer.

Parses a coco.json (or a ZIP containing one) into a list of AnnotationDraft
dicts. Pixel coordinates pass through unchanged.
"""

import json
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any

from vaa_api.annotations.models import AnnotationKind
from vaa_api.io.yolo_in import AnnotationDraft, ParsedArchive

# Zip-bomb / oversized-archive mitigations. Limits apply to uncompressed size
# (the central-directory ``file_size``) before any read is performed.
_MAX_MEMBER_BYTES = 256 * 1024 * 1024  # 256 MiB per file inside the archive
_MAX_TOTAL_UNCOMPRESSED = 4 * 1024 * 1024 * 1024  # 4 GiB total uncompressed


def parse_coco_bytes(coco_bytes: bytes) -> ParsedArchive:
    """Parse raw coco.json bytes."""
    out = ParsedArchive()
    try:
        coco = json.loads(coco_bytes)
    except json.JSONDecodeError as exc:
        raise ValueError(f"not valid JSON: {exc}") from exc

    images_by_id: dict[int, dict] = {int(img["id"]): img for img in coco.get("images", [])}
    categories_by_id: dict[int, str] = {
        int(cat["id"]): cat["name"] for cat in coco.get("categories", [])
    }
    out.class_names = [categories_by_id[k] for k in sorted(categories_by_id)]

    for ann in coco.get("annotations", []):
        img_id = int(ann["image_id"])
        cat_id = int(ann["category_id"])
        if img_id not in images_by_id:
            out.warnings.append(f"annotation {ann.get('id')} references unknown image_id {img_id}")
            continue
        if cat_id not in categories_by_id:
            out.warnings.append(f"annotation {ann.get('id')} references unknown category_id {cat_id}")
            continue
        image = images_by_id[img_id]
        image_filename = Path(image["file_name"]).stem  # match by stem like YOLO
        cls_name = categories_by_id[cat_id]

        # Mask (RLE) takes priority over polygon takes priority over bbox-only
        seg = ann.get("segmentation")
        if isinstance(seg, dict) and "counts" in seg and "size" in seg:
            out.drafts.append(AnnotationDraft(
                image_filename=image_filename,
                class_name=cls_name,
                kind=AnnotationKind.mask,
                geometry={
                    "kind": "mask_rle",
                    "size": list(seg["size"]),
                    "counts": str(seg["counts"]),
                },
            ))
            continue
        if isinstance(seg, list) and len(seg) > 0 and isinstance(seg[0], list):
            flat = list(seg[0])
            if len(flat) % 2 != 0 or len(flat) < 6:
                out.warnings.append(
                    f"annotation {ann.get('id')}: polygon must have ≥3 [x,y] points",
                )
                continue
            points = [[float(flat[2 * i]), float(flat[2 * i + 1])] for i in range(len(flat) // 2)]
            out.drafts.append(AnnotationDraft(
                image_filename=image_filename,
                class_name=cls_name,
                kind=AnnotationKind.polygon,
                geometry={"kind": "polygon", "points": points},
            ))
            continue

        bbox = ann.get("bbox")
        if isinstance(bbox, list) and len(bbox) == 4:
            x, y, w, h = (float(v) for v in bbox)
            # If bbox covers the entire image (and there's no segmentation/keypoints),
            # treat it as a frame-level tag — mirrors what coco_out.py emits for tags.
            iw = float(image.get("width", 0))
            ih = float(image.get("height", 0))
            if (
                iw > 0 and ih > 0
                and abs(x) < 1e-6 and abs(y) < 1e-6
                and abs(w - iw) < 1e-6 and abs(h - ih) < 1e-6
            ):
                out.drafts.append(AnnotationDraft(
                    image_filename=image_filename,
                    class_name=cls_name,
                    kind=AnnotationKind.tag,
                    geometry={"kind": "tag"},
                ))
                continue
            out.drafts.append(AnnotationDraft(
                image_filename=image_filename,
                class_name=cls_name,
                kind=AnnotationKind.bbox,
                geometry={"kind": "bbox", "x": x, "y": y, "w": w, "h": h},
            ))
            continue

        out.warnings.append(
            f"annotation {ann.get('id')} has neither bbox nor segmentation; skipped",
        )

    return out


def parse_coco_archive(archive_bytes: bytes) -> ParsedArchive:
    """Parse a ZIP archive containing a single ``coco.json`` (anywhere)."""
    try:
        zf = zipfile.ZipFile(BytesIO(archive_bytes))
    except zipfile.BadZipFile as exc:
        raise ValueError(f"not a valid zip archive: {exc}") from exc
    coco_member: zipfile.ZipInfo | None = None
    total_uncompressed = 0
    with zf:
        for member in zf.infolist():
            if member.is_dir():
                continue
            # Per-member zip-bomb guard.
            if member.file_size > _MAX_MEMBER_BYTES:
                raise ValueError("import_archive_member_too_large")
            if member.filename.lower().endswith(".json"):
                coco_member = member
                break
        if coco_member is None:
            raise ValueError("no JSON file found in archive")
        total_uncompressed += coco_member.file_size
        if total_uncompressed > _MAX_TOTAL_UNCOMPRESSED:
            raise ValueError("import_archive_too_large")
        return parse_coco_bytes(zf.read(coco_member))
