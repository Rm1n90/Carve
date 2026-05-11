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


def _clamp01(v: float) -> float:
    """Clamp a normalised coordinate to ``[0.0, 1.0]``.

    Ultralytics' loader warns or clips when label coords are outside
    ``[0,1]``. Bboxes and polygons in the DB can legitimately stick
    slightly outside the image (auto-annotation, manual drawing that
    overshoots), so we clamp at the writer to keep training data clean.
    """
    if v < 0.0:
        return 0.0
    if v > 1.0:
        return 1.0
    return v


def write_yolo_label(
    annotations: Iterable[Annotation],
    remap: dict,
    image_w: int,
    image_h: int,
) -> tuple[list[str], list[str]]:
    """Build the YOLO label-file lines + warnings for a single image.

    All normalised coordinates are clamped to ``[0, 1]`` so Ultralytics'
    loader does not warn or silently clip on overshoot.

    Per-kind handling:

    * ``bbox``    — emitted as the standard YOLO detection line
                    ``idx cx cy w h`` (all values normalised 0..1).
                    Zero-area bboxes are dropped with a warning.
    * ``polygon`` — emitted as a YOLO-seg polygon line
                    ``idx x1 y1 x2 y2 …`` (all normalised). Polygons
                    with fewer than 3 vertices are dropped with a
                    warning (ultralytics needs ≥3 to form a region).
    * ``mask``    — decoded to its tight axis-aligned bounding box and
                    emitted as a YOLO bbox line. This path is used by
                    the detection mode; the segmentation mode converts
                    masks to true polygons in the export job _before_
                    the writer is called so seg label files stay
                    uniformly polygon-shaped. A warning is appended
                    noting the lossy conversion.
    * ``tag``     — NOT written into the label file. The export job
                    builds an ImageFolder layout for classification.

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
            bx = float(g["x"])
            by = float(g["y"])
            bw = float(g["w"])
            bh = float(g["h"])
            cx = _clamp01((bx + bw / 2.0) / image_w)
            cy = _clamp01((by + bh / 2.0) / image_h)
            nw = _clamp01(bw / image_w)
            nh = _clamp01(bh / image_h)
            if nw <= 0.0 or nh <= 0.0:
                warnings.append(
                    f"yolo writer dropped zero-area bbox; class_id={ann.class_id}"
                )
                continue
            lines.append(f"{idx} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")
        elif ann.kind == AnnotationKind.polygon:
            raw_pts = g.get("points") or []
            if len(raw_pts) < 3:
                warnings.append(
                    f"yolo writer dropped polygon with <3 vertices; class_id={ann.class_id}"
                )
                continue
            pts = " ".join(
                f"{_clamp01(float(p[0]) / image_w):.6f} "
                f"{_clamp01(float(p[1]) / image_h):.6f}"
                for p in raw_pts
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
            cx = _clamp01((x + mw / 2.0) / image_w)
            cy = _clamp01((y + mh / 2.0) / image_h)
            nw = _clamp01(mw / image_w)
            nh = _clamp01(mh / image_h)
            if nw <= 0.0 or nh <= 0.0:
                warnings.append(
                    f"yolo writer dropped zero-area mask bbox; class_id={ann.class_id}"
                )
                continue
            lines.append(f"{idx} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")
            warnings.append(
                f"yolo writer converted mask to its bounding box (lossy); class_id={ann.class_id}"
            )
        elif ann.kind == AnnotationKind.tag:
            # Tags are written via a separate path — the export job
            # builds an ImageFolder layout for classification.
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
    ``splits`` maps ``"train" | "val" | "test"`` → directory path. Only the
    keys present in the dict are emitted; pointing data.yaml at an empty
    directory makes Ultralytics' loader error, so callers should omit
    splits that have no data. ``train:`` and ``val:`` are emitted in the
    order Ultralytics expects when both are present.
    """
    splits = splits or {}
    by_id: dict[int, str] = {}
    for t in targets:
        by_id.setdefault(t.export_id, t.name)
    names_sorted = [name for _id, name in sorted(by_id.items())]
    nc = len(by_id)
    quoted = ", ".join(f'"{n}"' for n in names_sorted)
    lines = ["path: ."]
    # Stable ordering: train, val, test.
    for key in ("train", "val", "test"):
        if key in splits:
            lines.append(f"{key}: {splits[key]}")
    lines.append(f"nc: {nc}")
    lines.append(f"names: [{quoted}]")
    return "\n".join(lines) + "\n"
