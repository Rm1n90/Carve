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
    """Plan-20.1 — return a list of ``_AnnView`` objects with ``kind`` and
    ``geometry`` adapted to the chosen YOLO write mode.

    For ``segmentation`` mode every spatial annotation must be a polygon
    so the resulting label file has uniform polygon-shaped lines. Bboxes
    are promoted to a 4-vertex polygon; masks and polygons stay as-is
    (the writer already handles each).

    For ``detection`` mode every spatial annotation must be a bbox.
    Polygons are collapsed to their axis-aligned bbox; masks are left to
    the writer (which already decodes RLE → bbox).

    For ``tags_only`` mode the geometric annotations are dropped — the
    archive layer skips the labels/ tree entirely; we just return the
    original list so ``extract_image_tags`` still sees the tag rows.
    """
    from types import SimpleNamespace

    from carve_api.annotations.models import AnnotationKind

    if mode == "tags_only":
        return list(annotations)

    out: list[Any] = []
    for ann in annotations:
        if ann.kind == AnnotationKind.tag:
            # Tags ride to the sidecar regardless of mode.
            out.append(ann)
            continue
        if mode == "detection":
            if ann.kind == AnnotationKind.polygon:
                pts = ann.geometry.get("points") or []
                if not pts:
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
                # bbox / mask flow through unchanged — writer already
                # emits a 5-token detection line for each.
                out.append(ann)
        elif mode == "segmentation":
            if ann.kind == AnnotationKind.bbox:
                g = ann.geometry
                x = float(g["x"])
                y = float(g["y"])
                w = float(g["w"])
                h = float(g["h"])
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
            else:
                # polygon / mask flow through. Mask still becomes a
                # bbox line (YOLO has no mask format) — documented in
                # the README.
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
    partitioned = _partition_assets_by_split(assets, splits)
    buf = io.BytesIO()
    targets: list[RemapTarget] = []
    seen_target_ids: set[int] = set()
    # Plan-20.3 — single-set detection. When the user picked "Single set
    # (no split)" the only populated bucket is "train"; we flatten the
    # layout so images and labels land directly under training_data/
    # instead of training_data/train/. data.yaml is updated to match.
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
        for asset in assets:
            if asset.width is None or asset.height is None:
                continue
            if asset.kind != AssetKind.image:
                continue
            ext = (
                Path(asset.original_name).suffix.lstrip(".")
                or "bin"
            )
            key = f"assets/{asset.xxh3_128}/original.{ext}"
            download_futures[asset.id] = pool.submit(_fetch_asset_bytes, storage, key)
        pool.shutdown(wait=False)
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for split_name, split_assets in partitioned.items():
            for asset in split_assets:
                if asset.width is None or asset.height is None:
                    # Skip assets without known dimensions (videos with no probe yet).
                    continue
                anns = annotations_by_asset_id.get(asset.id, [])
                stem = Path(asset.original_name).stem
                td = _td_dir(split_name)
                # Plan-20.3 — strict mode isolation.
                #   detection   -> only geometric .txt (5-token bbox lines)
                #   segmentation-> only geometric .txt (polygon lines)
                #   tags_only   -> only tag class-id .txt next to images;
                #                  no separate tags/ tree, no geometric labels
                if yolo_mode == "tags_only":
                    tag_ids = extract_image_tags(anns, remap=class_remap)
                    if tag_ids:
                        zf.writestr(
                            f"{td}/{stem}.txt",
                            "\n".join(str(t) for t in tag_ids) + "\n",
                        )
                    # else: no tag file at all for this image
                else:
                    converted = _convert_for_yolo_mode(anns, yolo_mode)
                    lines, _ = write_yolo_label(
                        converted, remap=class_remap,
                        image_w=int(asset.width), image_h=int(asset.height),
                    )
                    zf.writestr(
                        f"{td}/{stem}.txt",
                        ("\n".join(lines) + "\n") if lines else "",
                    )
                if include_images and asset.kind == AssetKind.image:
                    fut = download_futures.get(asset.id)
                    if fut is None:
                        continue
                    body = fut.result()
                    if body is None:
                        continue
                    zf.writestr(f"{td}/{asset.original_name}", body)
        # Build the targets list across the WHOLE remap so data.yaml has all classes
        for v in class_remap.values():
            if v is None:
                continue
            t = RemapTarget(export_id=int(v["export_id"]), name=str(v["name"]))
            if t.export_id not in seen_target_ids:
                seen_target_ids.add(t.export_id)
                targets.append(t)
        if single_set:
            yaml_splits = {
                "train": "training_data",
                "val": "training_data",
                "test": "training_data",
            }
        else:
            yaml_splits = {
                "train": "training_data/train",
                "val": "training_data/val",
                "test": "training_data/test",
            }
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
    """Plan-20 — self-describing layout + per-kind handling notes for the
    YOLO export. Written as ``README.md`` inside every YOLO archive.

    The ``mode`` parameter (``detection`` / ``segmentation`` / ``tags_only``)
    selects which conversion paragraph appears so the user sees what
    actually happened in their archive.
    """
    if mode == "detection":
        mode_note = (
            "## YOLO mode: **detection**\n\n"
            "Every `<stem>.txt` next to its image is the standard YOLO\n"
            "5-token detection format `<id> cx cy w h` (normalised). Polygons\n"
            "and masks were collapsed to their tight axis-aligned bounding\n"
            "box at export time — segmentation detail is intentionally\n"
            "discarded so the file works with `yolo task=detect` training.\n"
            "Image-level tags are NOT in this archive (use the 'Tags only'\n"
            "mode for that).\n\n"
        )
    elif mode == "tags_only":
        mode_note = (
            "## YOLO mode: **tags only**\n\n"
            "Each `<stem>.txt` next to its image lists one densified class id\n"
            "per line — every class the image was tagged with. No bboxes,\n"
            "polygons, or masks are present. Use this archive for\n"
            "image-classification training. Images with no tags don't get\n"
            "a `.txt` file. The `data.yaml` `nc` and `names` still describe\n"
            "the project's classes for the tag ids.\n\n"
        )
    else:
        mode_note = (
            "## YOLO mode: **segmentation**\n\n"
            "Every `<stem>.txt` next to its image is a YOLO-seg polygon\n"
            "line `<id> x1 y1 x2 y2 ... xn yn` (normalised). Bboxes were\n"
            "promoted to a 4-vertex axis-aligned polygon so the file has\n"
            "uniform shape and is consumable by `yolo task=segment`. Masks\n"
            "are still written as their tight bounding box (YOLO has no\n"
            "mask format). Image-level tags are NOT in this archive (use\n"
            "'Tags only' mode for that).\n\n"
        )
    if single_set:
        layout = (
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
    else:
        layout = (
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
    return (
        f"# Carve YOLO export — {root}\n\n"
        + mode_note +
        "## Layout\n"
        "```\n"
        + layout +
        "```\n\n"
        "Images and label files live in the same folder (no separate\n"
        "`images/` and `labels/` trees). Ultralytics' loader looks for\n"
        "`<stem>.txt` next to each image when there's no `/images/`\n"
        "segment in the path, so this layout works with `yolo train …`\n"
        "out of the box.\n\n"
        "## Per-annotation-kind handling\n\n"
        "**bbox** — `<class_id> <cx> <cy> <w> <h>` (normalised).\n\n"
        "**polygon** — `<class_id> <x1> <y1> <x2> <y2> ... <xn> <yn>`\n"
        "(normalised). Only present in segmentation mode.\n\n"
        "**mask (RLE)** — YOLO has no mask format. Each mask is decoded to\n"
        "its tight axis-aligned bbox and written as a 5-token bbox line.\n"
        "Lossy by design — for pixel-perfect masks, export as COCO.\n\n"
        "**tag (image-level label)** — only present in `tags_only` mode.\n"
        "Each line is one densified class id; an image with multiple tags\n"
        "produces several lines in its `.txt` file.\n\n"
        "## Class ids\n"
        "Class ids in `data.yaml` and label files are densified to `0..N-1`\n"
        "based on the per-export class remap order. The original project\n"
        "`idx` and the dense `export_idx` are both available in\n"
        "`classes.json`.\n"
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
