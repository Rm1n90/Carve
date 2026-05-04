# Armin Mehri — mehri.armin@gmail.com
"""Annotation import HTTP endpoints.

Plan-20.5 — two-phase flow:

  1. POST /tasks/{id}/imports?format=…&dryrun=true with one OR more files
     → server stages the upload to MinIO, parses it synchronously, and
       returns a structured report (matched/unmatched files, class
       warnings, draft count, etc.) without writing any annotation rows.

  2. POST /tasks/{id}/imports/{import_id}/confirm
     → server enqueues the actual import job using the staged file. The
       caller polls /imports/{id} for progress as before.

Loose ``.txt`` uploads (the typical YOLO-export-then-edit-locally flow)
are bundled server-side into an in-memory ZIP under ``labels/`` so the
existing parser path keeps working. When the user doesn't include a
``data.yaml`` / ``classes.txt``, we fall back to the project's classes
ordered by ``idx`` so class indices in the .txt still resolve.
"""

import uuid
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.io.coco_in import parse_coco_bytes
from carve_api.io.import_job import (
    ImportJobPayload,
    _build_asset_map,
    _build_class_map,
    _build_dim_map,
    read_progress,
    run_import_job,
)
from carve_api.io.yolo_in import ParsedArchive, parse_yolo_archive
from carve_api.projects.models import Class, Task
from carve_api.projects.service import (
    _MUTATING_ROLES,
    require_project_role,
    require_visible_task,
)
from carve_api.storage.client import MinioClient
from carve_api.assets.models import Asset


def _http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


router = APIRouter(prefix="/tasks", tags=["import"])


_MAX_BYTES = 1024 * 1024 * 1024  # 1 GiB total upload
_STAGING_KEY_PREFIX = "imp:staging:"
_STAGING_TTL_SECONDS = 24 * 3600


def _redis_client_or_none():
    """Best-effort Redis client; returns None when unreachable."""
    from redis import Redis

    from carve_api.config import get_settings

    s = get_settings()
    try:
        client = Redis(host=s.redis_host, port=s.redis_port, socket_connect_timeout=1)
        client.ping()
        return client
    except Exception:
        return None


def _staging_key(import_id: str) -> str:
    return f"{_STAGING_KEY_PREFIX}{import_id}"


def _bundle_loose_files_to_zip(
    txt_files: list[tuple[str, bytes]],
    extras: dict[str, bytes],
) -> bytes:
    """Build an in-memory YOLO-shaped ZIP from a set of loose ``.txt`` files
    plus optional ``data.yaml`` / ``names.txt`` / ``classes.txt`` extras.

    The parser only cares about file extensions and ``names:`` content,
    so we put .txt files under ``labels/`` and any provided yaml at the
    root.
    """
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, body in txt_files:
            stem = Path(name).name
            zf.writestr(f"labels/{stem}", body)
        for extra_name, body in extras.items():
            zf.writestr(extra_name, body)
    return buf.getvalue()


def _classes_from_names_txt(body: bytes) -> list[str]:
    """``classes.txt`` / ``names.txt`` is one class name per line; index
    is the line number. Used when the user's loose-txt upload included
    one of those convention files instead of (or alongside) data.yaml."""
    names = [
        ln.strip().strip('"\'')
        for ln in body.decode("utf-8", errors="replace").splitlines()
    ]
    return [n for n in names if n]


def _build_dryrun_report(
    *,
    parsed: ParsedArchive,
    assets: list[Asset],
    classes: list[Class],
) -> dict:
    """Plan-20.5 — produce the validation report shown to the user
    before they commit. Counts what would be inserted, lists what would
    be skipped, and explains why."""
    asset_map = _build_asset_map(assets)
    class_map = _build_class_map(classes)
    matched_files: set[str] = set()
    unmatched_files: dict[str, int] = {}
    unknown_classes: dict[str, int] = {}
    importable = 0
    by_kind: dict[str, int] = {}
    for d in parsed.drafts:
        fname = d.image_filename
        asset = (
            asset_map.get(fname.lower())
            or asset_map.get(f"{fname}.png".lower())
            or asset_map.get(f"{fname}.jpg".lower())
            or asset_map.get(f"{fname}.jpeg".lower())
        )
        if asset is None:
            unmatched_files[fname] = unmatched_files.get(fname, 0) + 1
            continue
        cls_id = class_map.get(d.class_name.lower())
        if cls_id is None:
            unknown_classes[d.class_name] = unknown_classes.get(d.class_name, 0) + 1
            continue
        matched_files.add(asset.original_name)
        importable += 1
        kind = getattr(d.kind, "value", str(d.kind))
        by_kind[kind] = by_kind.get(kind, 0) + 1
    return {
        "total_parsed": len(parsed.drafts),
        "importable": importable,
        "by_kind": by_kind,
        "matched_files": sorted(matched_files),
        "unmatched_files": [
            {"file": k, "rows": v}
            for k, v in sorted(unmatched_files.items(), key=lambda kv: -kv[1])
        ],
        "unknown_classes": [
            {"class": k, "rows": v}
            for k, v in sorted(unknown_classes.items(), key=lambda kv: -kv[1])
        ],
        "class_names_resolved": list(parsed.class_names),
        "parse_warnings": list(parsed.warnings),
    }


@router.post("/{task_id}/imports", status_code=status.HTTP_202_ACCEPTED)
async def enqueue_import(
    task_id: uuid.UUID,
    fmt: Literal["yolo", "coco"] = Query(..., alias="format"),
    dryrun: bool = Query(False),
    files: list[UploadFile] = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Stage an import. With ``dryrun=true`` (recommended), parse and
    return the validation report; do NOT write annotations. The caller
    then POSTs to ``/imports/{import_id}/confirm`` to commit. With
    ``dryrun=false``, behaves like the legacy single-shot import."""
    try:
        task = require_visible_task(db, user, task_id)
        # Plan-13 Phase 7 Task 2 — import submit is a mutation; viewers 403.
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc

    if not files:
        raise HTTPException(status_code=400, detail="no_files")

    # Read every file into memory once. The 1 GiB cap below kicks in
    # before we exhaust RAM on the worker.
    blobs: list[tuple[str, bytes]] = []
    total = 0
    for f in files:
        body = await f.read()
        total += len(body)
        if total > _MAX_BYTES:
            raise HTTPException(status_code=413, detail="import_too_large")
        blobs.append(((f.filename or "unnamed").strip(), body))

    # ---- bundle into a single archive payload --------------------------
    extras: dict[str, bytes] = {}
    txt_files: list[tuple[str, bytes]] = []
    zip_blob: bytes | None = None
    json_blob: bytes | None = None
    for name, body in blobs:
        nl = name.lower()
        if nl.endswith(".zip"):
            if zip_blob is not None:
                raise HTTPException(status_code=400, detail="only_one_zip_supported")
            zip_blob = body
        elif nl.endswith(".json"):
            if json_blob is not None:
                raise HTTPException(status_code=400, detail="only_one_json_supported")
            json_blob = body
        elif nl.endswith(".yaml") or nl.endswith(".yml"):
            extras["data.yaml"] = body
        elif nl in ("classes.txt", "names.txt"):
            extras[nl] = body
        elif nl.endswith(".txt"):
            txt_files.append((Path(name).name, body))
        else:
            raise HTTPException(
                status_code=400,
                detail=f"unsupported_file_extension: {name}",
            )

    if fmt == "yolo":
        if zip_blob is not None:
            payload_bytes = zip_blob
            ext = "zip"
        elif txt_files:
            yolo_extras = dict(extras)
            if "names.txt" in extras and "data.yaml" not in extras:
                names = _classes_from_names_txt(extras["names.txt"])
                yolo_extras["data.yaml"] = (
                    "names: [" + ", ".join(f'"{n}"' for n in names) + "]\n"
                ).encode("utf-8")
            elif "classes.txt" in extras and "data.yaml" not in extras:
                names = _classes_from_names_txt(extras["classes.txt"])
                yolo_extras["data.yaml"] = (
                    "names: [" + ", ".join(f'"{n}"' for n in names) + "]\n"
                ).encode("utf-8")
            payload_bytes = _bundle_loose_files_to_zip(txt_files, yolo_extras)
            ext = "zip"
        else:
            raise HTTPException(status_code=400, detail="yolo_needs_zip_or_txt")
    else:  # coco
        if zip_blob is not None:
            payload_bytes = zip_blob
            ext = "zip"
        elif json_blob is not None:
            payload_bytes = json_blob
            ext = "json"
        else:
            raise HTTPException(status_code=400, detail="coco_needs_zip_or_json")

    # ---- stage to MinIO -------------------------------------------------
    import_id = uuid.uuid4()
    minio_key = f"imports/{task.id}/{import_id}.{ext}"
    storage = MinioClient.from_settings()
    storage.ensure_bucket()
    storage.put_object(
        minio_key,
        BytesIO(payload_bytes),
        len(payload_bytes),
        "application/zip" if ext == "zip" else "application/json",
    )

    # ---- record staging info so /confirm can find the file -------------
    redis_client = _redis_client_or_none()
    if redis_client is not None:
        try:
            redis_client.hset(
                _staging_key(str(import_id)),
                mapping={
                    "task_id": str(task.id),
                    "minio_key": minio_key,
                    "fmt": fmt,
                },
            )
            redis_client.expire(_staging_key(str(import_id)), _STAGING_TTL_SECONDS)
        except Exception:
            pass

    # ---- dryrun: parse + report (no DB writes) -------------------------
    if dryrun:
        assets = list(
            db.execute(select(Asset).where(Asset.task_id == task.id)).scalars(),
        )
        classes = list(
            db.execute(
                select(Class)
                .where(Class.project_id == task.project_id)
                .order_by(Class.idx)
            ).scalars(),
        )
        try:
            if fmt == "yolo":
                fallback = [c.name for c in classes]
                parsed = parse_yolo_archive(
                    payload_bytes,
                    image_dimensions=_build_dim_map(assets),
                    fallback_class_names=fallback,
                )
            else:
                parsed = parse_coco_bytes(payload_bytes)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=400,
                detail=f"parse_failed: {exc!r}",
            )
        report = _build_dryrun_report(parsed=parsed, assets=assets, classes=classes)
        return {
            "import_id": str(import_id),
            "format": fmt,
            "status": "awaiting_confirmation",
            "report": report,
        }

    # ---- non-dryrun: enqueue the actual import (legacy fast path) ------
    job_payload = ImportJobPayload(
        job_id=str(import_id),
        actor_id=str(user.id),
        task_id=str(task.id),
        import_id=str(import_id),
        minio_key=minio_key,
        fmt=fmt,
    )
    try:
        from rq import Queue
        client = redis_client or _redis_client_or_none()
        if client is not None:
            q = Queue("default", connection=client)
            q.enqueue(run_import_job, job_payload)
    except Exception:
        pass

    return {"import_id": str(import_id)}


@router.post("/{task_id}/imports/{import_id}/confirm", status_code=status.HTTP_202_ACCEPTED)
def confirm_import(
    task_id: uuid.UUID,
    import_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Plan-20.5 — commit a previously-staged dryrun import. Looks up
    the staged ``minio_key`` from Redis and enqueues the actual import
    job. Returns 404 when the staged record has expired (TTL 24h)."""
    try:
        task = require_visible_task(db, user, task_id)
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc

    redis_client = _redis_client_or_none()
    if redis_client is None:
        raise HTTPException(status_code=503, detail="redis_unavailable")
    raw = redis_client.hgetall(_staging_key(import_id))
    if not raw:
        raise HTTPException(status_code=404, detail="staged_import_not_found_or_expired")

    def _b2s(v):
        return v.decode() if isinstance(v, bytes) else v

    info = {_b2s(k): _b2s(v) for k, v in raw.items()}
    if info.get("task_id") != str(task.id):
        raise HTTPException(status_code=404, detail="staged_import_for_other_task")

    payload = ImportJobPayload(
        job_id=import_id,
        actor_id=str(user.id),
        task_id=str(task.id),
        import_id=import_id,
        minio_key=info["minio_key"],
        fmt=info["fmt"],
    )
    try:
        from rq import Queue
        q = Queue("default", connection=redis_client)
        q.enqueue(run_import_job, payload)
    except Exception:
        # If RQ isn't available, run inline so the user still gets a
        # result. Synchronous fallback uses the same code path.
        run_import_job(payload)

    try:
        redis_client.delete(_staging_key(import_id))
    except Exception:
        pass

    return {"import_id": import_id, "status": "running"}


@router.get("/{task_id}/imports/{import_id}")
def get_import_progress(
    task_id: uuid.UUID,
    import_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    return read_progress(_redis_client_or_none(), import_id)
