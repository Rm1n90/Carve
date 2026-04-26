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


class SamTrackSessionMissing(AppError):
    http_status = 404
    code = "sam_track_session_not_found"


def _video_url_for(asset: Asset) -> str:
    storage = MinioClient.from_settings()
    ext = asset.original_name.rsplit(".", 1)[-1] if "." in asset.original_name else "bin"
    return storage.presigned_get(f"assets/{asset.xxh3_128}/original.{ext}", expires_seconds=600)


def start(
    asset: Asset,
    frame_idx: int,
    points: list[list[int]],
    labels: list[int],
    text: str | None = None,
) -> dict:
    url = _video_url_for(asset)
    try:
        return _sam_track_start(url, frame_idx, points, labels, text=text)
    except ModelServiceError as exc:
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
        raise SamTrackFailed(f"add_object: {exc.body!r}") from exc


def step(session_id: str, frames: int) -> dict:
    try:
        return _sam_track_step(session_id, frames)
    except ModelServiceError as exc:
        if exc.status_code == 404:
            raise SamTrackSessionMissing("session not found") from exc
        raise SamTrackFailed(f"step: {exc.body!r}") from exc


def release(session_id: str) -> None:
    try:
        _sam_track_release(session_id)
    except ModelServiceError as exc:
        raise SamTrackFailed(f"release: {exc.body!r}") from exc
