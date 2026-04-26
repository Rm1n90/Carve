"""Export RQ job — builds a ZIP archive and uploads to MinIO."""

import io
import json
import logging
import uuid
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select

from vaa_api.annotations.models import Annotation
from vaa_api.assets.models import Asset, AssetKind
from vaa_api.io.coco_out import build_coco
from vaa_api.io.yolo_out import RemapTarget, write_data_yaml, write_yolo_label
from vaa_api.projects.models import Task

logger = logging.getLogger(__name__)


@dataclass
class ExportJobPayload:
    export_id: str
    actor_id: str
    task_id: str
    fmt: str  # "yolo" | "coco"
    class_remap: dict
    include_images: bool
    splits: dict[str, float]


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


def _yolo_archive(
    *,
    task: Task,
    assets: list[Asset],
    annotations_by_asset_id: dict[uuid.UUID, list[Annotation]],
    class_remap: dict,
    include_images: bool,
    storage,
    splits: dict[str, float] | None = None,
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
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for split_name, split_assets in partitioned.items():
            for asset in split_assets:
                if asset.width is None or asset.height is None:
                    # Skip assets without known dimensions (videos with no probe yet).
                    continue
                anns = annotations_by_asset_id.get(asset.id, [])
                lines, _ = write_yolo_label(
                    anns, remap=class_remap,
                    image_w=int(asset.width), image_h=int(asset.height),
                )
                stem = Path(asset.original_name).stem
                zf.writestr(
                    f"labels/{split_name}/{stem}.txt",
                    ("\n".join(lines) + "\n") if lines else "",
                )
                if include_images and asset.kind == AssetKind.image:
                    ext = (
                        Path(asset.original_name).suffix.lstrip(".")
                        or "bin"
                    )
                    try:
                        body = storage.get_object(
                            f"assets/{asset.xxh3_128}/original.{ext}",
                        ).read()
                    except Exception:
                        continue
                    zf.writestr(f"images/{split_name}/{asset.original_name}", body)
        # Build the targets list across the WHOLE remap so data.yaml has all classes
        for v in class_remap.values():
            if v is None:
                continue
            t = RemapTarget(export_id=int(v["export_id"]), name=str(v["name"]))
            if t.export_id not in seen_target_ids:
                seen_target_ids.add(t.export_id)
                targets.append(t)
        zf.writestr(
            "data.yaml",
            write_data_yaml(
                targets=targets,
                splits={
                    "train": "./images/train",
                    "val": "./images/val",
                    "test": "./images/test",
                },
            ),
        )
    return buf.getvalue()


def _coco_archive(
    *,
    assets: list[Asset],
    annotations_by_asset_id: dict[uuid.UUID, list[Annotation]],
    class_remap: dict,
    include_images: bool,
    storage,
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
        zf.writestr("coco.json", json.dumps(coco, indent=2))
        if include_images:
            for asset in assets:
                if asset.kind != AssetKind.image:
                    continue
                ext = Path(asset.original_name).suffix.lstrip(".") or "bin"
                try:
                    body = storage.get_object(f"assets/{asset.xxh3_128}/original.{ext}").read()
                except Exception:
                    continue
                zf.writestr(f"images/{asset.original_name}", body)
    return buf.getvalue()


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
        )
    if fmt == "coco":
        # COCO uses a single coco.json — split partitioning is YOLO-only here.
        return _coco_archive(
            assets=assets,
            annotations_by_asset_id=annotations_by_asset_id,
            class_remap=class_remap,
            include_images=include_images,
            storage=storage,
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
    from vaa_api.exports.service import ExportService

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
        from vaa_api.assets.models import Frame

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

        archive_bytes = _build_archive(
            task=task,
            assets=assets,
            annotations_by_asset_id=anns_by_asset,
            fmt=payload.fmt,
            class_remap=payload.class_remap,
            include_images=payload.include_images,
            storage=storage,
            splits=payload.splits,
        )

        minio_key = f"exports/{task.id}/{export.id}.zip"
        storage.ensure_bucket()
        storage.put_object(
            minio_key, io.BytesIO(archive_bytes), len(archive_bytes), "application/zip"
        )
        svc.mark_completed(export_id=export.id, minio_key=minio_key)
        return {"status": "completed", "minio_key": minio_key}
    except Exception:  # noqa: BLE001
        # Detailed error context goes only to the server log. The persisted
        # Export.error is a static code so internal exception details (file
        # paths, secrets in messages, stack-frame hints) never leak via the
        # GET endpoint.
        logger.exception("export job failed for export_id=%s", payload.export_id)
        try:
            svc.mark_failed(
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
    from vaa_api.db import get_session_factory
    from vaa_api.storage.client import MinioClient

    SessionLocal = get_session_factory()
    storage = MinioClient.from_settings()
    with SessionLocal.begin() as session:
        return run_export_inline(session=session, storage=storage, payload=payload)
