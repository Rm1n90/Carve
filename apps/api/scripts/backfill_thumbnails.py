"""Backfill 200x200 JPEG thumbnails for assets that don't have one yet.

Idempotent: skips assets where ``thumbnail_minio_key`` is already set or
where the original blob is missing in MinIO. Safe to re-run.

Usage (inside the api container):

    docker compose exec api python scripts/backfill_thumbnails.py
"""
from __future__ import annotations

import logging
import sys

from sqlalchemy import select

from carve_api.assets.models import Asset, AssetKind
from carve_api.db import get_session_factory
from carve_api.jobs.thumbs import generate_image_thumbnail

logger = logging.getLogger(__name__)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    SessionLocal = get_session_factory()
    generated = 0
    failed = 0
    with SessionLocal() as session:
        # Pull assets without thumbnails. We process image kind only for the
        # MVP backfill — videos require ffmpeg poster extraction handled by
        # the dedicated probe job.
        rows = list(
            session.execute(
                select(Asset)
                .where(Asset.thumbnail_minio_key.is_(None))
                .where(Asset.kind == AssetKind.image)
                .order_by(Asset.created_at)
            ).scalars()
        )
        logger.info("backfill: %d image asset(s) need a thumbnail", len(rows))
        for asset in rows:
            ext = (
                asset.original_name.rsplit(".", 1)[-1]
                if "." in asset.original_name
                else "bin"
            )
            try:
                generate_image_thumbnail(asset.xxh3_128, ext, asset_id=str(asset.id))
                generated += 1
                logger.info("thumb generated: %s (%s)", asset.id, asset.original_name)
            except Exception as exc:  # noqa: BLE001 - log + continue
                logger.warning(
                    "backfill: failed for asset %s (%s): %s",
                    asset.id,
                    asset.original_name,
                    exc,
                )
                failed += 1
        session.expire_all()
    logger.info("backfill done: generated=%d failed=%d", generated, failed)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
