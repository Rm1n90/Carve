# Armin Mehri — mehri.armin@gmail.com
"""Export RQ job — builds a ZIP archive and uploads to MinIO."""

import io
import json
import logging
import uuid
import zipfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.orm import configure_mappers

from carve_api.annotations.models import Annotation
from carve_api.assets.models import Asset, AssetKind
from carve_api.io.coco_out import build_coco, extract_image_tags_for_coco
from carve_api.io.yolo_out import (
    RemapTarget,
    extract_image_tags,
    write_data_yaml,
    write_yolo_label,
)
from carve_api.projects.models import Class, Project, Task

# Plan-20.2 — when the RQ worker loads this module via the dataclass
# pickle payload it imports the export models lazily, which means the
# ``users`` table referenced by ``exports.created_by`` isn't registered
# yet when SQLAlchemy first compiles the Export mapper. The first time
# the worker tried to flush the Export row's status update, it raised
# ``NoReferencedTableError: Foreign key 'exports.created_by' could not
# find table 'users'`` — the archive was built and uploaded but the DB
# row stayed at status='pending' forever. Force-importing the model
# modules (and calling ``configure_mappers``) at module import time
# makes the FK graph resolvable up-front so flushes succeed.
from carve_api.auth.models import User  # noqa: F401  -- mapper registry
from carve_api.exports.models import Export  # noqa: F401  -- mapper registry
from carve_api.assets.models import Frame  # noqa: F401  -- mapper registry

configure_mappers()
# Number of MinIO workers used for parallel asset downloads inside the
# archive build. ZIP writes still happen on the main thread because
# ``zipfile`` is not thread-safe; the wins come from overlapping the
# network roundtrips.
_DOWNLOAD_WORKERS = 8

logger = logging.getLogger(__name__)


def build_classes_manifest(
    classes: Iterable[Any],
    *,
    densified_remap: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Build the unified ``classes.json`` payload for an export archive.

    Each entry contains the class's stable id, ascending integer ``idx``, name
    and color so downstream consumers (training pipelines, dataset tools) can
    line up the index used in YOLO labels / COCO ``categories`` with the
    visual identity defined in the project.

    When ``densified_remap`` is provided (a mapping of ``project_class_id ->
    {"export_id": int, "name": str}`` already densified to 0..N-1), each
    entry also carries ``export_idx`` — the dense index actually used inside
    the export's label files / COCO categories. Included entries are sorted
    by ``export_idx`` first; classes excluded from this export get
    ``export_idx = None`` and trail the included ones, ordered by their
    original ``idx`` so manifest order is stable.

    Without ``densified_remap`` the original behaviour is preserved: a list
    sorted by ``idx`` with no ``export_idx`` field. Existing consumers that
    only read ``id/idx/name/color`` keep working.

    The ``Class`` model has no per-class ``kind`` column — annotation kind is
    a Task-level attribute — so ``kind`` is intentionally omitted from each
    entry.
    """
    out: list[dict[str, Any]] = []
    for c in classes:
        entry: dict[str, Any] = {
            "id": str(c.id),
            "idx": int(c.idx),
            "name": str(c.name),
            "color": str(c.color),
        }
        if densified_remap is not None:
            target = densified_remap.get(str(c.id))
            entry["export_idx"] = (
                int(target["export_id"]) if target is not None else None
            )
        out.append(entry)
    if densified_remap is None:
        out.sort(key=lambda e: e["idx"])
    else:
        # Included entries first (sorted by export_idx), then excluded
        # entries (sorted by their original idx). Tuples sort lexicographically
        # and Python won't compare ``None`` with ``int``, so split the key.
        out.sort(
            key=lambda e: (
                0 if e.get("export_idx") is not None else 1,
                e["export_idx"] if e.get("export_idx") is not None else e["idx"],
            ),
        )
    return out


# v3.2: class indices in YOLO/COCO output are densified to 0..N-1 to ensure
# data.yaml/categories matches label indices exactly.
def _densify_remap(class_remap: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Densify a user-supplied ``class_remap`` to dense 0..N-1 indices.

    The frontend seeds each entry's ``export_id`` with the project class's
    ``idx`` (which is sparse if the user has deleted classes). Trusting that
    value verbatim breaks YOLO ``data.yaml`` (whose ``names`` array is N
    long but indexed by sparse ints) and COCO ``categories`` similarly.

    The fix is to treat the user's ``export_id`` only as a positional sort
    key (preserving user-intended ordering) and reassign export ids to
    ``0..N-1`` based on sorted position. Skipped classes (``v is None`` or
    ``v.get("skip")``) are dropped from the dense mapping entirely.
    """
    user_targets: list[tuple[int, str, str]] = []
    for src_class_id, v in class_remap.items():
        if v is None:
            continue
        if isinstance(v, dict) and v.get("skip", False):
            continue
        if not isinstance(v, dict) or "export_id" not in v or "name" not in v:
            # Match yolo_out._normalise_remap's strictness so we surface
            # malformed payloads early instead of silently densifying junk.
            raise ValueError(f"invalid remap entry for class {src_class_id}: {v!r}")
        user_targets.append(
            (int(v["export_id"]), str(v["name"]), str(src_class_id)),
        )
    user_targets.sort(key=lambda t: t[0])
    return {
        src_class_id: {"export_id": i, "name": name}
        for i, (_export_id, name, src_class_id) in enumerate(user_targets)
    }


@dataclass
class ExportJobPayload:
    export_id: str
    actor_id: str
    task_id: str
    fmt: str  # "yolo" | "coco"
    class_remap: dict
    include_images: bool
    splits: dict[str, float]
    # Plan-20.1 — YOLO write mode. See ExportIn.yolo_mode docstring for
    # semantics. Ignored when ``fmt == "coco"``. Defaulted so older
    # callers keep their previous (segmentation) behaviour.
    yolo_mode: str = "segmentation"


def _partition_assets_by_split(
    assets: list[Asset],
    splits: dict[str, float],
) -> dict[str, list[Asset]]:
    """Deterministically partition assets into train/val/test buckets.

    Sort by ``Asset.id`` (stable across runs), then take ``floor(n*train)`` for
    train, ``floor(n*val)`` for val, and the remainder for test. An empty bucket
    (e.g. when ``splits["val"] == 0.0``) just won't appear in the resulting zip.
    """
    sorted_assets = sorted(assets, key=lambda a: a.id)
    n = len(sorted_assets)
    n_train = int(n * splits.get("train", 0.0))
    n_val = int(n * splits.get("val", 0.0))
    # Floor rounds down so any leftover from rounding lands in the test bucket.
    n_test = n - n_train - n_val
    if n_test < 0:
        n_test = 0
        n_train = min(n_train, n)
        n_val = max(0, n - n_train)
    return {
        "train": sorted_assets[:n_train],
        "val": sorted_assets[n_train : n_train + n_val],
        "test": sorted_assets[n_train + n_val : n_train + n_val + n_test],
    }


def _sanitize_for_path(raw: str) -> str:
    """Plan-20.4 — squash special characters so a name is safe to use
    as a filename, MinIO key segment, ZIP entry, or YAML scalar."""
    import re

    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", (raw or "").strip()).strip("_")
    return safe or "export"


def _archive_root_name(session, task) -> str:
    """Plan-20.4 — archive's top-level folder name (and the ZIP's
    filename stem). Combines the task's project name with the task
    name; appends ``_1`` / ``_2`` / ``_N`` when prior completed exports
    exist for the same task so unzipping multiple exports next to each
    other never overwrites earlier contents.
    """
    project = session.get(Project, task.project_id) if task.project_id else None
    proj_safe = _sanitize_for_path(getattr(project, "name", None) or "")
    task_safe = _sanitize_for_path(getattr(task, "name", None) or "")
    base = f"{proj_safe}_{task_safe}".strip("_") or "export"
    from sqlalchemy import func, select
    n_prior = session.execute(
        select(func.count(Export.id)).where(
            Export.task_id == task.id,
            Export.status == "completed",
        )
    ).scalar() or 0
    return base if n_prior == 0 else f"{base}_{n_prior}"


def _fetch_asset_bytes(storage, key: str) -> bytes | None:
    """Plan-20.2 — single-asset MinIO read used by the parallel
    download pool. Returns ``None`` on miss/error so the caller can
    skip the entry without poisoning the whole archive build."""
    try:
        return storage.get_object(key).read()
    except Exception:
        return None


def _convert_for_yolo_mode(
    annotations: list[Annotation], mode: str
) -> list[Any]:
    """Return a list of annotation views adapted to the chosen YOLO write mode.

    Segmentation mode: every spatial annotation must be a polygon so the
    resulting label file has uniform polygon-shaped lines.
      - bbox    → 4-vertex axis-aligned polygon (clockwise from top-left).
      - polygon → unchanged.
      - mask    → one polygon per 4-connected component, extracted via
                  Moore-neighbor boundary tracing. Components smaller than
                  4 pixels or with <3 boundary points are dropped — they
                  cannot form a valid YOLO-seg polygon. A single mask can
                  expand into multiple polygons when the segmentation has
                  disjoint blobs.

    Detection mode: every spatial annotation must be a bbox.
      - polygon → tight axis-aligned bbox.
      - bbox    → unchanged.
      - mask    → left to the writer (which decodes RLE → bbox).

    Tags-only mode: geometric annotations are dropped at the archive layer
    (this function just passes everything through so the caller can still
    pluck tags via ``extract_image_tags``).
    """
    from types import SimpleNamespace

    from carve_api.annotations.models import AnnotationKind
    from carve_api.io.rle import rle_to_polygons

    if mode == "tags_only":
        return list(annotations)

    out: list[Any] = []
    for ann in annotations:
        if ann.kind == AnnotationKind.tag:
            # Tags ride to the sidecar / ImageFolder regardless of mode.
            out.append(ann)
            continue
        if mode == "detection":
            if ann.kind == AnnotationKind.polygon:
                pts = ann.geometry.get("points") or []
                if len(pts) < 3:
                    continue
                xs = [float(p[0]) for p in pts]
                ys = [float(p[1]) for p in pts]
                x = min(xs)
                y = min(ys)
                w = max(xs) - x
                h = max(ys) - y
                if w <= 0 or h <= 0:
                    continue
                out.append(SimpleNamespace(
                    kind=AnnotationKind.bbox,
                    class_id=ann.class_id,
                    geometry={"x": x, "y": y, "w": w, "h": h},
                ))
            else:
                # bbox / mask flow through unchanged — writer emits a
                # 5-token detection line for each.
                out.append(ann)
        elif mode == "segmentation":
            if ann.kind == AnnotationKind.bbox:
                g = ann.geometry
                x = float(g["x"])
                y = float(g["y"])
                w = float(g["w"])
                h = float(g["h"])
                if w <= 0 or h <= 0:
                    continue
                # Clockwise from top-left, 4 vertices.
                points = [
                    [x, y],
                    [x + w, y],
                    [x + w, y + h],
                    [x, y + h],
                ]
                out.append(SimpleNamespace(
                    kind=AnnotationKind.polygon,
                    class_id=ann.class_id,
                    geometry={"points": points},
                ))
            elif ann.kind == AnnotationKind.mask:
                g = ann.geometry
                counts = str(g.get("counts", ""))
                size = g.get("size")
                if not counts or not size:
                    continue
                polygons = rle_to_polygons(counts, (int(size[0]), int(size[1])))
                # One polygon line per connected component. Trainers
                # interpret multi-polygon annotations of the same class
                # as separate instances of that class.
                for poly in polygons:
                    out.append(SimpleNamespace(
                        kind=AnnotationKind.polygon,
                        class_id=ann.class_id,
                        geometry={"points": [[p[0], p[1]] for p in poly]},
                    ))
            else:
                # polygon flows through unchanged.
                out.append(ann)
        else:
            out.append(ann)
    return out


def _yolo_archive(
    *,
    task: Task,
    assets: list[Asset],
    annotations_by_asset_id: dict[uuid.UUID, list[Annotation]],
    class_remap: dict,
    include_images: bool,
    storage,
    splits: dict[str, float] | None = None,
    classes_manifest: list[dict[str, Any]] | None = None,
    yolo_mode: str = "segmentation",
    root: str = "export",
) -> bytes:
    """Build a YOLO archive in memory. Returns the zip bytes.

    Layout:
      data.yaml
      labels/{train,val,test}/<asset_basename>.txt
      images/{train,val,test}/<asset_basename> (when include_images)
    """
    splits = splits or {"train": 1.0, "val": 0.0, "test": 0.0}
    # Only image assets contribute to the YOLO archive; partition them
    # _after_ filtering so the populated-split set doesn't include
    # buckets that hold nothing but videos.
    exportable_assets = [
        a for a in assets
        if a.kind == AssetKind.image
        and a.width is not None
        and a.height is not None
    ]
    partitioned = _partition_assets_by_split(exportable_assets, splits)
    buf = io.BytesIO()
    targets: list[RemapTarget] = []
    seen_target_ids: set[int] = set()
    # Single-set: only one bucket has data, so flatten the layout so
    # images and labels land directly under training_data/ instead of
    # training_data/<split>/. data.yaml is aliased to match.
    populated = [k for k, v in partitioned.items() if v]
    single_set = len(populated) <= 1
    def _td_dir(split_name: str) -> str:
        return f"{root}/training_data" if single_set else f"{root}/training_data/{split_name}"
    # Plan-20.2 — kick off MinIO downloads for every image in parallel
    # before we walk the splits. zipfile is not thread-safe so we still
    # write entries serially on the main thread; what's parallel is the
    # network roundtrip, which dominates total time on tasks with
    # hundreds of images.
    download_futures: dict[uuid.UUID, Any] = {}
    if include_images:
        pool = ThreadPoolExecutor(max_workers=_DOWNLOAD_WORKERS)
        for asset in exportable_assets:
            ext = (
                Path(asset.original_name).suffix.lstrip(".")
                or "bin"
            )
            key = f"assets/{asset.xxh3_128}/original.{ext}"
            download_futures[asset.id] = pool.submit(_fetch_asset_bytes, storage, key)
        pool.shutdown(wait=False)
    # Build the densified targets list once. Used by data.yaml (for
    # detection/segmentation) and to look up class names for the
    # ImageFolder layout (for tags_only).
    for v in class_remap.values():
        if v is None:
            continue
        t = RemapTarget(export_id=int(v["export_id"]), name=str(v["name"]))
        if t.export_id not in seen_target_ids:
            seen_target_ids.add(t.export_id)
            targets.append(t)
    name_by_export_id = {t.export_id: t.name for t in targets}

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for split_name, split_assets in partitioned.items():
            for asset in split_assets:
                # exportable_assets was already filtered to image assets
                # with known dimensions, so no per-asset gate is needed
                # here. Video assets are exported via the separate frames
                # flow; writing a .txt for them here would produce orphan
                # labels with no images.
                anns = annotations_by_asset_id.get(asset.id, [])
                stem = Path(asset.original_name).stem
                td = _td_dir(split_name)
                if yolo_mode == "tags_only":
                    # Ultralytics' classification trainer (`yolo task=classify`)
                    # expects an ImageFolder layout: <split>/<class_name>/<img>.
                    # We pick the first tag as the canonical label and skip
                    # images that have no tags — the trainer can't use them.
                    tag_ids = extract_image_tags(anns, remap=class_remap)
                    if not tag_ids:
                        continue
                    primary_id = tag_ids[0]
                    class_name = _sanitize_for_path(
                        name_by_export_id.get(primary_id, f"class_{primary_id}"),
                    )
                    if include_images:
                        fut = download_futures.get(asset.id)
                        if fut is None:
                            continue
                        body = fut.result()
                        if body is None:
                            continue
                        zf.writestr(
                            f"{td}/{class_name}/{asset.original_name}",
                            body,
                        )
                else:
                    converted = _convert_for_yolo_mode(anns, yolo_mode)
                    lines, _ = write_yolo_label(
                        converted, remap=class_remap,
                        image_w=int(asset.width), image_h=int(asset.height),
                    )
                    # Always write the .txt (empty = background image) so
                    # there's a 1:1 correspondence between images and labels.
                    zf.writestr(
                        f"{td}/{stem}.txt",
                        ("\n".join(lines) + "\n") if lines else "",
                    )
                    if include_images:
                        fut = download_futures.get(asset.id)
                        if fut is None:
                            continue
                        body = fut.result()
                        if body is None:
                            continue
                        zf.writestr(f"{td}/{asset.original_name}", body)
        if yolo_mode == "tags_only":
            # Classification: no data.yaml (not consumed by classify), but
            # emit a classes.txt listing the dense class names in id order
            # so consumers can reverse-lookup if needed.
            class_lines = "\n".join(
                name_by_export_id[i]
                for i in sorted(name_by_export_id.keys())
            )
            if class_lines:
                zf.writestr(f"{root}/classes.txt", class_lines + "\n")
        else:
            # Detection / segmentation: emit data.yaml referencing only
            # populated splits, but always include train: and val:
            # (Ultralytics requires both — pointing them at an empty
            # directory makes its loader error).
            if single_set:
                # Everything lives flat under training_data/. Alias
                # train, val, test to the same dir so any task config
                # works without further changes.
                yaml_splits = {
                    "train": "training_data",
                    "val": "training_data",
                    "test": "training_data",
                }
            else:
                yaml_splits = {
                    split: f"training_data/{split}"
                    for split in populated
                }
                # If val is empty but train exists, alias val→train so
                # Ultralytics can still validate (using train as val is
                # a fallback, not ideal — the user can re-export with
                # a non-zero val ratio for proper holdout).
                if "val" not in yaml_splits and "train" in yaml_splits:
                    yaml_splits["val"] = yaml_splits["train"]
            zf.writestr(
                f"{root}/data.yaml",
                write_data_yaml(
                    targets=targets,
                    splits=yaml_splits,
                ),
            )
        if classes_manifest is not None:
            zf.writestr(
                f"{root}/classes.json",
                json.dumps(classes_manifest, indent=2),
            )
        zf.writestr(f"{root}/README.md", _yolo_readme(yolo_mode, single_set, root))
    return buf.getvalue()


def _yolo_readme(
    mode: str = "segmentation",
    single_set: bool = True,
    root: str = "export",
) -> str:
    """Self-describing layout + per-kind handling notes for the YOLO
    export. Written as ``README.md`` inside every YOLO archive.

    The ``mode`` (``detection`` / ``segmentation`` / ``tags_only``)
    selects which conversion paragraph appears so the user sees what
    actually happened in their archive.
    """
    if mode == "detection":
        mode_note = (
            "## YOLO mode: **detection**\n\n"
            "Every `<stem>.txt` next to its image is the standard YOLO\n"
            "5-token detection format `<id> cx cy w h`, all values normalised\n"
            "to `[0, 1]`. Polygons and masks were collapsed to their tight\n"
            "axis-aligned bounding box at export time — segmentation detail\n"
            "is intentionally discarded so the file works with\n"
            "`yolo task=detect` training. Image-level tags are NOT in this\n"
            "archive (use the 'Tags only' mode for that).\n\n"
        )
        layout = _layout_box_detect_or_seg(single_set, root)
        kind_section = (
            "## Per-annotation-kind handling\n\n"
            "**bbox** — `<class_id> <cx> <cy> <w> <h>` (normalised).\n\n"
            "**polygon** — collapsed to its tight axis-aligned bbox before\n"
            "writing. Emitted as a 5-token detection line.\n\n"
            "**mask (RLE)** — decoded to its tight axis-aligned bbox.\n"
            "Emitted as a 5-token detection line. Lossy by design —\n"
            "for pixel-perfect masks, export as COCO.\n\n"
            "**tag (image-level label)** — not included in detection mode.\n\n"
        )
    elif mode == "tags_only":
        mode_note = (
            "## YOLO mode: **classification (tags only)**\n\n"
            "Images are arranged in an ImageFolder layout consumable by\n"
            "Ultralytics' classification trainer (`yolo task=classify`).\n"
            "Each image lives inside a folder named after its primary tag.\n"
            "When an image has multiple tags, the first tag (by remap\n"
            "order) is used — `yolo task=classify` is single-label.\n"
            "Images with no tags are skipped (the trainer can't use them).\n\n"
        )
        layout = _layout_box_classify(single_set, root)
        kind_section = (
            "## Per-annotation-kind handling\n\n"
            "**tag** — the image is copied into\n"
            "`training_data/<split>/<class_name>/<image>`. Multi-tag images\n"
            "use the first tag only.\n\n"
            "**bbox / polygon / mask** — not exported in tags-only mode.\n"
            "If you need geometric labels, use the detection or\n"
            "segmentation mode.\n\n"
        )
    else:
        mode_note = (
            "## YOLO mode: **segmentation**\n\n"
            "Every `<stem>.txt` next to its image is a YOLO-seg polygon\n"
            "line `<id> x1 y1 x2 y2 ... xn yn`, all values normalised to\n"
            "`[0, 1]`. Bboxes were promoted to a 4-vertex axis-aligned\n"
            "polygon so the file has uniform polygon-shaped lines. Masks\n"
            "were converted to one polygon per 4-connected component via\n"
            "Moore-neighbor boundary tracing, so segmentation detail is\n"
            "preserved. Consumable by `yolo task=segment` out of the box.\n"
            "Image-level tags are NOT in this archive (use the 'Tags only'\n"
            "mode for that).\n\n"
        )
        layout = _layout_box_detect_or_seg(single_set, root)
        kind_section = (
            "## Per-annotation-kind handling\n\n"
            "**bbox** — promoted to a 4-vertex axis-aligned polygon\n"
            "(clockwise from top-left). Emitted as a polygon line.\n\n"
            "**polygon** — `<class_id> <x1> <y1> <x2> <y2> ... <xn> <yn>`\n"
            "(normalised). Vertex order preserved.\n\n"
            "**mask (RLE)** — one polygon per 4-connected component, traced\n"
            "from the bitmap. Disjoint blobs of the same mask produce\n"
            "multiple polygon lines (treated as separate instances by the\n"
            "trainer). Components smaller than 4 pixels are dropped.\n\n"
            "**tag (image-level label)** — not included in segmentation mode.\n\n"
        )
    classes_note = (
        "## Class ids\n"
    )
    if mode == "tags_only":
        classes_note += (
            "Class names match the directory names under each split. A\n"
            "`classes.txt` at the archive root lists the dense class names\n"
            "in id order. The original project `idx` and the dense\n"
            "`export_idx` are both available in `classes.json`.\n"
        )
    else:
        classes_note += (
            "Class ids in `data.yaml` and label files are densified to\n"
            "`0..N-1` based on the per-export class remap order. The\n"
            "original project `idx` and the dense `export_idx` are both\n"
            "available in `classes.json`.\n"
        )
    return (
        f"# Carve YOLO export — {root}\n\n"
        + mode_note
        + "## Layout\n```\n"
        + layout
        + "```\n\n"
        + kind_section
        + classes_note
    )


def _layout_box_detect_or_seg(single_set: bool, root: str) -> str:
    if single_set:
        return (
            f"{root}/\n"
            "├── training_data/                # images and labels live together\n"
            "│   ├── IMG_001.jpg\n"
            "│   ├── IMG_001.txt\n"
            "│   ├── IMG_002.jpg\n"
            "│   └── IMG_002.txt\n"
            "├── data.yaml                     # YOLO dataset descriptor\n"
            "├── classes.json                  # project class manifest\n"
            "└── README.md                     # this file\n"
        )
    return (
        f"{root}/\n"
        "├── training_data/\n"
        "│   ├── train/                    # images and labels mixed in each split\n"
        "│   │   ├── IMG_001.jpg\n"
        "│   │   └── IMG_001.txt\n"
        "│   ├── val/\n"
        "│   └── test/\n"
        "├── data.yaml                     # YOLO dataset descriptor\n"
        "├── classes.json                  # project class manifest\n"
        "└── README.md                     # this file\n"
    )


def _layout_box_classify(single_set: bool, root: str) -> str:
    if single_set:
        return (
            f"{root}/\n"
            "├── training_data/                # ImageFolder layout\n"
            "│   ├── cat/\n"
            "│   │   ├── IMG_001.jpg\n"
            "│   │   └── IMG_002.jpg\n"
            "│   └── dog/\n"
            "│       └── IMG_003.jpg\n"
            "├── classes.txt                   # dense class names, id order\n"
            "├── classes.json                  # project class manifest\n"
            "└── README.md                     # this file\n"
        )
    return (
        f"{root}/\n"
        "├── training_data/\n"
        "│   ├── train/\n"
        "│   │   ├── cat/\n"
        "│   │   │   └── IMG_001.jpg\n"
        "│   │   └── dog/\n"
        "│   │       └── IMG_002.jpg\n"
        "│   ├── val/\n"
        "│   └── test/\n"
        "├── classes.txt                   # dense class names, id order\n"
        "├── classes.json                  # project class manifest\n"
        "└── README.md                     # this file\n"
    )


def _coco_archive(
    *,
    assets: list[Asset],
    annotations_by_asset_id: dict[uuid.UUID, list[Annotation]],
    class_remap: dict,
    include_images: bool,
    storage,
    classes_manifest: list[dict[str, Any]] | None = None,
    root: str = "export",
) -> bytes:
    """Build a COCO archive (coco.json + optional images/ folder)."""
    buf = io.BytesIO()
    images: list[dict] = []
    asset_to_image_id: dict[uuid.UUID, int] = {}
    for i, asset in enumerate(assets, start=1):
        if asset.width is None or asset.height is None:
            continue
        images.append({
            "id": i,
            "file_name": asset.original_name,
            "width": int(asset.width),
            "height": int(asset.height),
        })
        asset_to_image_id[asset.id] = i

    annotations_by_image_id: dict[int, list[Annotation]] = {}
    for asset_id, anns in annotations_by_asset_id.items():
        img_id = asset_to_image_id.get(asset_id)
        if img_id is not None:
            annotations_by_image_id[img_id] = anns

    coco = build_coco(
        images=images,
        annotations_by_image_id=annotations_by_image_id,
        remap=class_remap,
    )

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{root}/coco.json", json.dumps(coco, indent=2))
        # Plan-20 — image-level tags go to a separate sidecar (COCO has
        # no canonical image-level label field). Only written when at
        # least one tag annotation matched the export remap.
        image_tags = extract_image_tags_for_coco(
            images=images,
            annotations_by_image_id=annotations_by_image_id,
            remap=class_remap,
        )
        if image_tags:
            zf.writestr(
                f"{root}/image_tags.json",
                json.dumps(image_tags, indent=2),
            )
        if include_images:
            # Plan-20.2 — parallel MinIO downloads, serial ZIP writes.
            fetch_keys: list[tuple[Asset, str]] = []
            for asset in assets:
                if asset.kind != AssetKind.image:
                    continue
                ext = Path(asset.original_name).suffix.lstrip(".") or "bin"
                fetch_keys.append(
                    (asset, f"assets/{asset.xxh3_128}/original.{ext}"),
                )
            with ThreadPoolExecutor(max_workers=_DOWNLOAD_WORKERS) as pool:
                futures = [
                    (asset, pool.submit(_fetch_asset_bytes, storage, key))
                    for asset, key in fetch_keys
                ]
                for asset, fut in futures:
                    body = fut.result()
                    if body is None:
                        continue
                    zf.writestr(
                        f"{root}/training_data/{asset.original_name}", body,
                    )
        if classes_manifest is not None:
            zf.writestr(
                f"{root}/classes.json",
                json.dumps(classes_manifest, indent=2),
            )
        zf.writestr(f"{root}/README.md", _coco_readme(root))
    return buf.getvalue()


def _coco_readme(root: str = "export") -> str:
    """Plan-20 — self-describing layout + per-kind handling notes for the
    COCO export. Written as ``README.md`` inside every COCO archive."""
    return (
        f"# Carve COCO export — {root}\n\n"
        "## Layout\n"
        "```\n"
        f"{root}/\n"
        "├── training_data/                # original images live here\n"
        "│   ├── IMG_001.jpg\n"
        "│   └── IMG_002.jpg\n"
        "├── coco.json                     # standard COCO (images + annotations + categories)\n"
        "├── image_tags.json               # only when image-level tags exist\n"
        "├── classes.json                  # full project class manifest\n"
        "└── README.md                     # this file\n"
        "```\n\n"
        "`coco.json#/images[i].file_name` is the bare filename — load the\n"
        "image from `training_data/<file_name>`.\n\n"
        "## Per-annotation-kind handling\n\n"
        "**bbox** — emitted into `coco.json#/annotations` as:\n"
        "```\n"
        '{ "bbox": [x, y, w, h], "area": w*h, "iscrowd": 0 }\n'
        "```\n"
        "(no `segmentation` field).\n\n"
        "**polygon** — emitted with a single contour:\n"
        "```\n"
        '{ "segmentation": [[x1, y1, x2, y2, ..., xn, yn]],\n'
        '  "bbox": <axis-aligned polygon bbox>,\n'
        '  "area": bbox.w * bbox.h,\n'
        '  "iscrowd": 0 }\n'
        "```\n\n"
        "**mask (RLE)** — emitted as COCO-uncompressed RLE. The bbox is the\n"
        "mask's *tight* bounding box and the area is the mask's foreground\n"
        "pixel count (not `W*H`):\n"
        "```\n"
        '{ "segmentation": { "size": [h, w], "counts": "..." },\n'
        '  "bbox": <tight mask bbox>,\n'
        '  "area": <foreground pixels>,\n'
        '  "iscrowd": 0 }\n'
        "```\n"
        "Empty masks (no foreground pixels) are dropped — a `[0,0,0,0]` row\n"
        "would silently corrupt downstream IoU/area filters.\n\n"
        "**tag (image-level label)** — NOT written into `coco.json`. COCO has\n"
        "no canonical image-level multi-label classification field, so tags\n"
        "are written to `image_tags.json`:\n"
        "```\n"
        "[ { \"image_id\": 1,\n"
        "    \"file_name\": \"IMG_001.jpg\",\n"
        "    \"tags\": [ {\"category_id\": 0, \"name\": \"person\"} ] } ]\n"
        "```\n"
        "An image with multiple tags has multiple entries in its `tags` list.\n"
        "An image with no tags is absent from `image_tags.json` (the file\n"
        "itself is omitted when no tags exist anywhere).\n\n"
        "## Class ids\n"
        "Category ids in `coco.json` are densified to `0..N-1` based on the\n"
        "per-export class remap order. The original project `idx` and the\n"
        "dense `export_idx` are both available in `classes.json`.\n"
    )


def _build_archive(
    *,
    task: Task,
    assets: list[Asset],
    annotations_by_asset_id: dict[uuid.UUID, list[Annotation]],
    fmt: str,
    class_remap: dict,
    include_images: bool,
    storage,
    splits: dict[str, float] | None = None,
    classes_manifest: list[dict[str, Any]] | None = None,
    yolo_mode: str = "segmentation",
    root: str = "export",
) -> bytes:
    if fmt == "yolo":
        return _yolo_archive(
            task=task,
            assets=assets,
            annotations_by_asset_id=annotations_by_asset_id,
            class_remap=class_remap,
            include_images=include_images,
            storage=storage,
            splits=splits,
            classes_manifest=classes_manifest,
            yolo_mode=yolo_mode,
            root=root,
        )
    if fmt == "coco":
        # COCO uses a single coco.json — split partitioning is YOLO-only here.
        return _coco_archive(
            assets=assets,
            annotations_by_asset_id=annotations_by_asset_id,
            class_remap=class_remap,
            include_images=include_images,
            storage=storage,
            classes_manifest=classes_manifest,
            root=root,
        )
    raise ValueError(f"unsupported export format: {fmt}")


def run_export_inline(
    *,
    session,
    storage,
    payload: ExportJobPayload,
) -> dict:
    """Run the export end-to-end against an open session + storage. The RQ
    wrapper below opens its own session/storage and delegates here.
    """
    from carve_api.exports.service import ExportService

    svc = ExportService(session)
    try:
        export = svc.get(export_id=uuid.UUID(payload.export_id))
        task = session.get(Task, uuid.UUID(payload.task_id))
        if task is None:
            svc.mark_failed(export_id=export.id, error="task_not_found")
            return {"status": "failed"}

        assets = list(
            session.execute(select(Asset).where(Asset.task_id == task.id)).scalars()
        )
        # Group annotations by frame's asset_id
        ann_rows = list(
            session.execute(
                select(Annotation).where(Annotation.task_id == task.id)
            ).scalars()
        )
        # Build frame_id → asset_id map
        from carve_api.assets.models import Frame

        frame_to_asset: dict[uuid.UUID, uuid.UUID] = {
            row.id: row.asset_id
            for row in session.execute(
                select(Frame).where(Frame.asset_id.in_([a.id for a in assets]))
            ).scalars()
        }
        anns_by_asset: dict[uuid.UUID, list[Annotation]] = defaultdict(list)
        for ann in ann_rows:
            if ann.frame_id is None:
                continue
            asset_id = frame_to_asset.get(ann.frame_id)
            if asset_id is not None:
                anns_by_asset[asset_id].append(ann)

        # v3.0 D11 — ship a unified classes.json manifest in every archive so
        # downstream tools can map idx → name + brand color without parsing
        # YOLO data.yaml / COCO categories.
        project_classes = list(
            session.execute(
                select(Class).where(Class.project_id == task.project_id)
            ).scalars()
        )
        # v3.2 Issue 5: densify export class indices to 0..N-1 BEFORE passing
        # to writers and before building the manifest. The user-supplied
        # export_id is treated only as a positional sort key.
        densified_remap = _densify_remap(payload.class_remap)
        classes_manifest = build_classes_manifest(
            project_classes,
            densified_remap=densified_remap,
        )

        # Plan-20.3 — top-level archive folder named after the task with
        # ``_test1``/``_test2``/… suffix when prior completed exports
        # exist for the same task.
        root_name = _archive_root_name(session, task)
        archive_bytes = _build_archive(
            task=task,
            assets=assets,
            annotations_by_asset_id=anns_by_asset,
            fmt=payload.fmt,
            class_remap=densified_remap,
            # Plan-20 — every export ZIP must carry images alongside the
            # annotation files. We accept the legacy ``include_images``
            # flag in the payload for API compatibility but always coerce
            # it to True at the build boundary.
            include_images=True,
            storage=storage,
            splits=payload.splits,
            classes_manifest=classes_manifest,
            yolo_mode=getattr(payload, "yolo_mode", "segmentation"),
            root=root_name,
        )

        # Plan-20.4 — embed the friendly root name in the MinIO key so
        # the URL path tail also reads as the user-friendly filename;
        # the export_id segment keeps multiple exports of the same
        # ``root_name`` from colliding on the storage side.
        minio_key = f"exports/{task.id}/{export.id}/{root_name}.zip"
        storage.ensure_bucket()
        storage.put_object(
            minio_key, io.BytesIO(archive_bytes), len(archive_bytes), "application/zip"
        )
        svc.mark_completed(export_id=export.id, minio_key=minio_key)
        # Plan-13 Phase 7 Task 6 — register a DatasetVersion for the
        # exported bundle so it can be diffed / rolled back later.
        try:
            from datetime import datetime, timezone

            from carve_api.datasets.service import DatasetService

            accepted_count = sum(
                1 for a in ann_rows if a.status == "accepted"
            )
            rejected_count = sum(
                1 for a in ann_rows if a.status == "rejected"
            )
            class_name_list = list(
                session.execute(
                    select(Class.name)
                    .where(Class.project_id == task.project_id)
                    .order_by(Class.idx)
                ).scalars()
            )
            DatasetService.register(
                session,
                project_id=task.project_id,
                task_id=task.id,
                kind="export",
                source=str(export.id),
                created_by=export.created_by,
                label=(
                    f"Export {payload.fmt} "
                    f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}"
                ),
                summary={
                    "annotations": len(ann_rows),
                    "accepted": accepted_count,
                    "rejected": rejected_count,
                    "classes": class_name_list,
                    "asset_count": len(assets),
                    "format": payload.fmt,
                },
                blob_key=minio_key,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "export.dataset_version.register failed export_id=%s",
                payload.export_id,
            )
        # Plan-13 Phase 7 Task 3 — best-effort audit on export completion.
        try:
            from carve_api.audit import service as _audit
            from carve_api.audit.actions import EXPORT_COMPLETED

            _audit.record(
                session,
                actor_id=uuid.UUID(payload.actor_id),
                action=EXPORT_COMPLETED,
                target_type="export",
                target_id=export.id,
                project_id=task.project_id,
                summary=(
                    f"{EXPORT_COMPLETED} task={task.id} export={export.id}"
                ),
                metadata={
                    "export_id": str(export.id),
                    "task_id": str(task.id),
                    "format": payload.fmt,
                    "minio_key": minio_key,
                },
            )
        except Exception:  # noqa: BLE001
            pass
        return {"status": "completed", "minio_key": minio_key}
    except Exception:  # noqa: BLE001
        # Detailed error context goes only to the server log. The persisted
        # Export.error is a static code so internal exception details (file
        # paths, secrets in messages, stack-frame hints) never leak via the
        # GET endpoint.
        logger.exception("export job failed for export_id=%s", payload.export_id)
        # Plan-20.2 — DON'T reuse ``svc`` / ``session`` here. The outer
        # ``with SessionLocal.begin()`` context wraps a transaction that
        # is now in a dirty/poisoned state, so any further write on the
        # same session raises 'Can't operate on closed transaction…'.
        # Open a brand-new session purely to record the failure.
        try:
            from carve_api.db import get_session_factory
            from carve_api.exports.service import ExportService

            FactoryLocal = get_session_factory()
            with FactoryLocal.begin() as fail_session:
                ExportService(fail_session).mark_failed(
                    export_id=uuid.UUID(payload.export_id),
                    error="archive_build_failed",
                )
        except Exception:
            logger.exception(
                "failed to mark export as failed export_id=%s", payload.export_id,
            )
        return {"status": "failed", "error": "archive_build_failed"}


def run_export_job(payload: ExportJobPayload) -> dict:
    """RQ entry point — opens a fresh session + storage and delegates."""
    from carve_api.db import get_session_factory
    from carve_api.storage.client import MinioClient

    SessionLocal = get_session_factory()
    storage = MinioClient.from_settings()
    with SessionLocal.begin() as session:
        return run_export_inline(session=session, storage=storage, payload=payload)
