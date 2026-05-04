# Armin Mehri — mehri.armin@gmail.com
"""YOLO writer — converts annotations to YOLO label files + data.yaml.

Pure functions over Annotation rows (or any duck-typed object exposing
``kind``, ``geometry``, ``class_id``). The caller groups annotations per
image and supplies image dimensions; this module returns ``(lines, warnings)``.
"""

from collections.abc import Iterable
from dataclasses import dataclass

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.io.rle import rle_to_bbox


@dataclass
class RemapTarget:
    export_id: int
    name: str


def _normalise_remap(remap: dict) -> dict[str, RemapTarget | None]:
    """Coerce a JSONB remap dict into {project_class_id: RemapTarget | None}."""
    out: dict[str, RemapTarget | None] = {}
    for k, v in remap.items():
        if v is None:
            out[str(k)] = None
        elif isinstance(v, dict) and "export_id" in v and "name" in v:
            out[str(k)] = RemapTarget(export_id=int(v["export_id"]), name=str(v["name"]))
        else:
            raise ValueError(f"invalid remap entry for class {k}: {v!r}")
    return out


def write_yolo_label(
    annotations: Iterable[Annotation],
    remap: dict,
    image_w: int,
    image_h: int,
) -> tuple[list[str], list[str]]:
    """Build the YOLO label-file lines + warnings for a single image.

    Per-kind handling (Plan-20):

    * ``bbox``    — emitted as the standard YOLO detection line
                    ``idx cx cy w h`` (all values normalised 0..1).
    * ``polygon`` — emitted as a YOLO-seg polygon line
                    ``idx x1 y1 x2 y2 …`` (all normalised). Trainers that
                    only do detection will treat the first 4 floats as
                    ``cx cy w h``; ultralytics' segmentation trainers
                    consume the full polygon. Mixing the two kinds in
                    the same file is supported by ultralytics.
    * ``mask``    — decoded to its tight axis-aligned bounding box and
                    emitted as a YOLO bbox line. The full segmentation
                    mask cannot be expressed in the YOLO label format;
                    callers that need pixel-perfect masks should use
                    the COCO export. A warning is appended noting the
                    lossy conversion.
    * ``tag``     — NOT written into the label file. The export job
                    pulls these via ``extract_image_tags`` and writes
                    them to a sidecar so YOLO trainers don't choke on
                    tag-only lines (which carry no coordinates).

    Returns ``(lines, warnings)``.
    """
    if image_w <= 0 or image_h <= 0:
        raise ValueError(f"image dimensions must be positive, got {image_w}x{image_h}")
    targets = _normalise_remap(remap)
    lines: list[str] = []
    warnings: list[str] = []
    for ann in annotations:
        target = targets.get(str(ann.class_id))
        if target is None:
            continue
        idx = target.export_id
        g = ann.geometry
        if ann.kind == AnnotationKind.bbox:
            cx = (float(g["x"]) + float(g["w"]) / 2.0) / image_w
            cy = (float(g["y"]) + float(g["h"]) / 2.0) / image_h
            w = float(g["w"]) / image_w
            h = float(g["h"]) / image_h
            lines.append(f"{idx} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
        elif ann.kind == AnnotationKind.polygon:
            pts = " ".join(
                f"{float(p[0]) / image_w:.6f} {float(p[1]) / image_h:.6f}"
                for p in g["points"]
            )
            lines.append(f"{idx} {pts}")
        elif ann.kind == AnnotationKind.mask:
            box = rle_to_bbox(str(g["counts"]), tuple(g["size"]))
            if box is None:
                warnings.append(
                    f"yolo writer dropped empty mask; class_id={ann.class_id}"
                )
                continue
            x, y, mw, mh = box
            cx = (x + mw / 2.0) / image_w
            cy = (y + mh / 2.0) / image_h
            nw = mw / image_w
            nh = mh / image_h
            lines.append(f"{idx} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")
            warnings.append(
                f"yolo writer converted mask to its bounding box (lossy); class_id={ann.class_id}"
            )
        elif ann.kind == AnnotationKind.tag:
            # Tags are written to a separate sidecar — see
            # ``extract_image_tags`` and the export job.
            continue
    return lines, warnings


def extract_image_tags(
    annotations: Iterable[Annotation],
    remap: dict,
) -> list[int]:
    """Plan-20 — return the densified class ids of every ``kind=tag``
    annotation on an image, in input order.

    YOLO has no native image-level tag concept; the export job writes
    these into a separate ``tags/{split}/{stem}.txt`` file (one int per
    line) so the YOLO label files stay strictly geometric and parseable.
    """
    targets = _normalise_remap(remap)
    out: list[int] = []
    for ann in annotations:
        if ann.kind != AnnotationKind.tag:
            continue
        target = targets.get(str(ann.class_id))
        if target is None:
            continue
        out.append(int(target.export_id))
    return out


def write_data_yaml(
    *,
    targets: list[RemapTarget],
    splits: dict[str, str] | None = None,
) -> str:
    """Build the data.yaml contents.

    ``targets`` is the list of distinct (export_id, name) pairs in id order.
    ``splits`` is `{"train": "images/train", "val": "images/val", "test": "images/test"}`
    or any subset; missing values default to the standard subdirectory layout.
    """
    splits = splits or {}
    by_id: dict[int, str] = {}
    for t in targets:
        by_id.setdefault(t.export_id, t.name)
    names_sorted = [name for _id, name in sorted(by_id.items())]
    nc = len(by_id)
    quoted = ", ".join(f'"{n}"' for n in names_sorted)
    return (
        "path: .\n"
        f"train: {splits.get('train', 'images/train')}\n"
        f"val: {splits.get('val', 'images/val')}\n"
        f"test: {splits.get('test', 'images/test')}\n"
        f"nc: {nc}\n"
        f"names: [{quoted}]\n"
    )
