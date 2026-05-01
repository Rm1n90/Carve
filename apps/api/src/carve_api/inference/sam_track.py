"""App-side SAM video-tracker proxy."""

from carve_api.assets.models import Asset
from carve_api.errors import AppError
from carve_api.inference.model_client import (
    ModelServiceError,
    sam_track_add_object as _sam_track_add_object,
    sam_track_release as _sam_track_release,
    sam_track_start as _sam_track_start,
    sam_track_step as _sam_track_step,
)
from carve_api.storage.client import MinioClient


class SamTrackFailed(AppError):
    http_status = 502
    code = "sam_track_failed"


class SamTrackUnreachable(AppError):
    """Model service is offline (DNS/connect/timeout)."""

    http_status = 503
    code = "model_service_unreachable"


class SamTrackSessionMissing(AppError):
    http_status = 404
    code = "sam_track_session_not_found"


def _video_url_for(asset: Asset) -> str:
    """Video URL handed to the MODEL SERVICE for SAM video tracking; uses
    the internal minio endpoint so the model service container can
    resolve it via Docker DNS."""
    storage = MinioClient.from_settings()
    ext = asset.original_name.rsplit(".", 1)[-1] if "." in asset.original_name else "bin"
    return storage.presigned_get_internal(
        f"assets/{asset.xxh3_128}/original.{ext}", expires_seconds=600
    )


def _frame_urls_for(asset: Asset) -> list[str]:
    """v3.8 Phase 4-video step F6 -- list per-frame JPEG URLs for a
    video asset whose mp4 has been deleted (post-extract). The model
    service downloads each URL into a temp dir and uses that as the
    tracker's ``init_state`` path. Returns [] for image assets or
    videos that haven't had frames extracted yet.
    """
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


def start(
    asset: Asset,
    frame_idx: int,
    points: list[list[int]],
    labels: list[int],
    text: str | None = None,
) -> dict:
    # v3.8 Phase 4-video step F6 -- frames-list path takes priority for
    # video assets (whose original mp4 is deleted after extraction).
    # Fall back to the legacy video URL for image assets / pre-extract
    # videos that still have an original on disk.
    frame_urls = _frame_urls_for(asset)
    try:
        if frame_urls:
            return _sam_track_start(
                "",
                frame_idx,
                points,
                labels,
                text=text,
                frame_urls=frame_urls,
            )
        url = _video_url_for(asset)
        return _sam_track_start(url, frame_idx, points, labels, text=text)
    except ModelServiceError as exc:
        if exc.status_code == 503:
            raise SamTrackUnreachable(f"start: {exc.body!r}") from exc
        raise SamTrackFailed(f"start: {exc.body!r}") from exc


def add_object(
    session_id: str,
    frame_idx: int,
    obj_id: int,
    points: list[list[int]],
    labels: list[int],
    boxes: list[list[float]],
) -> dict:
    try:
        return _sam_track_add_object(session_id, frame_idx, obj_id, points, labels, boxes)
    except ModelServiceError as exc:
        if exc.status_code == 404:
            raise SamTrackSessionMissing("session not found") from exc
        if exc.status_code == 503:
            raise SamTrackUnreachable(f"add_object: {exc.body!r}") from exc
        raise SamTrackFailed(f"add_object: {exc.body!r}") from exc


def step(session_id: str, frames: int) -> dict:
    try:
        return _sam_track_step(session_id, frames)
    except ModelServiceError as exc:
        if exc.status_code == 404:
            raise SamTrackSessionMissing("session not found") from exc
        if exc.status_code == 503:
            raise SamTrackUnreachable(f"step: {exc.body!r}") from exc
        raise SamTrackFailed(f"step: {exc.body!r}") from exc


def release(session_id: str) -> None:
    try:
        _sam_track_release(session_id)
    except ModelServiceError as exc:
        if exc.status_code == 503:
            raise SamTrackUnreachable(f"release: {exc.body!r}") from exc
        raise SamTrackFailed(f"release: {exc.body!r}") from exc
