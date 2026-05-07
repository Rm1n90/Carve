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


def _frame_urls_for(asset: Asset) -> list[str]:
    from carve_api.assets.models import Frame
    from carve_api.db import get_session_factory

    SessionLocal = get_session_factory()
    storage = MinioClient.from_settings()
    with SessionLocal() as s:
        rows = (
            s.query(Frame)
            .filter(Frame.asset_id == asset.id)
            .order_by(Frame.idx)
            .all()
        )
    return [
        storage.presigned_get_internal(
            f"assets/{asset.xxh3_128}/frames/{r.idx:06d}.jpg",
            expires_seconds=3600,
        )
        for r in rows
    ]


def _image_size_for(asset: Asset) -> tuple[int, int]:
    if asset.height is None or asset.width is None:
        raise TrackInvalidPrompt(
            f"asset {asset.id} has no image_size; extraction may not be complete",
        )
    return int(asset.height), int(asset.width)


def _wrap(exc: ModelServiceError, label: str) -> AppError:
    if exc.status_code == 404:
        return TrackSessionMissing(f"{label}: {exc.body!r}")
    if exc.status_code == 422:
        return TrackInvalidPrompt(f"{label}: {exc.body!r}")
    if exc.status_code == 503:
        return TrackUnreachable(f"{label}: {exc.body!r}")
    return TrackFailed(f"{label}: {exc.body!r}")


def open_session(asset: Asset) -> dict:
    frame_urls = _frame_urls_for(asset)
    if not frame_urls:
        raise TrackInvalidPrompt(
            f"asset {asset.id} has no extracted frames",
        )
    image_size = _image_size_for(asset)
    try:
        return _track_open_session(
            frame_urls, image_size, asset_hash=asset.xxh3_128,
        )
    except ModelServiceError as exc:
        raise _wrap(exc, "open_session") from exc


def add_prompt(sid: str, body: dict) -> dict:
    try:
        return _track_add_prompt(sid, body)
    except ModelServiceError as exc:
        raise _wrap(exc, "add_prompt") from exc


def propagate(
    sid: str, start_frame: int | None = None, end_frame: int | None = None,
) -> dict:
    try:
        return _track_propagate(sid, start_frame, end_frame)
    except ModelServiceError as exc:
        raise _wrap(exc, "propagate") from exc


def propagate_stream(
    sid: str, start_frame: int | None = None, end_frame: int | None = None,
):
    """Yield NDJSON bytes from the model service. The caller (FastAPI
    route) wraps this in a ``StreamingResponse`` so the browser sees
    each per-frame record arrive in real time. Errors that occur AFTER
    the first byte show up as ``__error__`` lines in the stream rather
    than HTTP error status codes — the model service emits them, and
    if the api itself fails (model unreachable, etc) we synthesize the
    same shape so the client always sees a terminating record."""
    import json as _json
    try:
        yield from _track_propagate_stream(sid, start_frame, end_frame)
    except ModelServiceError as exc:
        wrapped = _wrap(exc, "propagate_stream")
        yield (_json.dumps({
            "__error__": str(wrapped),
            "code": wrapped.http_status,
        }) + "\n").encode()


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
