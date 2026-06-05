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
import subprocess
import tempfile
import uuid
from collections.abc import Callable, Iterator
from io import BytesIO

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


_SOI = b"\xff\xd8"  # JPEG start-of-image marker


def _jpeg_frame_end(buf, soi: int) -> int | None:
    """Index just past the EOI of the JPEG frame starting at ``soi`` in ``buf``,
    or ``None`` if the frame is not yet complete.

    Parses marker-segment lengths rather than scanning for the first ``FF D9``:
    a raw ``FF D9`` byte pair can legitimately occur inside a DQT/DHT/SOF payload
    (and ``FF D8`` inside one too), so a naive scan would truncate frames. Header
    segments carry a 2-byte length; the SOS (``FF DA``) header does too, after
    which the entropy-coded data runs until the real EOI (skipping byte-stuffed
    ``FF 00`` and ``FF D0``–``FF D7`` restart markers). ffmpeg's mjpeg encoder
    emits baseline frames, which this covers exactly.
    """
    n = len(buf)
    i = soi + 2  # past SOI
    while i + 1 < n:
        if buf[i] != 0xFF:
            i += 1
            continue
        # Collapse any run of fill 0xFF bytes to the marker code.
        j = i
        while j < n and buf[j] == 0xFF:
            j += 1
        if j >= n:
            return None  # need more bytes for the marker code
        marker = buf[j]
        nxt = j + 1
        if marker == 0xD9:  # EOI
            return nxt
        if marker == 0x00 or marker == 0x01 or 0xD0 <= marker <= 0xD7:
            i = nxt  # stuffed FF00 or standalone TEM/RST marker — no length
            continue
        if nxt + 1 >= n:
            return None  # need the 2-byte segment length
        seg_len = (buf[nxt] << 8) | buf[nxt + 1]
        if marker == 0xDA:  # SOS: skip its header, then scan entropy data
            i = nxt + seg_len
            while i + 1 < n:
                if buf[i] == 0xFF:
                    b = buf[i + 1]
                    if b == 0x00 or 0xD0 <= b <= 0xD7:
                        i += 2  # byte-stuffing or restart marker — keep scanning
                        continue
                    if b == 0xD9:
                        return i + 2  # real EOI
                    break  # any other marker ends a baseline frame's scan data
                i += 1
            return None  # EOI not in the buffer yet
        i = nxt + seg_len  # other length-prefixed segment (APPn/DQT/DHT/SOF/COM)
    return None


def _iter_jpeg_frames(stream, chunk_size: int = 1 << 20) -> Iterator[bytes]:
    """Yield complete JPEG frames from ffmpeg's concatenated mjpeg pipe.

    Reading from the pipe backpressures ffmpeg, so memory stays at roughly one
    frame and nothing is staged to disk — the whole point of streaming the
    "extract all frames" path. A frame larger than ``chunk_size`` is handled:
    the buffer grows until its EOI arrives, then is emitted and freed.
    """
    buf = bytearray()
    while True:
        chunk = stream.read(chunk_size)
        if not chunk:
            break
        buf += chunk
        while True:
            start = buf.find(_SOI)
            if start < 0:
                # No frame start yet; keep at most a trailing 0xFF in case an
                # SOI straddles the chunk boundary.
                if len(buf) > 1:
                    del buf[:-1]
                break
            end = _jpeg_frame_end(buf, start)
            if end is None:
                if start > 0:
                    del buf[:start]  # drop junk before SOI, cap buffer growth
                break
            yield bytes(buf[start:end])
            del buf[:end]


def _stream_upload_frames(
    storage,
    asset_hash: str,
    frames: Iterator[bytes],
    step: int,
    fps: float,
    *,
    on_frame: Callable[[int], None] | None = None,
) -> tuple[list[tuple[int, int]], bytes | None]:
    """Upload each JPEG from ``frames`` to MinIO as it arrives.

    Returns ``(metadata, first_frame_bytes)`` where ``metadata`` is the
    lightweight ``(idx_in_video, pts_ms)`` list. No frame bytes are retained
    except the first (kept for the tile thumbnail), so memory stays flat
    regardless of frame count — what keeps a long ``all``-strategy extraction
    from OOM'ing the worker beside SAM.
    """
    meta: list[tuple[int, int]] = []
    first: bytes | None = None
    count = 0
    for i, jpeg in enumerate(frames):
        idx_in_video = i * step
        pts_ms = int((idx_in_video / fps) * 1000) if fps > 0 else 0
        storage.put_object(
            _frame_key(asset_hash, idx_in_video), BytesIO(jpeg), len(jpeg), "image/jpeg"
        )
        meta.append((idx_in_video, pts_ms))
        if i == 0:
            first = jpeg
        count = i + 1
        if on_frame is not None and i % 5 == 0:
            on_frame(count)
    if on_frame is not None and count:
        on_frame(count)  # final exact count
    return meta, first


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

    select = "1" if step == 1 else f"not(mod(n,{step}))"
    qv = _quality_to_qv(quality)
    log.info(
        "extract_frames_for_video asset=%s quality=%s -> q:v=%s",
        asset_id, quality, qv,
    )

    # Stream-decode: ffmpeg writes a concatenated mjpeg stream to stdout and we
    # upload each frame as it is parsed off the pipe. The pipe backpressures
    # ffmpeg (it blocks when the OS buffer fills, i.e. when uploads lag), so a
    # long "all" extraction stages nothing to disk and holds ~one frame in RAM —
    # never the tens of GB the old write-all-frames-then-upload path could.
    # stderr goes to a temp file (drained on exit) so a chatty ffmpeg can't
    # deadlock an unread pipe.
    cmd = (
        ffmpeg.input(src_url)
        .filter("select", select)
        .output("pipe:", format="image2pipe", vcodec="mjpeg", vsync="vfr", **{"q:v": qv})
        .global_args("-loglevel", "error")
        .compile()
    )

    def _on_frame(done: int) -> None:
        if _r is None:
            return
        try:
            _r.hset(
                progress_key,
                mapping={"phase": "uploading", "decoded": str(done), "uploaded": str(done)},
            )
        except Exception:  # noqa: BLE001
            pass

    with tempfile.TemporaryFile() as errf:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errf, bufsize=0)
        try:
            kept_meta, first_frame_bytes = _stream_upload_frames(
                storage,
                asset_hash,
                _iter_jpeg_frames(proc.stdout),
                step,
                fps,
                on_frame=_on_frame,
            )
        finally:
            if proc.stdout is not None:
                proc.stdout.close()
            rc = proc.wait()

        if rc != 0:
            errf.seek(0)
            err_text = errf.read().decode("utf-8", errors="replace")
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

    total_kept = len(kept_meta)
    if total_kept == 0:
        return {"ok": False, "error": "ffmpeg_produced_no_frames"}

    # Drop stale frame objects from a previous, denser extraction: any
    # ``frames/NNNNNN.jpg`` whose index we did not just rewrite. Runs only after
    # a clean decode, so a mid-stream ffmpeg failure never wipes a good prior set.
    produced = {idx for idx, _ in kept_meta}
    try:
        prefix = f"assets/{asset_hash}/frames/"
        paginator = storage._s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=storage.bucket, Prefix=prefix):
            for obj in page.get("Contents", []) or []:
                key = obj["Key"]
                stem = key.rsplit("/", 1)[-1].split(".", 1)[0]
                try:
                    obj_idx = int(stem)
                except ValueError:
                    continue
                if obj_idx not in produced:
                    storage.remove_object(key)
    except Exception:  # noqa: BLE001
        log.warning(
            "extract_frames_for_video: stale-frame cleanup failed for %s", asset_id,
        )

    with SessionLocal.begin() as s:
        s.execute(sa_delete(Frame).where(Frame.asset_id == asset_uuid))
        for idx_in_video, pts_ms in kept_meta:
            s.add(Frame(asset_id=asset_uuid, idx=idx_in_video, pts_ms=pts_ms))
        update_values: dict[str, int] = {"frames": total_kept}
        if probe_w > 0 and probe_h > 0:
            update_values["width"] = probe_w
            update_values["height"] = probe_h
        s.execute(update(Asset).where(Asset.id == asset_uuid).values(**update_values))

    # Tile thumbnail from the first decoded frame (held in memory during the
    # stream). Deterministic and race-free vs the original video, which we
    # delete next. Best-effort: leave thumbnail_minio_key NULL on failure.
    try:
        from carve_api.jobs.thumbs import (
            _make_thumbnail_jpeg,
            _persist_thumbnail_key,
            thumbnail_key,
        )

        if first_frame_bytes is not None:
            thumb_bytes = _make_thumbnail_jpeg(first_frame_bytes)
            thumb_key = thumbnail_key(asset_hash)
            storage.put_object(
                thumb_key, BytesIO(thumb_bytes), len(thumb_bytes), "image/jpeg"
            )
            _persist_thumbnail_key(asset_id, thumb_key)
    except Exception:  # noqa: BLE001
        log.warning(
            "extract_frames_for_video: thumbnail generation failed for asset %s; "
            "UI falls back to icon tile",
            asset_id,
        )

    # Delete the original video — the editor works entirely off per-frame JPEGs.
    try:
        storage.remove_object(f"assets/{asset_hash}/original.{ext}")
    except Exception:  # noqa: BLE001
        log.warning("extract_frames_for_video: original-delete failed for %s", asset_id)

    if _r is not None:
        try:
            _r.hset(
                progress_key,
                mapping={"status": "completed", "phase": "done", "uploaded": str(total_kept)},
            )
            _r.expire(progress_key, 60)  # auto-clear after a minute
        except Exception:  # noqa: BLE001
            pass

    return {
        "ok": True,
        "extracted": total_kept,
        "step": step,
        "total_source_frames": total_frames,
    }
