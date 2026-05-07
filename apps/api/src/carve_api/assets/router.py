# Armin Mehri — mehri.armin@gmail.com
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from carve_api.assets.models import AssetKind
from carve_api.assets.schemas import AssetCount, AssetListPage, AssetOut, AssetWithUrl
from carve_api.assets.service import AssetService
from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.projects.service import ProjectService, TaskService, _can_modify, NotProjectOwner, require_visible_task
from carve_api.storage.client import MinioClient

router = APIRouter(prefix="/tasks", tags=["assets"])
asset_router = APIRouter(prefix="/assets", tags=["assets"])

# Hard upper bound on how many assets the API will return for a single
# page. Keeps response payloads predictable even if a client requests
# limit=999999 in the URL.
# v3.7.1: bumped 500 → 5000 to match the frontend assetsApi.listForTask
# bump shipped in v3.7. The previous mismatch caused 422s and broke
# thumbnail rendering, asset count, and keyboard navigation for tasks
# with >500 assets.
_MAX_PAGE_LIMIT = 5000

# Plan-20.12 — SlowAPI removed application-wide. Per-minute caps and
# the SINGLE_ASSET_UPLOAD_LIMIT constant are gone; uploads are
# unbounded.


def _enqueue_post_upload(asset) -> None:
    """Best-effort enqueue of post-upload work; swallow Redis errors so HTTP returns succeed even if Redis is down."""
    try:
        from carve_api.jobs.queue import get_queue
        from carve_api.jobs.thumbs import generate_image_thumbnail, probe_video_metadata
        ext = asset.original_name.rsplit(".", 1)[-1] if "." in asset.original_name else "bin"
        q = get_queue()
        if asset.kind == AssetKind.image:
            # Pass asset_id so the worker can persist the thumbnail key.
            q.enqueue(generate_image_thumbnail, asset.xxh3_128, ext, asset_id=str(asset.id))
        else:
            q.enqueue(probe_video_metadata, str(asset.id), asset.xxh3_128, ext)
    except Exception:
        # Redis may be unreachable in test/dev; treat job-enqueue failure as non-fatal.
        pass


def _http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


@router.post("/{task_id}/assets", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
# Plan-20.11 — rate limit removed. Self-hosted users uploading 1000+
# images hit 429 even with retry-with-backoff, and there's no abuse
# vector here that justifies a per-minute cap.
async def upload_asset(
    request: Request,
    task_id: uuid.UUID,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AssetOut:
    body = await file.read()
    try:
        task = require_visible_task(db, user, task_id)
        asset = AssetService(db).upload(
            task=task, original_name=file.filename or "unnamed",
            mime=file.content_type or "application/octet-stream", body=body,
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    _enqueue_post_upload(asset)
    return AssetOut.from_orm_asset(asset)


@router.get("/{task_id}/assets", response_model=AssetListPage)
def list_assets(
    task_id: uuid.UUID,
    limit: int = Query(default=100, ge=1, le=_MAX_PAGE_LIMIT),
    offset: int = Query(default=0, ge=0),
    q: str | None = Query(default=None, max_length=255),
    status: Literal["all", "annotated", "unannotated"] = Query(default="all"),
    # Plan-13 Phase 7 Task 8 -- richer filter set used by the per-task
    # filter sidebar. ``class_id`` narrows the list to assets that have
    # at least one annotation for that class. ``annotation_status``
    # narrows to assets with at least one annotation in that review
    # state. ``min_size`` / ``max_size`` filter on the asset byte size.
    class_id: uuid.UUID | None = Query(default=None),
    annotation_status: Literal["proposed", "accepted", "rejected"] | None = Query(
        default=None
    ),
    min_size: int | None = Query(default=None, ge=0),
    max_size: int | None = Query(default=None, ge=0),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AssetListPage:
    """Paginated list of assets for a task with optional filename search and status filter.

    Each AssetOut carries a presigned ``thumbnail_url`` so the web grid
    can render tiles without a per-asset fetch. Returns a single page
    + total count so the UI can show "Showing N–M of T".
    """
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    svc = AssetService(db)
    items = svc.list_for_task(
        task=task,
        limit=limit,
        offset=offset,
        q=q,
        status=status,
        class_id=class_id,
        annotation_status=annotation_status,
        min_size=min_size,
        max_size=max_size,
    )
    total = svc.count_for_task(
        task=task,
        q=q,
        status=status,
        class_id=class_id,
        annotation_status=annotation_status,
        min_size=min_size,
        max_size=max_size,
    )
    tag_map = svc.tag_class_ids_for([a.id for a in items])
    return AssetListPage(
        items=[
            AssetOut.from_orm_asset(
                a,
                thumbnail_url=svc.thumbnail_url_for(a),
                tag_class_ids=tag_map.get(str(a.id), []),
            )
            for a in items
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/{task_id}/assets/count", response_model=AssetCount)
def asset_count(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AssetCount:
    """Total / annotated / unannotated counts for filter chips above the grid."""
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    svc = AssetService(db)
    total = svc.count_for_task(task=task)
    annotated = svc.annotated_count_for_task(task=task)
    return AssetCount(total=total, annotated=annotated, unannotated=total - annotated)


@router.post("/{task_id}/assets:zip", response_model=list[AssetOut], status_code=status.HTTP_201_CREATED)
# Plan-20.11 — see ``upload_asset`` above. Self-hosted, no abuse vector.
async def upload_archive(
    request: Request,
    task_id: uuid.UUID,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AssetOut]:
    body = await file.read()
    try:
        task = require_visible_task(db, user, task_id)
        assets = AssetService(db).upload_archive(task=task, archive_bytes=body)
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    for a in assets:
        _enqueue_post_upload(a)
    return [AssetOut.from_orm_asset(a) for a in assets]


@asset_router.get("/{asset_id}/thumbnail")
def asset_thumbnail(
    asset_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    """302 redirect to a presigned URL of the cached 200x200 JPEG.

    Returns 404 if the thumbnail hasn't been generated yet — clients
    should retry shortly after upload (the worker generates the thumb
    asynchronously). Image assets without a generated thumbnail fall
    back to the original so the UI never sees a 404 in steady state.
    """
    from carve_api.assets.models import Asset
    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    svc = AssetService(db)
    url = svc.thumbnail_url_for(a)
    if url is None:
        raise HTTPException(status_code=404, detail="thumbnail_not_ready")
    return RedirectResponse(url=url, status_code=302)


@asset_router.get("/{asset_id}", response_model=AssetWithUrl)
def get_asset(
    asset_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AssetWithUrl:
    """Return the asset row, a presigned URL to fetch its bytes, and (for
    image assets) the id of its single Frame row.

    The frontend uses ``frame_id`` to scope annotations PER ASSET. Without
    it, every annotation drawn in the editor was saved with
    ``frame_id=null`` and the per-task annotations query returned ALL
    annotations across the task — making them appear on every image.
    See v2.5.1 fix.
    """
    from carve_api.assets.models import Asset
    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    svc = AssetService(db)
    ext = a.original_name.rsplit(".", 1)[-1] if "." in a.original_name else "bin"
    return AssetWithUrl(
        asset=AssetOut.from_orm_asset(a, thumbnail_url=svc.thumbnail_url_for(a)),
        url=svc.storage.presigned_get(f"assets/{a.xxh3_128}/original.{ext}"),
        frame_id=svc.primary_frame_id_for(a),
    )


# v3.8 Phase 4.1 -- frames-list endpoint. Track-mode commit needs the
# frame_id for every frame_idx the propagation produced; this is the
# query the editor calls when entering Track mode on a video asset.
# v3.8 Phase 4-video step B -- now also returns a presigned image URL
# per frame so the editor canvas can swap to that frame on scrub.
class FrameOut(BaseModel):
    idx: int
    frame_id: str
    pts_ms: int
    url: str


@asset_router.get("/{asset_id}/frames", response_model=list[FrameOut])
def list_frames(
    asset_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[FrameOut]:
    from carve_api.assets.models import Asset, Frame

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    rows = (
        db.query(Frame)
        .filter(Frame.asset_id == a.id)
        .order_by(Frame.idx)
        .all()
    )
    storage = MinioClient.from_settings()
    out: list[FrameOut] = []
    for r in rows:
        # Per-frame JPEG keys live under assets/{hash}/frames/{idx:06d}.jpg
        # (see jobs/frames.py). Use the public presign so the browser
        # can fetch it directly.
        key = f"assets/{a.xxh3_128}/frames/{r.idx:06d}.jpg"
        url = storage.presigned_get(key, expires_seconds=3600)
        out.append(
            FrameOut(
                idx=r.idx,
                frame_id=str(r.id),
                pts_ms=int(r.pts_ms or 0),
                url=url,
            )
        )
    return out


# v3.8 Phase 4-video step D -- "Re-extract frames" endpoint. Enqueues
# the same worker the upload pipeline uses, with caller-supplied
# strategy + n. Used by the editor's Re-extract button (and by the
# upload-time dialog when the user picks a non-default strategy).
class FrameExtractIn(BaseModel):
    strategy: Literal["all", "every_nth", "count", "auto"] = "auto"
    n: int | None = None
    # v3.8 Phase 4-video step F2 — JPEG quality 0..100 (higher=better).
    # Maps to ffmpeg ``-q:v`` (1..31, lower=better). 75 is a balanced
    # default; bump to 90+ for downstream model accuracy on small objects.
    quality: int = 75


@asset_router.post(
    "/{asset_id}/frames/extract", status_code=202
)
def reextract_frames(
    asset_id: uuid.UUID,
    payload: FrameExtractIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    from carve_api.assets.models import Asset, AssetKind

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    if a.kind != AssetKind.video:
        raise HTTPException(status_code=422, detail="asset_not_video")

    import os as _os

    import redis as _redis
    from rq import Queue as _Queue

    from carve_api.assets.extract_guard import check_extract_idempotency
    from carve_api.jobs.frames import extract_frames_for_video

    client = _redis.Redis(
        host=_os.environ.get("REDIS_HOST", "redis"),
        port=int(_os.environ.get("REDIS_PORT", "6379")),
        decode_responses=True,
    )

    # v3.26 — idempotency. If a previous extract is still running, attach
    # the caller to it (return 409 with the existing job_id) instead of
    # racing a second worker against the same MinIO prefix. Stale markers
    # (worker died) are cleared inside the helper.
    existing_job_id = check_extract_idempotency(client, str(a.id))
    if existing_job_id is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "extract_in_progress",
                "job_id": existing_job_id,
            },
        )

    try:
        q = _Queue("default", connection=client)
        job = q.enqueue(
            extract_frames_for_video,
            str(a.id),
            payload.strategy,
            payload.n,
            payload.quality,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=503, detail="enqueue_failed"
        ) from exc

    return {"job_id": job.id, "strategy": payload.strategy, "n": payload.n}


# v3.8 Phase 4-video step F -- frame-extraction progress. The worker
# writes to ``frame-extract:{asset_id}`` with status/phase/decoded/
# expected/uploaded; this endpoint reads it back so the editor can
# render a live progress bar.
class FrameExtractStatusOut(BaseModel):
    status: str  # "running" | "completed" | "failed" | "idle"
    phase: str  # "decoding" | "uploading" | "done"
    decoded: int
    expected: int
    uploaded: int
    message: str | None = None
    # v3.26 — surfaces the RQ job id so the client poller can correlate
    # to a registered background job. None when there is no in-flight
    # extract for this asset.
    job_id: str | None = None


@asset_router.get(
    "/{asset_id}/frames/extract/status",
    response_model=FrameExtractStatusOut,
)
def frame_extract_status(
    asset_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FrameExtractStatusOut:
    from carve_api.assets.models import Asset

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        import os as _os

        import redis as _redis

        client = _redis.Redis(
            host=_os.environ.get("REDIS_HOST", "redis"),
            port=int(_os.environ.get("REDIS_PORT", "6379")),
            decode_responses=True,
        )
        h = client.hgetall(f"frame-extract:{asset_id}") or {}
    except Exception:
        h = {}
    return FrameExtractStatusOut(
        status=h.get("status") or "idle",
        phase=h.get("phase") or "idle",
        decoded=int(h.get("decoded") or 0),
        expected=int(h.get("expected") or 0),
        uploaded=int(h.get("uploaded") or 0),
        message=h.get("message"),
        job_id=h.get("job_id") or None,
    )


@asset_router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_asset(
    asset_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    from carve_api.assets.models import Asset
    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        task = require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    project = ProjectService(db).get(actor=user, project_id=task.project_id)
    if not _can_modify(user, project):
        raise _http(NotProjectOwner("only owner or admin can delete an asset"))
    AssetService(db).delete(asset=a)
    db.commit()


# ============================================================================
# v3.27 SAM 3.1 multiplex track surface (replaces /sam-track/*)
# ============================================================================
# Kept alongside the legacy /sam-track/* endpoints during migration. Legacy
# router is removed in the final cleanup task.

from carve_api.inference import track as track_proxy


class TrackOpenOut(BaseModel):
    session_id: str
    frame_count: int


@asset_router.post("/{asset_id}/track/sessions", response_model=TrackOpenOut)
def track_open(
    asset_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TrackOpenOut:
    from carve_api.assets.models import Asset

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        body = track_proxy.open_session(a)
    except AppError as exc:
        raise _http(exc) from exc
    return TrackOpenOut(**body)


@asset_router.post("/{asset_id}/track/sessions/{sid}/prompts")
def track_prompt(
    asset_id: uuid.UUID, sid: str, payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    from carve_api.assets.models import Asset

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        return track_proxy.add_prompt(sid, payload)
    except AppError as exc:
        raise _http(exc) from exc


@asset_router.post("/{asset_id}/track/sessions/{sid}/propagate")
def track_propagate_endpoint(
    asset_id: uuid.UUID,
    sid: str,
    payload: dict | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    from carve_api.assets.models import Asset

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    p = payload or {}
    try:
        return track_proxy.propagate(
            sid,
            start_frame=p.get("start_frame"),
            end_frame=p.get("end_frame"),
        )
    except AppError as exc:
        raise _http(exc) from exc


@asset_router.delete("/{asset_id}/track/sessions/{sid}/objects/{obj_id}")
def track_remove_object_endpoint(
    asset_id: uuid.UUID, sid: str, obj_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from carve_api.assets.models import Asset
    from fastapi import Response as _Response

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        track_proxy.remove_object(sid, obj_id)
    except AppError as exc:
        raise _http(exc) from exc
    return _Response(status_code=204)


@asset_router.delete("/{asset_id}/track/sessions/{sid}/prompts")
def track_reset_prompts_endpoint(
    asset_id: uuid.UUID, sid: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from carve_api.assets.models import Asset
    from fastapi import Response as _Response

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        track_proxy.reset_prompts(sid)
    except AppError as exc:
        raise _http(exc) from exc
    return _Response(status_code=204)


@asset_router.delete("/{asset_id}/track/sessions/{sid}")
def track_close_endpoint(
    asset_id: uuid.UUID, sid: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from carve_api.assets.models import Asset
    from fastapi import Response as _Response

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        track_proxy.close_session(sid)
    except AppError as exc:
        raise _http(exc) from exc
    return _Response(status_code=204)
