"""Background jobs for image thumbnails and video metadata probing.

Image thumbnails fetch the original from MinIO, downscale to a square
200x200 JPEG (preserving aspect ratio), upload to
``assets/<hash>/thumb-200.jpg``, and persist the key on the asset row
so subsequent reads can serve a presigned URL to the small JPEG instead
of the full original.

Video probes use ffmpeg to extract width / height / frame count from the
streamed original and update the corresponding ``Asset`` row. After
probing, a poster frame at t=0s is extracted, thumbnailed to 200x200
JPEG, and persisted alongside images.
"""
import uuid
from io import BytesIO

from PIL import Image

from carve_api.storage.client import MinioClient

# Thumbnail policy:
# 200x200 fits the grid tile size in the web UI (180px * device pixel ratio).
# JPEG q=78 lands around 5-15 KB per tile for typical photographic content.
_THUMB_MAX = 200
_THUMB_QUALITY = 78
_THUMB_KEY_TEMPLATE = "assets/{asset_hash}/thumb-200.jpg"


def thumbnail_key(asset_hash: str) -> str:
    """Public helper so router/backfill code uses the same key convention."""
    return _THUMB_KEY_TEMPLATE.format(asset_hash=asset_hash)


def _make_thumbnail_jpeg(body: bytes, max_side: int = _THUMB_MAX) -> bytes:
    """Resize an image (any Pillow-readable format) to fit max_side and emit JPEG bytes."""
    with Image.open(BytesIO(body)) as im:
        if im.mode in ("RGBA", "LA", "P"):
            # JPEG doesn't support alpha; flatten on a white canvas to keep colors stable.
            background = Image.new("RGB", im.size, (255, 255, 255))
            if im.mode == "P":
                im = im.convert("RGBA")
            mask = im.split()[-1] if im.mode in ("RGBA", "LA") else None
            background.paste(im, mask=mask)
            im = background
        elif im.mode != "RGB":
            im = im.convert("RGB")
        im.thumbnail((max_side, max_side))
        out = BytesIO()
        im.save(out, format="JPEG", quality=_THUMB_QUALITY, optimize=True)
        return out.getvalue()


def _persist_thumbnail_key(asset_id: str, key: str) -> None:
    """Update the asset row with the new thumbnail key."""
    from sqlalchemy import update

    from carve_api.assets.models import Asset
    from carve_api.db import get_session_factory

    SessionLocal = get_session_factory()
    with SessionLocal.begin() as s:
        s.execute(
            update(Asset).where(Asset.id == uuid.UUID(asset_id)).values(thumbnail_minio_key=key)
        )


def generate_image_thumbnail(
    asset_hash: str, ext: str, max_side: int = _THUMB_MAX, *, asset_id: str | None = None
) -> str:
    """Generate a 200x200 JPEG thumbnail and upload it to MinIO.

    Returns the MinIO key under which the thumbnail was stored. When
    ``asset_id`` is provided, the key is also written to
    ``assets.thumbnail_minio_key`` so the API can serve presigned URLs
    pointing at the small JPEG.
    """
    storage = MinioClient.from_settings()
    body = storage.get_object(f"assets/{asset_hash}/original.{ext}").read()
    thumb_bytes = _make_thumbnail_jpeg(body, max_side=max_side)
    key = thumbnail_key(asset_hash)
    storage.put_object(key, BytesIO(thumb_bytes), len(thumb_bytes), "image/jpeg")
    if asset_id is not None:
        _persist_thumbnail_key(asset_id, key)
    return key


def probe_video_metadata(asset_id: str, asset_hash: str, ext: str) -> None:
    """Use ffmpeg to read width/height/frame_count and update the Asset row.

    After probing, also extract a poster frame at t=0s, thumbnail it,
    and persist the same ``thumb-200.jpg`` key used for images so video
    tiles render with a real preview in the grid.
    """
    import ffmpeg  # imported lazily so workers without ffmpeg installed can still load this module
    from sqlalchemy import update

    from carve_api.assets.models import Asset
    from carve_api.db import get_session_factory

    storage = MinioClient.from_settings()
    # Worker (RQ) runs inside Docker — must use the internal MinIO endpoint
    # because ffmpeg resolves the host over Docker DNS, not localhost.
    # Browser-facing flows still use presigned_get (public endpoint).
    url = storage.presigned_get_internal(
        f"assets/{asset_hash}/original.{ext}", expires_seconds=300
    )
    probe = ffmpeg.probe(url)
    video_streams = [s for s in probe["streams"] if s["codec_type"] == "video"]
    if not video_streams:
        return  # nothing to update; leave asset dimensions at None
    v = video_streams[0]
    width = int(v["width"])
    height = int(v["height"])
    nb_frames = int(v.get("nb_frames", 0))
    if nb_frames == 0:
        dur = float(probe["format"].get("duration", 0))
        fps_str = v.get("avg_frame_rate", "0/1")
        try:
            num, den = (int(x) for x in fps_str.split("/"))
        except (ValueError, AttributeError):
            num, den = 0, 1
        nb_frames = int(dur * num / den) if den else 0

    SessionLocal = get_session_factory()
    with SessionLocal.begin() as s:
        s.execute(
            update(Asset)
            .where(Asset.id == uuid.UUID(asset_id))
            .values(width=width, height=height, frames=nb_frames)
        )

    # Best-effort poster extraction: if it fails (codec, container, etc.),
    # leave thumbnail_minio_key NULL and let the UI fall back to the icon tile.
    try:
        out, _ = (
            ffmpeg.input(url, ss=0)
            .output("pipe:", vframes=1, format="image2", vcodec="mjpeg")
            .run(capture_stdout=True, capture_stderr=True)
        )
        thumb_bytes = _make_thumbnail_jpeg(out)
        key = thumbnail_key(asset_hash)
        storage.put_object(key, BytesIO(thumb_bytes), len(thumb_bytes), "image/jpeg")
        _persist_thumbnail_key(asset_id, key)
    except Exception:
        # Failure here is non-fatal; the UI falls back to the video icon tile.
        pass

    # v3.8 Phase 4-video step B -- enqueue per-frame extraction so the
    # editor can show every frame as a still image. ``auto`` caps to
    # ~500 frames; users can re-extract with a different strategy via
    # the editor's "Re-extract frames" button (Phase 4-video step D).
    # Best-effort: if Redis/RQ are unreachable, the asset still works
    # with just the poster frame and the user can hit Re-extract later.
    try:
        import os as _os

        import redis as _redis
        from rq import Queue as _Queue

        from carve_api.jobs.frames import extract_frames_for_video

        _client = _redis.Redis(
            host=_os.environ.get("REDIS_HOST", "redis"),
            port=int(_os.environ.get("REDIS_PORT", "6379")),
            decode_responses=True,
        )
        _q = _Queue("default", connection=_client)
        _q.enqueue(extract_frames_for_video, asset_id, "auto", None)
    except Exception:
        import logging as _log
        _log.getLogger(__name__).warning(
            "probe_video_metadata: failed to enqueue frame extraction for %s; user can Re-extract manually",
            asset_id,
        )
