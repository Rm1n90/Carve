# Armin Mehri — mehri.armin@gmail.com
"""SAM 3.1 video tracking proxy (replaces inference/sam_track.py).

Provides the asset-aware wrappers around the model service's
``/track/sessions/*`` endpoints. Each call:
  - resolves the asset
  - builds frame URLs from the Frame rows + asset_hash
  - supplies image_size from Asset.width/height
  - forwards to model_client.track_*

The model service has no knowledge of assets, projects, or auth — this
layer is the boundary.
"""
from __future__ import annotations

import threading

from carve_api.assets.models import Asset
from carve_api.errors import AppError
from carve_api.inference.model_client import (
    ModelServiceError,
    track_add_prompt as _track_add_prompt,
    track_close_session as _track_close_session,
    track_open_session as _track_open_session,
    track_propagate as _track_propagate,
    track_propagate_stream as _track_propagate_stream,
    track_remove_object as _track_remove_object,
    track_reset_prompts as _track_reset_prompts,
)
from carve_api.storage.client import MinioClient


# Windowed tracking — SAM 3.1's start_session loads every frame into GPU
# memory (~10 GB / 446 frames). 30 k-frame videos would OOM, so we open
# the session on a fixed window and let the user open a new session for
# the next window. The proxy stores ``{model_session_id: (frame_offset,
# window_length)}`` so prompts and propagation responses can be expressed
# in absolute (asset-wide) frame indices even though the model service
# only sees 0..window_length-1.
_SESSION_OFFSETS: dict[str, dict[str, int]] = {}
_SESSION_OFFSETS_LOCK = threading.Lock()


def _record_window(session_id: str, *, frame_offset: int, window_length: int) -> None:
    with _SESSION_OFFSETS_LOCK:
        _SESSION_OFFSETS[session_id] = {
            "frame_offset": int(frame_offset),
            "window_length": int(window_length),
        }


def _get_window(session_id: str) -> dict[str, int]:
    with _SESSION_OFFSETS_LOCK:
        return _SESSION_OFFSETS.get(
            session_id, {"frame_offset": 0, "window_length": 0},
        )


def _forget_window(session_id: str) -> None:
    with _SESSION_OFFSETS_LOCK:
        _SESSION_OFFSETS.pop(session_id, None)


class TrackFailed(AppError):
    http_status = 502
    code = "track_failed"


class TrackUnreachable(AppError):
    http_status = 503
    code = "model_service_unreachable"


class TrackSessionMissing(AppError):
    http_status = 404
    code = "track_session_not_found"


class TrackInvalidPrompt(AppError):
    http_status = 422
    code = "track_invalid_prompt"


class TrackGpuExhausted(AppError):
    """Model service returned 507 — GPU memory full while opening or
    prompting a tracking session. Distinct error code so the UI can
    show a useful remediation hint instead of "model service failed"."""

    http_status = 507
    code = "track_gpu_exhausted"


def _frame_urls_for(
    asset: Asset,
    *,
    start_frame: int = 0,
    end_frame: int | None = None,
) -> tuple[list[str], int]:
    """Return ``(frame_urls, absolute_start_idx)`` for the requested window.

    ``start_frame`` / ``end_frame`` are absolute asset frame indices
    (inclusive). When both are ``None`` / unset, falls back to every
    extracted frame. When the requested window has no frames, returns
    an empty list — the caller raises ``TrackInvalidPrompt``.

    Returns the absolute ``Frame.idx`` of the FIRST frame in the
    returned list so the proxy can store the offset for later index
    translation.
    """
    from carve_api.assets.models import Frame
    from carve_api.db import get_session_factory

    SessionLocal = get_session_factory()
    storage = MinioClient.from_settings()
    with SessionLocal() as s:
        q = (
            s.query(Frame)
            .filter(Frame.asset_id == asset.id)
            .order_by(Frame.idx)
        )
        if start_frame > 0:
            q = q.filter(Frame.idx >= int(start_frame))
        if end_frame is not None:
            q = q.filter(Frame.idx <= int(end_frame))
        rows = q.all()
    if not rows:
        return [], int(start_frame)
    urls = [
        storage.presigned_get_internal(
            f"assets/{asset.xxh3_128}/frames/{r.idx:06d}.jpg",
            expires_seconds=3600,
        )
        for r in rows
    ]
    return urls, int(rows[0].idx)


def _image_size_for(asset: Asset) -> tuple[int, int]:
    if asset.height is not None and asset.width is not None:
        return int(asset.height), int(asset.width)
    # Legacy fallback — older video extractions never wrote width/height
    # onto the Asset row, so opening a track session 422'd. Read the
    # first extracted frame's JPEG header from MinIO, persist the dims
    # back onto the asset, and return them.
    h, w = _probe_first_frame_size(asset)
    _persist_asset_size(asset, h, w)
    return h, w


def _probe_first_frame_size(asset: Asset) -> tuple[int, int]:
    from io import BytesIO

    from PIL import Image

    from carve_api.assets.models import Frame
    from carve_api.db import get_session_factory

    SessionLocal = get_session_factory()
    storage = MinioClient.from_settings()
    with SessionLocal() as s:
        first = (
            s.query(Frame)
            .filter(Frame.asset_id == asset.id)
            .order_by(Frame.idx)
            .first()
        )
    if first is None:
        raise TrackInvalidPrompt(
            f"asset {asset.id} has no extracted frames",
        )
    key = f"assets/{asset.xxh3_128}/frames/{first.idx:06d}.jpg"
    try:
        body = storage.get_object(key).read()
    except Exception as exc:  # noqa: BLE001
        raise TrackInvalidPrompt(
            f"asset {asset.id} first-frame fetch failed: {exc!r}",
        ) from exc
    try:
        with Image.open(BytesIO(body)) as im:
            w, h = int(im.width), int(im.height)
    except Exception as exc:  # noqa: BLE001
        raise TrackInvalidPrompt(
            f"asset {asset.id} first-frame decode failed: {exc!r}",
        ) from exc
    if h <= 0 or w <= 0:
        raise TrackInvalidPrompt(
            f"asset {asset.id} invalid frame dimensions {h}x{w}",
        )
    return h, w


def _persist_asset_size(asset: Asset, h: int, w: int) -> None:
    from sqlalchemy import update

    from carve_api.assets.models import Asset as AssetModel
    from carve_api.db import get_session_factory

    SessionLocal = get_session_factory()
    try:
        with SessionLocal.begin() as s:
            s.execute(
                update(AssetModel)
                .where(AssetModel.id == asset.id)
                .values(width=w, height=h)
            )
        asset.width = w
        asset.height = h
    except Exception:  # noqa: BLE001
        # Best-effort backfill; track session can still open with the
        # in-memory dims we just probed.
        pass


def _wrap(exc: ModelServiceError, label: str) -> AppError:
    if exc.status_code == 404:
        return TrackSessionMissing(f"{label}: {exc.body!r}")
    if exc.status_code == 422:
        return TrackInvalidPrompt(f"{label}: {exc.body!r}")
    if exc.status_code == 503:
        return TrackUnreachable(f"{label}: {exc.body!r}")
    if exc.status_code == 507:
        return TrackGpuExhausted(_extract_detail(exc.body) or f"{label}: {exc.body!r}")
    return TrackFailed(f"{label}: {exc.body!r}")


def _extract_detail(body: object) -> str | None:
    if isinstance(body, dict):
        d = body.get("detail")
        if isinstance(d, str):
            return d
    if isinstance(body, str):
        return body
    return None


def open_session(
    asset: Asset,
    *,
    start_frame: int = 0,
    end_frame: int | None = None,
) -> dict:
    """Open a tracking session on ``[start_frame, end_frame]`` (inclusive).

    Both bounds are absolute asset frame indices. When unset, defaults
    to every extracted frame. The returned dict carries ``session_id``,
    ``frame_count`` (size of the window), and the resolved
    ``start_frame`` / ``end_frame`` so the client can confirm the
    window it actually got.
    """
    frame_urls, absolute_start = _frame_urls_for(
        asset, start_frame=start_frame, end_frame=end_frame,
    )
    if not frame_urls:
        raise TrackInvalidPrompt(
            f"asset {asset.id} has no extracted frames in window "
            f"[{start_frame}, {end_frame}]",
        )
    image_size = _image_size_for(asset)
    try:
        body = _track_open_session(
            frame_urls, image_size, asset_hash=asset.xxh3_128,
        )
    except ModelServiceError as exc:
        raise _wrap(exc, "open_session") from exc
    sid = body.get("session_id")
    if isinstance(sid, str):
        _record_window(
            sid,
            frame_offset=absolute_start,
            window_length=len(frame_urls),
        )
    absolute_end = absolute_start + len(frame_urls) - 1
    return {
        **body,
        "start_frame": absolute_start,
        "end_frame": absolute_end,
    }


def add_prompt(sid: str, body: dict) -> dict:
    win = _get_window(sid)
    offset = win["frame_offset"]
    window_length = win["window_length"]
    translated = dict(body)
    abs_idx = int(body.get("frame_idx", 0))
    rel_idx = abs_idx - offset
    if window_length > 0 and (rel_idx < 0 or rel_idx >= window_length):
        raise TrackInvalidPrompt(
            f"frame_idx {abs_idx} is outside the tracking window "
            f"[{offset}, {offset + window_length - 1}]",
        )
    translated["frame_idx"] = rel_idx
    try:
        resp = _track_add_prompt(sid, translated)
    except ModelServiceError as exc:
        raise _wrap(exc, "add_prompt") from exc
    if isinstance(resp, dict) and "frame_idx" in resp:
        resp = {**resp, "frame_idx": int(resp["frame_idx"]) + offset}
    return resp


def propagate(
    sid: str, start_frame: int | None = None, end_frame: int | None = None,
) -> dict:
    win = _get_window(sid)
    offset = win["frame_offset"]
    rel_start = None if start_frame is None else int(start_frame) - offset
    rel_end = None if end_frame is None else int(end_frame) - offset
    try:
        resp = _track_propagate(sid, rel_start, rel_end)
    except ModelServiceError as exc:
        raise _wrap(exc, "propagate") from exc
    if isinstance(resp, dict) and isinstance(resp.get("frames"), list):
        for fr in resp["frames"]:
            if isinstance(fr, dict) and "frame_idx" in fr:
                fr["frame_idx"] = int(fr["frame_idx"]) + offset
    return resp


def propagate_stream(
    sid: str, start_frame: int | None = None, end_frame: int | None = None,
):
    """Yield NDJSON bytes from the model service. The caller (FastAPI
    route) wraps this in a ``StreamingResponse`` so the browser sees
    each per-frame record arrive in real time. Errors that occur AFTER
    the first byte show up as ``__error__`` lines in the stream rather
    than HTTP error status codes — the model service emits them, and
    if the api itself fails (model unreachable, etc) we synthesize the
    same shape so the client always sees a terminating record.

    Translates the per-frame ``frame_idx`` from the model's relative
    [0..window_length) range back to absolute asset frame indices
    using the recorded window offset.
    """
    import json as _json

    win = _get_window(sid)
    offset = win["frame_offset"]
    rel_start = None if start_frame is None else int(start_frame) - offset
    rel_end = None if end_frame is None else int(end_frame) - offset
    try:
        for chunk in _track_propagate_stream(sid, rel_start, rel_end):
            if offset == 0:
                yield chunk
                continue
            yield _retranslate_ndjson_chunk(chunk, offset)
    except ModelServiceError as exc:
        wrapped = _wrap(exc, "propagate_stream")
        yield (_json.dumps({
            "__error__": str(wrapped),
            "code": wrapped.http_status,
        }) + "\n").encode()


def _retranslate_ndjson_chunk(chunk: bytes, offset: int) -> bytes:
    """Re-emit a chunk of NDJSON bytes with ``frame_idx`` shifted by
    ``offset``. Lines that don't parse as JSON or lack ``frame_idx``
    pass through untouched."""
    import json as _json

    if not chunk:
        return chunk
    out_lines: list[bytes] = []
    text = chunk.decode("utf-8", errors="replace")
    # NDJSON lines are newline-terminated; preserve the trailing newline
    # so streaming clients see line boundaries.
    parts = text.split("\n")
    for i, part in enumerate(parts):
        if not part:
            if i < len(parts) - 1:
                out_lines.append(b"\n")
            continue
        try:
            obj = _json.loads(part)
        except _json.JSONDecodeError:
            out_lines.append(part.encode("utf-8"))
            if i < len(parts) - 1:
                out_lines.append(b"\n")
            continue
        if isinstance(obj, dict) and "frame_idx" in obj:
            try:
                obj["frame_idx"] = int(obj["frame_idx"]) + offset
            except (TypeError, ValueError):
                pass
        out_lines.append(_json.dumps(obj).encode("utf-8"))
        if i < len(parts) - 1:
            out_lines.append(b"\n")
    return b"".join(out_lines)


def remove_object(sid: str, obj_id: int) -> None:
    try:
        _track_remove_object(sid, obj_id)
    except ModelServiceError as exc:
        raise _wrap(exc, "remove_object") from exc


def reset_prompts(sid: str) -> None:
    try:
        _track_reset_prompts(sid)
    except ModelServiceError as exc:
        raise _wrap(exc, "reset_prompts") from exc


def close_session(sid: str) -> None:
    try:
        _track_close_session(sid)
    except ModelServiceError as exc:
        raise _wrap(exc, "close_session") from exc
    finally:
        _forget_window(sid)
