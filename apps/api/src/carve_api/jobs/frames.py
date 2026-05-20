# Armin Mehri — mehri.armin@gmail.com
"""Per-frame image extraction for video assets.

Phase 4-video step A. Decodes video frames to JPEG via ffmpeg and writes
them to MinIO under ``assets/{asset_hash}/frames/{idx:06d}.jpg``. One
``frames`` row is inserted per extracted frame so the editor's
``GET /assets/{id}/frames`` endpoint returns the exact list. The
asset's ``frames`` column is updated to the actual extracted count
(may be less than the source video's frame count when downsampling).

Strategies (selected by the upload dialog or the Re-extract button):
- ``"all"``           -- every frame
- ``"every_nth"``     -- every Nth frame; ``n`` is the step
- ``"count"``         -- exactly ``n`` evenly-spaced frames
- ``"auto"``          -- every Nth where N = max(1, ceil(total/500));
                        backward-compat default if no strategy supplied

The worker is idempotent within a single asset: it deletes any
existing ``frames/*.jpg`` keys + ``frames`` rows for the asset before
extracting (so Re-extract behaves as expected). Annotations referencing
old frame_ids are preserved by virtue of cascading on the assets row,
not deleted here -- if the user re-extracts and the indexing changes,
existing annotations stay attached to whatever frame_id they were on
(which may now be missing). v2 will surface a "this re-extract drops N
existing frame_id rows used by M annotations" confirm before running.
"""

from __future__ import annotations

import logging
import math
import shutil
import tempfile
import uuid
from io import BytesIO
from pathlib import Path

from carve_api.storage.client import MinioClient


log = logging.getLogger(__name__)


VALID_STRATEGIES = ("all", "every_nth", "count", "auto")


def _frame_key(asset_hash: str, idx: int) -> str:
    return f"assets/{asset_hash}/frames/{idx:06d}.jpg"


def _resolve_step(strategy: str, total_frames: int, n: int | None) -> int:
    """Translate a strategy + arg into a constant frame-step interval.

    Returns the step ``S`` such that we keep frames ``0, S, 2S, ...``.
    """
    if strategy == "all":
        return 1
    if strategy == "every_nth":
        if n is None or n < 1:
            raise ValueError("strategy=every_nth requires n>=1")
        return int(n)
    if strategy == "count":
        if n is None or n < 1:
            raise ValueError("strategy=count requires n>=1")
        if total_frames <= n:
            return 1
        return max(1, math.ceil(total_frames / int(n)))
    if strategy == "auto":
        return max(1, math.ceil(total_frames / 500))
    raise ValueError(f"unknown strategy: {strategy!r}")


def _quality_to_qv(quality: int) -> int:
    """Map a 0..100 user quality into ffmpeg ``-q:v`` (mjpeg: 1=best..31=worst).

    100 -> 1 (visually lossless, big files)
    75  -> 8 (default; good balance)
    50  -> 16 (medium)
    0   -> 31 (smallest, low quality)
    """
    q = max(0, min(100, int(quality)))
    return max(1, min(31, round(31 - (q / 100.0) * 30)))


def extract_frames_for_video(
    asset_id: str,
    strategy: str = "auto",
    n: int | None = None,
    quality: int = 75,
) -> dict:
    """RQ job entry point.

    Loads the asset, runs ffmpeg select-filter at ``step``, writes JPEGs
    to MinIO, replaces the asset's ``frames`` rows in one transaction.
    Returns a small summary dict for logging / job result inspection.
    """
    if strategy not in VALID_STRATEGIES:
        raise ValueError(f"strategy must be one of {VALID_STRATEGIES}")

    import ffmpeg  # lazy: workers without ffmpeg installed can still load this module
    from sqlalchemy import delete as sa_delete, update

    from carve_api.assets.models import Asset, AssetKind, Frame
    from carve_api.db import get_session_factory

    SessionLocal = get_session_factory()
    asset_uuid = uuid.UUID(asset_id)

    # Load the asset row to know the hash, ext, and source frame count.
    with SessionLocal.begin() as s:
        a = s.get(Asset, asset_uuid)
        if a is None:
            return {"ok": False, "error": "asset_not_found"}
        if a.kind != AssetKind.video:
            return {"ok": False, "error": "asset_not_video"}
        asset_hash = a.xxh3_128
        ext = (
            a.original_name.rsplit(".", 1)[-1] if "." in a.original_name else "bin"
        )
        seeded_total = int(a.frames or 0)

    storage = MinioClient.from_settings()
    src_url = storage.presigned_get_internal(
        f"assets/{asset_hash}/original.{ext}", expires_seconds=600
    )

    # Re-probe so we have a definitive total + fps even if ``seeded_total``
    # is missing. Cheap (~tens of ms).
    probe = ffmpeg.probe(src_url)
    video_streams = [
        st for st in probe["streams"] if st["codec_type"] == "video"
    ]
    if not video_streams:
        return {"ok": False, "error": "no_video_stream"}
    v = video_streams[0]
    total_frames = int(v.get("nb_frames", 0)) or seeded_total
    if total_frames <= 0:
        dur = float(probe["format"].get("duration", 0))
        fps_str = v.get("avg_frame_rate", "0/1")
        try:
            num, den = (int(x) for x in fps_str.split("/"))
            total_frames = int(dur * num / den) if den else 0
        except (ValueError, AttributeError):
            total_frames = 0
    if total_frames <= 0:
        return {"ok": False, "error": "could_not_determine_frame_count"}

    fps_str = v.get("avg_frame_rate", "0/1")
    try:
        fps_num, fps_den = (int(x) for x in fps_str.split("/"))
        fps = fps_num / fps_den if fps_den else 0.0
    except (ValueError, AttributeError, ZeroDivisionError):
        fps = 0.0

    # Capture video dimensions for downstream tools (e.g. SAM 3.1 track
    # open_session needs Asset.width/height). Without this the Asset row
    # stays NULL after extraction and Track open 422's.
    try:
        probe_w = int(v.get("width") or 0)
        probe_h = int(v.get("height") or 0)
    except (TypeError, ValueError):
        probe_w, probe_h = 0, 0

    step = _resolve_step(strategy, total_frames, n)

    log.info(
        "extract_frames_for_video asset=%s strategy=%s n=%s -> step=%s total=%s fps=%s",
        asset_id,
        strategy,
        n,
        step,
        total_frames,
        fps,
    )

    # v3.8 Phase 4-video step F — Redis-backed progress so the editor
    # can show a live bar instead of a static "extracting" overlay.
    # The hash key matches the asset id (one extraction at a time per
    # asset); shape: {status, phase, decoded, expected, uploaded,
    # done, failed, message}. TTL 1h so stale rows clean themselves.
    import os as _os
    import redis as _redis

    progress_key = f"frame-extract:{asset_id}"
    expected = max(1, math.ceil(total_frames / step))

    # v3.26 — record the RQ job id so the status endpoint can return it
    # and the client poller can correlate the job in its store.
    try:
        from rq import get_current_job as _get_current_job
        _current_job = _get_current_job()
        _current_job_id = _current_job.id if _current_job is not None else ""
    except Exception:  # noqa: BLE001
        _current_job_id = ""

    try:
        _r = _redis.Redis(
            host=_os.environ.get("REDIS_HOST", "redis"),
            port=int(_os.environ.get("REDIS_PORT", "6379")),
            decode_responses=True,
        )
        _r.hset(
            progress_key,
            mapping={
                "status": "running",
                "phase": "decoding",
                "decoded": "0",
                "expected": str(expected),
                "uploaded": "0",
                "step": str(step),
                "fps": str(fps),
                "started_at": str(int(__import__('time').time())),
                "job_id": _current_job_id,
            },
        )
        _r.expire(progress_key, 3600)
    except Exception:  # noqa: BLE001
        _r = None
        log.warning("extract_frames: redis init failed; running without progress")

    tmpdir = Path(tempfile.mkdtemp(prefix=f"frames-{asset_id[:8]}-"))
    try:
        out_pattern = str(tmpdir / "frame_%06d.jpg")
        select = "1" if step == 1 else f"not(mod(n,{step}))"
        qv = _quality_to_qv(quality)
        log.info(
            "extract_frames_for_video asset=%s quality=%s -> q:v=%s",
            asset_id, quality, qv,
        )
        proc = (
            ffmpeg.input(src_url)
            .filter("select", select)
            .output(out_pattern, vsync="vfr", **{"q:v": qv})
            .run_async(pipe_stdout=True, pipe_stderr=True, overwrite_output=True)
        )
        import time as _time

        last_decoded = 0
        while proc.poll() is None:
            decoded = sum(1 for _ in tmpdir.glob("frame_*.jpg"))
            if decoded != last_decoded:
                last_decoded = decoded
                if _r is not None:
                    try:
                        _r.hset(
                            progress_key,
                            mapping={"decoded": str(decoded), "phase": "decoding"},
                        )
                    except Exception:  # noqa: BLE001
                        pass
            _time.sleep(0.4)
        # Final flush after ffmpeg exit + capture stderr if it errored.
        rc = proc.returncode
        stderr = proc.stderr.read() if proc.stderr else b""
        if rc != 0:
            err_text = stderr.decode("utf-8", errors="replace")
            log.error("extract_frames: ffmpeg exit %s -- %s", rc, err_text[-800:])
            if _r is not None:
                try:
                    _r.hset(
                        progress_key,
                        mapping={
                            "status": "failed",
                            "message": f"ffmpeg exit {rc}: {err_text[-200:]}",
                        },
                    )
                except Exception:  # noqa: BLE001
                    pass
            return {"ok": False, "error": "ffmpeg_failed", "stderr": err_text[-400:]}

        files = sorted(tmpdir.glob("frame_*.jpg"))
        if not files:
            return {"ok": False, "error": "ffmpeg_produced_no_frames"}

        # Wipe existing frames/* keys for this asset so re-extract is
        # clean. Best-effort: if listing fails we still proceed to
        # overwrite the keys we know we will write.
        try:
            prefix = f"assets/{asset_hash}/frames/"
            paginator = storage._s3.get_paginator("list_objects_v2")
            for page in paginator.paginate(
                Bucket=storage.bucket, Prefix=prefix
            ):
                for obj in page.get("Contents", []) or []:
                    storage.remove_object(obj["Key"])
        except Exception:  # noqa: BLE001
            log.warning(
                "extract_frames_for_video: prefix-cleanup failed for %s; relying on overwrites",
                asset_id,
            )

        # Build the (idx_in_video, pts_ms, body) tuples for each kept frame.
        # idx_in_video is the original video-frame index (0, step, 2*step, ...).
        kept: list[tuple[int, int, bytes]] = []
        for i, fpath in enumerate(files):
            idx_in_video = i * step
            pts_ms = int((idx_in_video / fps) * 1000) if fps > 0 else 0
            kept.append((idx_in_video, pts_ms, fpath.read_bytes()))

        # Phase shift: decoding -> uploading. Emit per-batch progress so
        # the UI bar moves smoothly even on a 500-frame upload.
        total_kept = len(kept)
        if _r is not None:
            try:
                _r.hset(
                    progress_key,
                    mapping={
                        "phase": "uploading",
                        "decoded": str(total_kept),
                        "expected": str(total_kept),
                        "uploaded": "0",
                    },
                )
            except Exception:  # noqa: BLE001
                pass
        for i, (idx_in_video, _pts_ms, body) in enumerate(kept):
            key = _frame_key(asset_hash, idx_in_video)
            storage.put_object(
                key, BytesIO(body), len(body), "image/jpeg"
            )
            # Cheap heartbeat: every 5 uploads, plus the last one.
            if _r is not None and (i % 5 == 0 or i == total_kept - 1):
                try:
                    _r.hset(progress_key, "uploaded", str(i + 1))
                except Exception:  # noqa: BLE001
                    pass

        with SessionLocal.begin() as s:
            s.execute(
                sa_delete(Frame).where(Frame.asset_id == asset_uuid)
            )
            for idx_in_video, pts_ms, _body in kept:
                s.add(
                    Frame(
                        asset_id=asset_uuid,
                        idx=idx_in_video,
                        pts_ms=pts_ms,
                    )
                )
            update_values: dict[str, int] = {"frames": len(kept)}
            if probe_w > 0 and probe_h > 0:
                update_values["width"] = probe_w
                update_values["height"] = probe_h
            s.execute(
                update(Asset)
                .where(Asset.id == asset_uuid)
                .values(**update_values)
            )

        # v3.31+ — generate the asset's tile thumbnail from the FIRST kept
        # frame instead of from the original video. The original is
        # deleted right after extraction (below), so the previous
        # probe-based poster grab fails on a race where extraction wins
        # the queue. Reading the first kept JPEG is deterministic, never
        # races, and yields a thumbnail consistent with the extracted
        # frame set. Best-effort: leave thumbnail_minio_key NULL on
        # failure so the UI falls back to the camera icon.
        try:
            from carve_api.jobs.thumbs import (
                _make_thumbnail_jpeg,
                _persist_thumbnail_key,
                thumbnail_key,
            )

            first_frame_bytes = kept[0][2]
            thumb_bytes = _make_thumbnail_jpeg(first_frame_bytes)
            thumb_key = thumbnail_key(asset_hash)
            storage.put_object(
                thumb_key,
                BytesIO(thumb_bytes),
                len(thumb_bytes),
                "image/jpeg",
            )
            _persist_thumbnail_key(asset_id, thumb_key)
        except Exception:  # noqa: BLE001
            log.warning(
                "extract_frames_for_video: thumbnail generation failed for "
                "asset %s; UI falls back to icon tile",
                asset_id,
            )

        # v3.8 Phase 4-video step F5 — delete the original video file
        # from MinIO once the frames have been written. The editor
        # operates entirely on per-frame JPEGs so the mp4 isn't needed
        # afterwards. Best-effort; failure to delete is logged but the
        # extraction itself succeeded.
        try:
            ext = (
                a.original_name.rsplit(".", 1)[-1]
                if "." in a.original_name
                else "bin"
            )
            storage.remove_object(f"assets/{asset_hash}/original.{ext}")
        except Exception:  # noqa: BLE001
            log.warning(
                "extract_frames_for_video: original-delete failed for %s",
                asset_id,
            )

        if _r is not None:
            try:
                _r.hset(
                    progress_key,
                    mapping={
                        "status": "completed",
                        "phase": "done",
                        "uploaded": str(len(kept)),
                    },
                )
                _r.expire(progress_key, 60)  # auto-clear after a minute
            except Exception:  # noqa: BLE001
                pass

        return {
            "ok": True,
            "extracted": len(kept),
            "step": step,
            "total_source_frames": total_frames,
        }
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
