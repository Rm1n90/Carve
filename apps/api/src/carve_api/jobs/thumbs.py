"""Background jobs for image thumbnails and video metadata probing.

Image thumbnails fetch the original from MinIO, downscale to a 320 px
longest-side WebP, and upload it to ``assets/<hash>/thumb.webp``.

Video probes use ffmpeg to extract width / height / frame count from the
streamed original and update the corresponding ``Asset`` row.
"""
import uuid
from io import BytesIO

from PIL import Image

from carve_api.storage.client import MinioClient


def generate_image_thumbnail(asset_hash: str, ext: str, max_side: int = 320) -> None:
    storage = MinioClient.from_settings()
    body = storage.get_object(f"assets/{asset_hash}/original.{ext}").read()
    with Image.open(BytesIO(body)) as im:
        im.thumbnail((max_side, max_side))
        out = BytesIO()
        im.save(out, format="WEBP", quality=82)
        out.seek(0)
        storage.put_object(
            f"assets/{asset_hash}/thumb.webp",
            out, out.getbuffer().nbytes, "image/webp",
        )


def probe_video_metadata(asset_id: str, asset_hash: str, ext: str) -> None:
    """Use ffmpeg to read width/height/frame_count and update the Asset row."""
    import ffmpeg  # imported lazily so workers without ffmpeg installed can still load this module
    from sqlalchemy import update

    from carve_api.assets.models import Asset
    from carve_api.db import get_session_factory

    storage = MinioClient.from_settings()
    url = storage.presigned_get(f"assets/{asset_hash}/original.{ext}", expires_seconds=300)
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
