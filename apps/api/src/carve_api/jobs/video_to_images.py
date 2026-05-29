# Armin Mehri — mehri.armin@gmail.com
"""RQ worker: extract video frames as standalone image assets.

Unlike ``extract_frames_for_video`` (which keeps the source video alive
and writes frames under the same asset hash for the video-task editor),
this worker:

  * Creates a fresh ``Asset(kind=image)`` per extracted frame.
  * Deletes the source video Asset + MinIO object on succeeded/failed
    (with carve-outs: worker crash, disk full).
  * Reports progress + status via a Redis hash so the API status
    endpoint can read live state without going through RQ's own job
    introspection.

Strategy vocabulary mirrors ``extract_frames_for_video``:
``auto | all | every_nth | count``.
"""
from __future__ import annotations

import io
import logging
import os
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from carve_api.jobs.video_to_images_planner import (
    ExtractMode,
    compute_extraction_timestamps,
)


log = logging.getLogger(__name__)


_PROGRESS_PREFIX = "video-extract"


@dataclass
class VideoToImagesPayload:
    """Serialisable RQ payload."""

    job_id: str
    batch_id: str
    task_id: str
    source_asset_id: str
    mode: ExtractMode
    n_or_k: int
    quality: int
    source_filename: str | None = None
    extras: dict[str, Any] = field(default_factory=dict)


def quality_to_qv(quality: int) -> int:
    """Map 1..100 → ffmpeg ``-q:v`` (mjpeg: 1=best..31=worst)."""
    q = max(1, min(100, int(quality)))
    return max(1, min(31, round(31 - ((q - 1) / 99.0) * 30)))


def _progress_key(job_id: str) -> str:
    return f"{_PROGRESS_PREFIX}:{job_id}"


def _redis():
    import redis as _redis_mod
    return _redis_mod.Redis(
        host=os.environ.get("REDIS_HOST", "redis"),
        port=int(os.environ.get("REDIS_PORT", "6379")),
        decode_responses=True,
    )


def set_progress(job_id: str, updates: dict[str, Any]) -> None:
    """Push progress fields to Redis. Logs and swallows errors so the
    worker never crashes because of a transient Redis hiccup."""
    try:
        r = _redis()
        mapping = {k: ("" if v is None else str(v)) for k, v in updates.items()}
        r.hset(_progress_key(job_id), mapping=mapping)
        r.expire(_progress_key(job_id), 3600)
    except Exception:  # noqa: BLE001
        log.exception("video_to_images: failed to write progress for %s", job_id)


def get_progress(job_id: str) -> dict[str, str]:
    try:
        r = _redis()
        return r.hgetall(_progress_key(job_id)) or {}
    except Exception:  # noqa: BLE001
        log.exception("video_to_images: failed to read progress for %s", job_id)
        return {}


def is_cancel_requested(job_id: str) -> bool:
    try:
        r = _redis()
        val = r.hget(_progress_key(job_id), "cancel_requested")
        return val in ("1", "true", "True")
    except Exception:  # noqa: BLE001
        return False


def request_cancel(job_id: str) -> None:
    """Flip the cancel flag for a running job. Service layer calls this."""
    try:
        r = _redis()
        r.hset(_progress_key(job_id), "cancel_requested", "1")
        r.expire(_progress_key(job_id), 3600)
    except Exception:  # noqa: BLE001
        log.exception("video_to_images: failed to set cancel for %s", job_id)


def _content_hash(payload: bytes) -> str:
    import xxhash
    return xxhash.xxh3_128_hexdigest(payload)


def _image_dimensions(jpeg: bytes) -> tuple[int | None, int | None]:
    """Return ``(width, height)`` of a JPEG frame, or ``(None, None)`` if it
    cannot be decoded.

    The YOLO/COCO export silently drops any image asset whose ``width`` or
    ``height`` is NULL (it normalises coordinates against them), so every
    extracted frame MUST carry real dimensions or it never lands in a
    training archive. Mirrors ``AssetService.upload``, which sets dimensions
    via ``Image.open(...).size`` on normal uploads. A single corrupt frame
    must not abort the whole batch, so decode failures degrade to
    ``(None, None)`` rather than raising.
    """
    from io import BytesIO

    from PIL import Image

    try:
        with Image.open(BytesIO(jpeg)) as im:
            return int(im.width), int(im.height)
    except Exception:  # noqa: BLE001
        log.warning("video_to_images: could not read extracted frame dimensions")
        return None, None


def _extract_one_frame(source_url: str, ts: float, qv: int) -> bytes:
    """Run ffmpeg to seek to ``ts`` and emit one JPEG to stdout."""
    proc = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-ss",
            f"{ts:.3f}",
            "-i",
            source_url,
            "-frames:v",
            "1",
            "-q:v",
            str(qv),
            "-f",
            "image2pipe",
            "-c:v",
            "mjpeg",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    )
    return proc.stdout


def _probe(source_url: str) -> tuple[int, float, float]:
    """Return (frame_count, fps, duration_s) from ``ffmpeg.probe``."""
    import ffmpeg as _ffmpeg
    probe = _ffmpeg.probe(source_url)
    video_streams = [
        st for st in probe.get("streams", []) if st.get("codec_type") == "video"
    ]
    if not video_streams:
        return 0, 0.0, 0.0
    v = video_streams[0]

    nb_frames = int(v.get("nb_frames") or 0)
    fps_str = v.get("avg_frame_rate") or v.get("r_frame_rate") or "0/1"
    try:
        num_s, _, den_s = fps_str.partition("/")
        num = float(num_s)
        den = float(den_s) if den_s else 0.0
        fps = (num / den) if den else 0.0
    except (TypeError, ValueError):
        fps = 0.0
    duration = float(probe.get("format", {}).get("duration") or 0)

    if nb_frames <= 0 and fps > 0 and duration > 0:
        nb_frames = int(round(duration * fps))

    return nb_frames, fps, duration


def run_video_to_images(payload: VideoToImagesPayload) -> dict[str, Any]:
    """RQ entry point.

    Returns a summary dict — never raises for data-quality failures
    (writes ``status=failed`` to Redis and returns). Only environmental
    errors (``OSError`` from disk pressure) propagate so RQ surfaces them.
    """
    # Lazy imports so the planner module can be unit-tested without
    # DB drivers / MinIO available at import time. ``Task`` is imported
    # purely for its side-effect: it registers the ``tasks`` mapper so
    # SQLAlchemy can resolve the ``assets.task_id → tasks.id`` foreign
    # key when we query Asset below. Without this we crash with
    # ``NoReferencedTableError: 'tasks'``.
    from carve_api.assets.models import Asset, AssetKind, Frame
    from carve_api.db import get_session_factory
    from carve_api.projects.models import Task  # noqa: F401 — registers FK target
    from carve_api.storage.client import MinioClient

    SessionLocal = get_session_factory()
    storage = MinioClient.from_settings()

    qv = quality_to_qv(payload.quality)
    summary: dict[str, Any] = {
        "frames_extracted": 0,
        "dedup_skipped": 0,
        "error_message": None,
        "status": "running",
    }
    set_progress(
        payload.job_id,
        {
            "status": "running",
            "progress": 0,
            "frames_extracted": 0,
            "dedup_skipped": 0,
            "batch_id": payload.batch_id,
            "task_id": payload.task_id,
            "source_asset_id": payload.source_asset_id,
            "source_filename": payload.source_filename or "",
        },
    )

    # --- Load source asset metadata ---
    try:
        with SessionLocal.begin() as s:
            src = s.get(Asset, uuid.UUID(payload.source_asset_id))
            if src is None or src.kind != AssetKind.video:
                summary["status"] = "failed"
                summary["error_message"] = "source video gone"
                _finalize_progress(payload.job_id, summary)
                return summary
            asset_hash = src.xxh3_128
            task_uuid = src.task_id
            original_name = src.original_name
            ext = (
                original_name.rsplit(".", 1)[-1]
                if "." in original_name
                else "bin"
            )
    except Exception as exc:  # noqa: BLE001
        log.exception("video_to_images: failed to load source asset")
        summary["status"] = "failed"
        summary["error_message"] = f"db error: {exc}"
        _finalize_progress(payload.job_id, summary)
        return summary

    source_key = f"assets/{asset_hash}/original.{ext}"
    source_url = storage.presigned_get_internal(source_key, expires_seconds=1800)

    # --- Probe the video ---
    try:
        frame_count, fps, duration = _probe(source_url)
    except Exception as exc:  # noqa: BLE001
        log.exception("video_to_images: probe failed")
        summary["status"] = "failed"
        summary["error_message"] = f"unreadable video: {exc}"
        _delete_source(
            SessionLocal,
            storage,
            src_uuid=uuid.UUID(payload.source_asset_id),
            key=source_key,
        )
        _finalize_progress(payload.job_id, summary)
        return summary

    if frame_count <= 0 or fps <= 0:
        summary["status"] = "failed"
        summary["error_message"] = "unreadable video"
        _delete_source(
            SessionLocal,
            storage,
            src_uuid=uuid.UUID(payload.source_asset_id),
            key=source_key,
        )
        _finalize_progress(payload.job_id, summary)
        return summary

    # --- Plan timestamps ---
    timestamps = compute_extraction_timestamps(
        mode=payload.mode,
        n_or_k=payload.n_or_k,
        frame_count=frame_count,
        fps=fps,
        duration_s=duration,
    )
    target = len(timestamps)
    source_label = payload.source_filename or original_name
    last_progress_push = 0.0

    try:
        for i, ts in enumerate(timestamps):
            if is_cancel_requested(payload.job_id):
                summary["status"] = "cancelled"
                break

            try:
                jpeg = _extract_one_frame(source_url, ts, qv)
            except subprocess.CalledProcessError as exc:
                # One frame failure — log and continue.
                log.warning(
                    "video_to_images: ffmpeg frame extract failed at ts=%.3f: %s",
                    ts,
                    exc,
                )
                continue

            h = _content_hash(jpeg)

            with SessionLocal.begin() as s:
                existing = (
                    s.query(Asset)
                    .filter(Asset.task_id == task_uuid, Asset.xxh3_128 == h)
                    .one_or_none()
                )
                if existing is not None:
                    summary["dedup_skipped"] = int(summary["dedup_skipped"]) + 1
                else:
                    # Dimensions are mandatory: the YOLO/COCO export drops any
                    # image asset with NULL width/height, so an extracted frame
                    # without them would never appear in a training archive.
                    fw, fh = _image_dimensions(jpeg)
                    new_asset = Asset(
                        id=uuid.uuid4(),
                        task_id=task_uuid,
                        kind=AssetKind.image,
                        xxh3_128=h,
                        mime="image/jpeg",
                        size_bytes=len(jpeg),
                        width=fw,
                        height=fh,
                        frames=1,
                        original_name=f"{source_label} — frame {i:05d}.jpg",
                    )
                    s.add(new_asset)
                    s.flush()
                    s.add(Frame(id=uuid.uuid4(), asset_id=new_asset.id, idx=0))
                    s.flush()
                    # Canonical asset key — matches what AssetService.upload
                    # writes (``assets/{hash}/original.{ext}``); the editor's
                    # presigned-URL builder reads from the same path.
                    storage.put_object(
                        f"assets/{h}/original.jpg",
                        io.BytesIO(jpeg),
                        length=len(jpeg),
                        content_type="image/jpeg",
                    )

            summary["frames_extracted"] = i + 1

            now = time.monotonic()
            if now - last_progress_push >= 1.0 or (i + 1) == target:
                pct = int(((i + 1) / target) * 100) if target else 100
                set_progress(
                    payload.job_id,
                    {
                        "progress": pct,
                        "frames_extracted": summary["frames_extracted"],
                        "dedup_skipped": summary["dedup_skipped"],
                    },
                )
                last_progress_push = now

        if summary["status"] != "cancelled":
            summary["status"] = "succeeded"

    except OSError as exc:
        # Environmental — preserve source per spec carve-out.
        log.exception("video_to_images: environmental error; preserving source")
        summary["status"] = "failed"
        summary["error_message"] = f"disk full or write error: {exc}"
        _finalize_progress(payload.job_id, summary)
        return summary
    except Exception as exc:  # noqa: BLE001
        log.exception("video_to_images: unexpected failure")
        summary["status"] = "failed"
        summary["error_message"] = str(exc)
        _delete_source(
            SessionLocal,
            storage,
            src_uuid=uuid.UUID(payload.source_asset_id),
            key=source_key,
        )
        _finalize_progress(payload.job_id, summary)
        return summary

    # --- Terminal cleanup ---
    if summary["status"] == "succeeded":
        _delete_source(
            SessionLocal,
            storage,
            src_uuid=uuid.UUID(payload.source_asset_id),
            key=source_key,
        )
    # ``cancelled`` -> leave source intact per spec.

    _finalize_progress(payload.job_id, summary)
    return summary


def _delete_source(SessionLocal, storage, *, src_uuid: uuid.UUID, key: str) -> None:
    from carve_api.assets.models import Asset
    try:
        storage.remove_object(key)
    except Exception:  # noqa: BLE001
        log.exception("video_to_images: failed to remove MinIO source object")
    try:
        with SessionLocal.begin() as s:
            row = s.get(Asset, src_uuid)
            if row is not None:
                s.delete(row)
    except Exception:  # noqa: BLE001
        log.exception("video_to_images: failed to delete source Asset row")


def _finalize_progress(job_id: str, summary: dict[str, Any]) -> None:
    set_progress(
        job_id,
        {
            "status": summary["status"],
            "frames_extracted": summary["frames_extracted"],
            "dedup_skipped": summary["dedup_skipped"],
            "error_message": summary["error_message"],
            "progress": 100 if summary["status"] in ("succeeded", "failed") else "",
        },
    )
