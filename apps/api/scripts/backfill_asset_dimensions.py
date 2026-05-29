# Armin Mehri — mehri.armin@gmail.com
"""Backfill width/height on image assets that have NULL dimensions.

Extracted video frames created before the ``video_to_images`` worker set
dimensions landed in the DB with ``width``/``height`` = NULL. The YOLO/COCO
export drops any image asset without dimensions (it normalises coordinates
against them), so those frames silently vanished from training archives —
the export produced only ``data.yaml`` / ``classes.json`` / ``README.md``.

This reads each affected image from MinIO, decodes it with PIL, and writes
the real size back to the DB.

Idempotent: only touches rows where ``width`` or ``height`` is NULL, and
skips assets whose blob is missing or unreadable. Safe to re-run.

Usage (inside the api container):

    docker compose exec api python scripts/backfill_asset_dimensions.py
"""
from __future__ import annotations

import io
import logging
import sys
from pathlib import Path

from PIL import Image
from sqlalchemy import or_, select

from carve_api.assets.models import Asset, AssetKind
from carve_api.db import get_session_factory
from carve_api.projects.models import Task  # noqa: F401 -- registers FK target
from carve_api.storage.client import MinioClient

logger = logging.getLogger(__name__)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    SessionLocal = get_session_factory()
    storage = MinioClient.from_settings()
    updated = missing = decode_fail = 0
    with SessionLocal.begin() as session:
        rows = list(
            session.execute(
                select(Asset)
                .where(Asset.kind == AssetKind.image)
                .where(or_(Asset.width.is_(None), Asset.height.is_(None)))
                .order_by(Asset.created_at)
            ).scalars()
        )
        logger.info("backfill: %d image asset(s) missing dimensions", len(rows))
        for asset in rows:
            ext = Path(asset.original_name).suffix.lstrip(".") or "bin"
            key = f"assets/{asset.xxh3_128}/original.{ext}"
            try:
                body = storage.get_object(key).read()
            except Exception as exc:  # noqa: BLE001 - log + continue
                missing += 1
                logger.warning("backfill: blob missing for %s (%s): %s", asset.id, key, exc)
                continue
            try:
                with Image.open(io.BytesIO(body)) as im:
                    width, height = im.size
            except Exception as exc:  # noqa: BLE001 - log + continue
                decode_fail += 1
                logger.warning("backfill: undecodable image %s (%s): %s", asset.id, key, exc)
                continue
            asset.width = int(width)
            asset.height = int(height)
            updated += 1
    logger.info(
        "backfill done: updated=%d missing=%d decode_fail=%d",
        updated,
        missing,
        decode_fail,
    )
    return 0 if (missing == 0 and decode_fail == 0) else 1


if __name__ == "__main__":
    sys.exit(main())
