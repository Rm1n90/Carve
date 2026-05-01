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
from carve_api.projects.models import Task as TaskModel
from carve_api.projects.service import ProjectService, TaskService, _can_modify, NotProjectOwner
from carve_api.ratelimit import limiter
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

# v2.6: raised from "100/minute" so an authenticated user can drop a
# typical batch of a few hundred images without tripping a 429 mid-loop.
# The web client uploads sequentially, so 1000 RPM caps a sustained
# adversary while leaving normal batches well within budget. The zip
# upload endpoint stays at 100/minute since one zip carries many images.
SINGLE_ASSET_UPLOAD_LIMIT = "1000/minute"


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


def _require_visible_task(db: Session, user: User, task_id: uuid.UUID) -> TaskModel:
    task = db.get(TaskModel, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task_not_found")
    project = ProjectService(db).get(actor=user, project_id=task.project_id)
    TaskService(db).get(project=project, task_id=task.id)
    return task


@router.post("/{task_id}/assets", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
@limiter.limit(SINGLE_ASSET_UPLOAD_LIMIT)
async def upload_asset(
    request: Request,
    task_id: uuid.UUID,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AssetOut:
    body = await file.read()
    task = _require_visible_task(db, user, task_id)
    try:
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
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AssetListPage:
    """Paginated list of assets for a task with optional filename search and status filter.

    Each AssetOut carries a presigned ``thumbnail_url`` so the web grid
    can render tiles without a per-asset fetch. Returns a single page
    + total count so the UI can show "Showing N–M of T".
    """
    task = _require_visible_task(db, user, task_id)
    svc = AssetService(db)
    items = svc.list_for_task(task=task, limit=limit, offset=offset, q=q, status=status)
    total = svc.count_for_task(task=task, q=q, status=status)
    return AssetListPage(
        items=[
            AssetOut.from_orm_asset(a, thumbnail_url=svc.thumbnail_url_for(a)) for a in items
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
    task = _require_visible_task(db, user, task_id)
    svc = AssetService(db)
    total = svc.count_for_task(task=task)
    annotated = svc.annotated_count_for_task(task=task)
    return AssetCount(total=total, annotated=annotated, unannotated=total - annotated)


@router.post("/{task_id}/assets:zip", response_model=list[AssetOut], status_code=status.HTTP_201_CREATED)
@limiter.limit("100/minute")
async def upload_archive(
    request: Request,
    task_id: uuid.UUID,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AssetOut]:
    body = await file.read()
    task = _require_visible_task(db, user, task_id)
    try:
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
    _require_visible_task(db, user, a.task_id)
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
    _require_visible_task(db, user, a.task_id)
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
    _require_visible_task(db, user, a.task_id)
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
    _require_visible_task(db, user, a.task_id)
    if a.kind != AssetKind.video:
        raise HTTPException(status_code=422, detail="asset_not_video")

    try:
        import os as _os

        import redis as _redis
        from rq import Queue as _Queue

        from carve_api.jobs.frames import extract_frames_for_video

        client = _redis.Redis(
            host=_os.environ.get("REDIS_HOST", "redis"),
            port=int(_os.environ.get("REDIS_PORT", "6379")),
            decode_responses=True,
        )
        q = _Queue("default", connection=client)
        job = q.enqueue(
            extract_frames_for_video,
            str(a.id),
            payload.strategy,
            payload.n,
            payload.quality,
        )
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
    _require_visible_task(db, user, a.task_id)
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
    task = _require_visible_task(db, user, a.task_id)
    project = ProjectService(db).get(actor=user, project_id=task.project_id)
    if not _can_modify(user, project):
        raise _http(NotProjectOwner("only owner or admin can delete an asset"))
    AssetService(db).delete(asset=a)
    db.commit()
