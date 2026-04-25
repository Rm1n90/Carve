# Plan 03 — Asset Ingestion

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Upload images and videos to a task, store them content-addressed in MinIO, extract thumbnails (and video frames lazily), and list them in the UI. Sets the stage for annotation in Plan 04.

**Architecture:**
- `Asset` row holds metadata. Bytes live in MinIO at `assets/<xxh3-hex>/original.<ext>`.
- `Frame` rows are created lazily for videos by an RQ worker (FFmpeg). For images, exactly one `Frame` row is created at upload time.
- A small `MinioClient` wrapper centralises bucket operations.
- The web UI gets an upload dropzone and a paginated asset grid.

**Tech additions:** `Pillow`, `xxhash`, `ffmpeg-python` (Python). `react-dropzone` (web).

---

## Series context
- ✅ Plan 01 — Foundation & Auth
- ✅ Plan 02 — Projects, Tasks, Classes
- **Plan 03 — Asset ingestion** ← *this plan*
- Plan 04 — Manual annotation canvas
- Plan 05 — YOLO model service
- Plan 06 — Annotation import/export
- Plan 07 — Analytics dashboards
- Plan 08 — Deployment polish

---

## Task 1: Asset & Frame ORM models + migration 0003

**Files:** `apps/api/src/vaa_api/assets/{__init__,models}.py`; `apps/api/alembic/versions/0003_assets_frames.py`; `apps/api/tests/assets/{__init__,test_models}.py`; modify `alembic/env.py` and `pyproject.toml`.

**Step 1.1 — Failing test** `tests/assets/test_models.py`:

```python
from vaa_api.assets.models import Asset, AssetKind, Frame
from vaa_api.auth.models import User, UserRole
from vaa_api.projects.models import Project, Task, TaskKind


def _setup(db):
    u = User(email="a@x.com", password_hash="x", role=UserRole.admin)
    db.add(u); db.flush()
    p = Project(name="P", owner_id=u.id); db.add(p); db.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image); db.add(t); db.flush()
    return t


def test_create_image_asset(db_session) -> None:
    t = _setup(db_session)
    a = Asset(
        task_id=t.id, kind=AssetKind.image, xxh3_128="aabb",
        mime="image/png", size_bytes=1234, width=640, height=480,
        frames=1, original_name="x.png",
    )
    db_session.add(a); db_session.flush()
    assert a.id is not None


def test_create_video_asset_with_frames(db_session) -> None:
    t = _setup(db_session)
    a = Asset(
        task_id=t.id, kind=AssetKind.video, xxh3_128="ccdd",
        mime="video/mp4", size_bytes=99999, width=1280, height=720,
        frames=120, original_name="v.mp4",
    )
    db_session.add(a); db_session.flush()
    f = Frame(asset_id=a.id, idx=0, pts_ms=0)
    db_session.add(f); db_session.flush()
    assert f.id is not None
```

**Step 1.2 — Implement** `apps/api/src/vaa_api/assets/models.py`:

```python
import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger, DateTime, Enum, ForeignKey, Integer, String, UniqueConstraint, func
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from vaa_api.db import Base


class AssetKind(str, enum.Enum):
    image = "image"
    video = "video"


class Asset(Base):
    __tablename__ = "assets"
    __table_args__ = (
        UniqueConstraint("task_id", "xxh3_128", name="uq_assets_task_hash"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[AssetKind] = mapped_column(Enum(AssetKind, name="asset_kind"), nullable=False)
    xxh3_128: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    mime: Mapped[str] = mapped_column(String(80), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    frames: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Frame(Base):
    __tablename__ = "frames"
    __table_args__ = (UniqueConstraint("asset_id", "idx", name="uq_frames_asset_idx"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    asset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("assets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    idx: Mapped[int] = mapped_column(Integer, nullable=False)
    pts_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
```

**Step 1.3 — Migration** `0003_assets_frames.py`: revision `0003`, down_revision `0002`. Creates `asset_kind` ENUM, `assets` table (with all columns above), `frames` table, indexes on `task_id`/`asset_id`, and the two unique constraints. Use the same pattern as 0001 and 0002. Downgrade drops everything in reverse.

**Step 1.4 — Update** `alembic/env.py`: add `import vaa_api.assets.models  # noqa: F401, E402`.

**Step 1.5 — Add deps** to `apps/api/pyproject.toml [project].dependencies`:
```
"Pillow==11.1.0",
"xxhash==3.5.0",
"ffmpeg-python==0.2.0",
```
Re-run `pip install -e ".[dev]"`.

**Step 1.6 — Run** `pytest tests/assets/test_models.py -v` (expect 2 PASS), then `pytest tests/ -v` (expect 56 PASS).

**Step 1.7 — Commit:** `feat(api): Asset & Frame models + migration 0003`

---

## Task 2: Storage layer — MinioClient + xxh3 hashing

**Files:** `apps/api/src/vaa_api/storage/{__init__,client,hashing}.py`; `apps/api/tests/storage/{__init__,test_storage}.py`; modify `config.py` (add MinIO settings) and `tests/conftest.py` (add MinIO env defaults).

**Step 2.1 — Add to `Settings`:**

```python
minio_endpoint: str = Field(alias="MINIO_ENDPOINT", default="http://localhost:9000")
minio_root_user: str = Field(alias="MINIO_ROOT_USER")
minio_root_password: str = Field(alias="MINIO_ROOT_PASSWORD")
minio_bucket: str = Field(alias="MINIO_BUCKET", default="vaa-assets")
redis_host: str = Field(alias="REDIS_HOST", default="redis")
redis_port: int = Field(alias="REDIS_PORT", default=6379)
```

Append in `_set_test_env`:
```python
os.environ.setdefault("MINIO_ROOT_USER", "vaa")
os.environ.setdefault("MINIO_ROOT_PASSWORD", "vaa")
os.environ.setdefault("MINIO_ENDPOINT", "http://localhost:9000")
os.environ.setdefault("MINIO_BUCKET", "vaa-assets-test")
```

**Step 2.2 — `storage/hashing.py`:**

```python
import xxhash


def stream_xxh3_128(stream, chunk: int = 65536) -> str:
    h = xxhash.xxh3_128()
    while True:
        b = stream.read(chunk)
        if not b:
            break
        h.update(b)
    return h.hexdigest()
```

**Step 2.3 — `storage/client.py`:**

```python
from typing import BinaryIO

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from vaa_api.config import get_settings


class MinioClient:
    def __init__(self, *, endpoint: str, access_key: str, secret_key: str, bucket: str) -> None:
        self.bucket = bucket
        self._s3 = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=Config(signature_version="s3v4"),
            region_name="us-east-1",
        )

    @classmethod
    def from_settings(cls) -> "MinioClient":
        s = get_settings()
        return cls(
            endpoint=s.minio_endpoint,
            access_key=s.minio_root_user,
            secret_key=s.minio_root_password,
            bucket=s.minio_bucket,
        )

    def ensure_bucket(self) -> None:
        try:
            self._s3.head_bucket(Bucket=self.bucket)
        except ClientError:
            self._s3.create_bucket(Bucket=self.bucket)

    def put_object(self, key: str, body: BinaryIO, length: int, content_type: str) -> None:
        self._s3.put_object(
            Bucket=self.bucket, Key=key, Body=body,
            ContentLength=length, ContentType=content_type,
        )

    def get_object(self, key: str):
        return self._s3.get_object(Bucket=self.bucket, Key=key)["Body"]

    def remove_object(self, key: str) -> None:
        self._s3.delete_object(Bucket=self.bucket, Key=key)

    def presigned_get(self, key: str, expires_seconds: int = 600) -> str:
        return self._s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": key},
            ExpiresIn=expires_seconds,
        )
```

**Step 2.4 — Test** `tests/storage/test_storage.py`: unit-test `stream_xxh3_128` with known inputs (any 32-hex digest of len 32). Skip the MinIO round-trip behind a `--minio` pytest CLI flag (CI-only).

**Step 2.5 — Commit:** `feat(api): MinIO client + xxh3-128 streaming hash`

---

## Task 3: AssetService + upload/list endpoints

**Files:** `apps/api/src/vaa_api/assets/{schemas,service,router}.py`; `apps/api/tests/assets/{test_service,test_router}.py`; modify `main.py`.

**Step 3.1 — Failing test** `tests/assets/test_router.py`:

```python
import io

from fastapi.testclient import TestClient

from vaa_api.deps import get_db
from vaa_api.main import create_app


def _client(db_session):
    app = create_app()
    def _override():
        try: yield db_session
        finally: db_session.rollback()
    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(t): return {"Authorization": f"Bearer {t}"}


def _setup(client):
    client.post("/auth/register", json={"email": "u@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "u@x.com", "password": "hunter22"}).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(token)).json()["id"]
    return token, pid, tid


def test_upload_image_creates_asset(db_session, monkeypatch) -> None:
    from vaa_api.assets import service as svc_mod
    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)

    client = _client(db_session)
    token, pid, tid = _setup(client)
    r = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("image.png", io.BytesIO(_tiny_png()), "image/png")},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["mime"] == "image/png"
    assert body["kind"] == "image"


def test_list_assets_for_task(db_session, monkeypatch) -> None:
    from vaa_api.assets import service as svc_mod
    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client = _client(db_session)
    token, pid, tid = _setup(client)
    client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(_tiny_png()), "image/png")},
        headers=_hdr(token),
    )
    r = client.get(f"/tasks/{tid}/assets", headers=_hdr(token))
    assert r.status_code == 200
    assert len(r.json()) == 1


def test_duplicate_asset_returns_409(db_session, monkeypatch) -> None:
    from vaa_api.assets import service as svc_mod
    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client = _client(db_session)
    token, pid, tid = _setup(client)
    png = _tiny_png()
    client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(png), "image/png")},
        headers=_hdr(token),
    )
    r = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("b.png", io.BytesIO(png), "image/png")},
        headers=_hdr(token),
    )
    assert r.status_code == 409


def test_mime_mismatch_returns_400(db_session, monkeypatch) -> None:
    from vaa_api.assets import service as svc_mod
    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client = _client(db_session)
    token, pid, tid = _setup(client)  # image task
    r = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("v.mp4", io.BytesIO(b"\x00\x00\x00\x18ftypmp42"), "video/mp4")},
        headers=_hdr(token),
    )
    assert r.status_code == 400


def _tiny_png() -> bytes:
    return bytes.fromhex(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA63000000000200015C8B59FA0000000049454E44AE426082"
    )


class _FakeStorage:
    @classmethod
    def from_settings(cls): return cls()
    def ensure_bucket(self): pass
    def put_object(self, *a, **k): pass
    def get_object(self, key): import io; return io.BytesIO(b"")
    def remove_object(self, key): pass
    def presigned_get(self, key, **k): return f"https://fake/{key}"
```

**Step 3.2 — `assets/schemas.py`:**

```python
from datetime import datetime
from pydantic import BaseModel
from vaa_api.assets.models import AssetKind


class AssetOut(BaseModel):
    id: str
    task_id: str
    kind: AssetKind
    xxh3_128: str
    mime: str
    size_bytes: int
    width: int | None
    height: int | None
    frames: int
    original_name: str
    created_at: datetime

    @classmethod
    def from_orm_asset(cls, a):
        return cls(
            id=str(a.id), task_id=str(a.task_id), kind=a.kind, xxh3_128=a.xxh3_128,
            mime=a.mime, size_bytes=a.size_bytes, width=a.width, height=a.height,
            frames=a.frames, original_name=a.original_name, created_at=a.created_at,
        )
```

**Step 3.3 — `assets/service.py`:**

```python
from io import BytesIO

from PIL import Image
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from vaa_api.assets.models import Asset, AssetKind, Frame
from vaa_api.errors import AppError
from vaa_api.projects.models import Task, TaskKind
from vaa_api.storage.client import MinioClient
from vaa_api.storage.hashing import stream_xxh3_128

_IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp"}
_VIDEO_MIMES = {"video/mp4", "video/webm", "video/quicktime"}
_MAX_BYTES = 1024 * 1024 * 1024  # 1 GiB


class AssetTooLarge(AppError):
    http_status = 413; code = "asset_too_large"


class AssetMimeUnsupported(AppError):
    http_status = 415; code = "asset_mime_unsupported"


class AssetMismatchTask(AppError):
    http_status = 400; code = "asset_mime_mismatch_task_kind"


class AssetDuplicate(AppError):
    http_status = 409; code = "asset_duplicate"


class AssetService:
    def __init__(self, session: Session) -> None:
        self.session = session
        self.storage = MinioClient.from_settings()

    def upload(self, *, task: Task, original_name: str, mime: str, body: bytes) -> Asset:
        if len(body) > _MAX_BYTES:
            raise AssetTooLarge("upload exceeds 1 GiB")
        kind = self._kind_for(mime, task.kind)
        h = stream_xxh3_128(BytesIO(body))
        width = height = None
        frames = 1
        if kind == AssetKind.image:
            with Image.open(BytesIO(body)) as im:
                width, height = im.size
        else:
            frames = 0  # populated by worker in Task 6
        try:
            asset = Asset(
                task_id=task.id, kind=kind, xxh3_128=h, mime=mime,
                size_bytes=len(body), width=width, height=height,
                frames=frames, original_name=original_name,
            )
            self.session.add(asset)
            self.session.flush()
        except IntegrityError as exc:
            self.session.rollback()
            raise AssetDuplicate("identical asset already exists in this task") from exc

        ext = original_name.rsplit(".", 1)[-1] if "." in original_name else "bin"
        key = f"assets/{h}/original.{ext}"
        self.storage.ensure_bucket()
        self.storage.put_object(key, BytesIO(body), len(body), mime)

        if kind == AssetKind.image:
            self.session.add(Frame(asset_id=asset.id, idx=0, pts_ms=0))
            self.session.flush()
        return asset

    def list_for_task(self, *, task: Task) -> list[Asset]:
        return list(self.session.execute(
            select(Asset).where(Asset.task_id == task.id).order_by(Asset.created_at)
        ).scalars())

    def delete(self, *, asset: Asset) -> None:
        ext = asset.original_name.rsplit(".", 1)[-1] if "." in asset.original_name else "bin"
        try:
            self.storage.remove_object(f"assets/{asset.xxh3_128}/original.{ext}")
        except Exception:
            pass  # best-effort; row removal is the source of truth
        self.session.delete(asset)
        self.session.flush()

    @staticmethod
    def _kind_for(mime: str, task_kind: TaskKind) -> AssetKind:
        if mime in _IMAGE_MIMES:
            kind = AssetKind.image
        elif mime in _VIDEO_MIMES:
            kind = AssetKind.video
        else:
            raise AssetMimeUnsupported(f"unsupported mime {mime}")
        if task_kind == TaskKind.image and kind != AssetKind.image:
            raise AssetMismatchTask("image task accepts images only")
        if task_kind == TaskKind.video and kind != AssetKind.video:
            raise AssetMismatchTask("video task accepts videos only")
        return kind
```

**Step 3.4 — `assets/router.py`:**

```python
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from vaa_api.assets.schemas import AssetOut
from vaa_api.assets.service import AssetService
from vaa_api.auth.models import User
from vaa_api.deps import get_current_user, get_db
from vaa_api.errors import AppError
from vaa_api.projects.models import Task as TaskModel
from vaa_api.projects.service import ProjectService, TaskService

router = APIRouter(prefix="/tasks", tags=["assets"])
asset_router = APIRouter(prefix="/assets", tags=["assets"])  # /assets/{id} endpoints


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
async def upload_asset(
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
    return AssetOut.from_orm_asset(asset)


@router.get("/{task_id}/assets", response_model=list[AssetOut])
def list_assets(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AssetOut]:
    task = _require_visible_task(db, user, task_id)
    return [AssetOut.from_orm_asset(a) for a in AssetService(db).list_for_task(task=task)]
```

**Step 3.5 — Mount in `main.py`:**
```python
from vaa_api.assets.router import asset_router, router as task_assets_router
app.include_router(task_assets_router)
app.include_router(asset_router)
```

**Step 3.6 — Run tests** — 4 new + 54 prior = 58 PASS. Commit: `feat(api): asset upload + list with content-hash dedup`

---

## Task 4: ZIP archive upload (bulk image)

**Files:** modify `assets/{router,service}.py`; add `tests/assets/test_zip_upload.py`.

**Step 4.1 — Test:** `POST /tasks/{tid}/assets:zip` with a zip containing 3 PNGs returns 3 `AssetOut`s.

**Step 4.2 — Service method:**

```python
import zipfile

def upload_archive(self, *, task: Task, archive_bytes: bytes) -> list[Asset]:
    out: list[Asset] = []
    with zipfile.ZipFile(BytesIO(archive_bytes)) as zf:
        for member in zf.infolist():
            if member.is_dir(): continue
            ext = member.filename.lower().rsplit(".", 1)[-1] if "." in member.filename else ""
            mime = {
                "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "webp": "image/webp",
            }.get(ext)
            if mime is None: continue
            data = zf.read(member)
            try:
                out.append(self.upload(task=task, original_name=member.filename, mime=mime, body=data))
            except AssetDuplicate:
                continue  # skip dupes silently in archive uploads
    return out
```

**Step 4.3 — Endpoint:**

```python
@router.post("/{task_id}/assets:zip", response_model=list[AssetOut], status_code=status.HTTP_201_CREATED)
async def upload_archive(task_id: uuid.UUID, file: UploadFile = File(...), user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[AssetOut]:
    body = await file.read()
    task = _require_visible_task(db, user, task_id)
    try:
        assets = AssetService(db).upload_archive(task=task, archive_bytes=body)
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return [AssetOut.from_orm_asset(a) for a in assets]
```

**Step 4.4 — Commit:** `feat(api): bulk ZIP upload for image tasks`

---

## Task 5: Asset GET (presigned URL) + DELETE

**Files:** modify `assets/{router,service}.py`; add `tests/assets/test_asset_url.py`.

**Step 5.1 — Test:** `GET /assets/{id}` returns `{"asset": {...}, "url": "https://..."}`. URL contains the bucket name and the asset hash.

**Step 5.2 — Add to `asset_router`:**

```python
@asset_router.get("/{asset_id}")
def get_asset(
    asset_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from vaa_api.assets.models import Asset
    a = db.get(Asset, asset_id)
    if a is None: raise HTTPException(404, "asset_not_found")
    task = _require_visible_task(db, user, a.task_id)
    storage = MinioClient.from_settings()
    ext = a.original_name.rsplit(".", 1)[-1] if "." in a.original_name else "bin"
    return {
        "asset": AssetOut.from_orm_asset(a).model_dump(mode="json"),
        "url": storage.presigned_get(f"assets/{a.xxh3_128}/original.{ext}"),
    }


@asset_router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_asset(
    asset_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    from vaa_api.assets.models import Asset
    a = db.get(Asset, asset_id)
    if a is None: raise HTTPException(404, "asset_not_found")
    task = _require_visible_task(db, user, a.task_id)
    project = ProjectService(db).get(actor=user, project_id=task.project_id)
    from vaa_api.projects.service import _can_modify, NotProjectOwner
    if not _can_modify(user, project):
        raise _http(NotProjectOwner("only owner or admin can delete an asset"))
    AssetService(db).delete(asset=a)
    db.commit()
```

**Step 5.3 — Commit:** `feat(api): asset detail with presigned URL and owner-guarded delete`

---

## Task 6: RQ worker — thumbnail + video probe

**Files:** `apps/api/src/vaa_api/jobs/{__init__,queue,thumbs}.py`; modify `docker-compose.yml`/override.

**Step 6.1 — `jobs/queue.py`:**

```python
from redis import Redis
from rq import Queue

from vaa_api.config import get_settings


def get_queue() -> Queue:
    s = get_settings()
    return Queue("default", connection=Redis(host=s.redis_host, port=s.redis_port))
```

**Step 6.2 — `jobs/thumbs.py`:**

```python
from io import BytesIO

import ffmpeg
from PIL import Image
from sqlalchemy import update

from vaa_api.assets.models import Asset
from vaa_api.db import get_session_factory
from vaa_api.storage.client import MinioClient


def generate_image_thumbnail(asset_hash: str, ext: str, max_side: int = 320) -> None:
    storage = MinioClient.from_settings()
    body = storage.get_object(f"assets/{asset_hash}/original.{ext}").read()
    with Image.open(BytesIO(body)) as im:
        im.thumbnail((max_side, max_side))
        out = BytesIO()
        im.save(out, format="WEBP", quality=82)
        out.seek(0)
        storage.put_object(
            f"assets/{asset_hash}/thumb.webp",
            out, out.getbuffer().nbytes, "image/webp",
        )


def probe_video_metadata(asset_id: str, asset_hash: str, ext: str) -> None:
    storage = MinioClient.from_settings()
    url = storage.presigned_get(f"assets/{asset_hash}/original.{ext}", expires_seconds=300)
    probe = ffmpeg.probe(url)
    v = next(s for s in probe["streams"] if s["codec_type"] == "video")
    width = int(v["width"]); height = int(v["height"])
    nb = int(v.get("nb_frames", 0))
    if nb == 0:
        dur = float(probe["format"].get("duration", 0))
        num, den = (int(x) for x in v.get("avg_frame_rate", "0/1").split("/"))
        nb = int(dur * num / den) if den else 0

    SessionLocal = get_session_factory()
    with SessionLocal.begin() as s:
        s.execute(
            update(Asset).where(Asset.id == asset_id)
            .values(width=width, height=height, frames=nb)
        )
```

**Step 6.3 — Enqueue from `AssetService.upload`** (after the row is committed):
```python
from vaa_api.jobs.queue import get_queue
from vaa_api.jobs.thumbs import generate_image_thumbnail, probe_video_metadata

if kind == AssetKind.image:
    get_queue().enqueue(generate_image_thumbnail, h, ext)
else:
    get_queue().enqueue(probe_video_metadata, str(asset.id), h, ext)
```

(Move enqueue calls to the router — after `db.commit()` — to ensure the job sees the row.)

**Step 6.4 — docker-compose `worker` service:**

```yaml
  worker:
    build: ./apps/api
    restart: unless-stopped
    command: ["rq", "worker", "default", "--url", "redis://redis:6379/0"]
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      REDIS_HOST: redis
      REDIS_PORT: 6379
      JWT_SECRET: ${JWT_SECRET}
      PASSWORD_PEPPER: ${PASSWORD_PEPPER}
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
      MINIO_ENDPOINT: ${MINIO_ENDPOINT}
      MINIO_BUCKET: ${MINIO_BUCKET}
    depends_on:
      redis: { condition: service_healthy }
      minio: { condition: service_healthy }
      postgres: { condition: service_healthy }
```

**Step 6.5 — Tests:** unit-test `generate_image_thumbnail` against a fake `MinioClient` that records calls (skip in CI without MinIO).

**Step 6.6 — Commit:** `feat(api): RQ worker for thumbnails and video metadata probing`

---

## Task 7: Web — upload dialog + asset grid

**Files:** `apps/web/src/api/assets.ts`; `apps/web/src/pages/AssetUploadDialog.tsx`; `apps/web/src/pages/AssetGrid.tsx`; `apps/web/src/routes/projects.$projectId.tasks.$taskId.tsx`; modify `main.tsx`, `pages/ProjectDetailPage.tsx`, `package.json`. Tests `tests/asset-upload-dialog.test.tsx`, `tests/asset-grid.test.tsx`.

**Step 7.1 — `api/assets.ts`:**

```ts
import { api } from "./client";

export type AssetKind = "image" | "video";

export interface Asset {
  id: string;
  task_id: string;
  kind: AssetKind;
  xxh3_128: string;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  frames: number;
  original_name: string;
  created_at: string;
}

export interface AssetWithUrl {
  asset: Asset;
  url: string;
}

export const assetsApi = {
  listForTask: async (taskId: string): Promise<Asset[]> =>
    (await api.get<Asset[]>(`/tasks/${taskId}/assets`)).data,
  upload: async (taskId: string, file: File): Promise<Asset> => {
    const fd = new FormData();
    fd.append("file", file);
    return (await api.post<Asset>(`/tasks/${taskId}/assets`, fd, {
      headers: { "Content-Type": "multipart/form-data" },
    })).data;
  },
  uploadZip: async (taskId: string, file: File): Promise<Asset[]> => {
    const fd = new FormData();
    fd.append("file", file);
    return (await api.post<Asset[]>(`/tasks/${taskId}/assets:zip`, fd, {
      headers: { "Content-Type": "multipart/form-data" },
    })).data;
  },
  get: async (assetId: string): Promise<AssetWithUrl> =>
    (await api.get<AssetWithUrl>(`/assets/${assetId}`)).data,
  delete: async (assetId: string): Promise<void> => {
    await api.delete(`/assets/${assetId}`);
  },
};
```

**Step 7.2 — `AssetUploadDialog.tsx`:** uses `react-dropzone`. On drop, calls `assetsApi.upload` for each file (or `uploadZip` if a single .zip), tracks per-file progress in local state, invalidates `["assets", taskId]` on completion.

**Step 7.3 — `AssetGrid.tsx`:** `useQuery(["assets", taskId])` → render a grid. For each image asset, fetch its `url` lazily via `useQuery(["asset", id])` with a long stale time, then render `<img src={url}>`. Video assets show a video icon and the frame count. Click handler: navigate to `/projects/$projectId/tasks/$taskId/assets/$assetId` (Plan 04).

**Step 7.4 — Route** `/projects/$projectId/tasks/$taskId` mounts `AssetUploadDialog` + `AssetGrid` with the project + task header.

**Step 7.5 — Tests:** mock `assetsApi`, simulate file drop, assert `upload` called.

**Step 7.6 — Commit:** `feat(web): asset upload dropzone + asset grid view per task`

---

## Task 8: First-run MinIO bucket bootstrap

**Files:** `infra/minio/init.sh`; modify `docker-compose.yml`.

**Step 8.1 — `infra/minio/init.sh`:**

```bash
#!/usr/bin/env sh
set -e
mc alias set local "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "local/$MINIO_BUCKET"
echo "bucket $MINIO_BUCKET ready"
```

**Step 8.2 — `docker-compose.yml`** add:
```yaml
  minio-init:
    image: minio/mc:RELEASE.2025-02-08T19-25-46Z
    depends_on: { minio: { condition: service_healthy } }
    entrypoint: ["/bin/sh", "/init.sh"]
    volumes: ["./infra/minio/init.sh:/init.sh:ro"]
    environment:
      MINIO_ENDPOINT: ${MINIO_ENDPOINT}
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
      MINIO_BUCKET: ${MINIO_BUCKET}
    restart: "no"
```

**Step 8.3 — Commit:** `infra: minio bucket bootstrap one-shot job`

---

## Task 9: Tag

```bash
git tag -a v0.3.0-assets -m "Plan 03 complete: asset ingestion (upload, hashing, storage, thumbs, grid)"
```

---

## Self-Review

| Spec § | Implemented |
|---|---|
| §10 video & frame handling | Tasks 1, 6 |
| §6 architecture: MinIO + worker | Tasks 2, 6, 8 |
| §17 security: 1 GiB cap + mime allowlist | Task 3 |

Out of scope (deferred): annotation creation (Plan 04), per-frame timeline UI (Plan 04), HLS streaming (Plan 08), import existing annotations (Plan 06).
