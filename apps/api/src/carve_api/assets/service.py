import zipfile
from io import BytesIO
from typing import Literal

from PIL import Image
from sqlalchemy import distinct, exists, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.errors import AppError
from carve_api.projects.models import Task, TaskKind
from carve_api.storage.client import MinioClient
from carve_api.storage.hashing import stream_xxh3_128

AssetStatusFilter = Literal["all", "annotated", "unannotated"]

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


class AssetArchiveInvalid(AppError):
    http_status = 400; code = "asset_archive_invalid"


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

    def list_for_task(
        self,
        *,
        task: Task,
        limit: int | None = None,
        offset: int = 0,
        q: str | None = None,
        status: AssetStatusFilter = "all",
    ) -> list[Asset]:
        stmt = self._task_assets_query(task=task, q=q, status=status).order_by(Asset.created_at)
        if offset:
            stmt = stmt.offset(offset)
        if limit is not None:
            stmt = stmt.limit(limit)
        return list(self.session.execute(stmt).scalars())

    def count_for_task(
        self,
        *,
        task: Task,
        q: str | None = None,
        status: AssetStatusFilter = "all",
    ) -> int:
        """Total number of assets matching the same filters as ``list_for_task``."""
        sub = self._task_assets_query(task=task, q=q, status=status).subquery()
        return int(self.session.execute(select(func.count()).select_from(sub)).scalar() or 0)

    def annotated_count_for_task(self, *, task: Task) -> int:
        """Number of assets in ``task`` that have at least one annotation row.

        Uses a single SQL query (DISTINCT asset id via the frames join) so
        it stays cheap even with 10K+ assets.
        """
        stmt = (
            select(func.count(distinct(Asset.id)))
            .select_from(Asset)
            .join(Frame, Frame.asset_id == Asset.id)
            .join(Annotation, Annotation.frame_id == Frame.id)
            .where(Asset.task_id == task.id)
        )
        return int(self.session.execute(stmt).scalar() or 0)

    def primary_frame_id_for(self, asset: Asset) -> str | None:
        """Return the asset's single Frame.id for image assets, else None.

        v2.5.1 fix — image assets get exactly one ``Frame`` row at upload
        time (see ``upload`` above). The editor needs that frame's id to
        scope annotations per asset; without it every annotation saves
        with ``frame_id=null`` and the per-task annotations query returns
        ALL annotations regardless of which asset is on screen.

        Video assets have many frames addressed via the dedicated frames
        endpoint, so we return ``None`` here.
        """
        if asset.kind != AssetKind.image:
            return None
        frame_id = self.session.execute(
            select(Frame.id).where(Frame.asset_id == asset.id).limit(1)
        ).scalar_one_or_none()
        return str(frame_id) if frame_id is not None else None

    def thumbnail_url_for(self, asset: Asset, *, expires_seconds: int = 600) -> str | None:
        """Presigned URL for the cached 200x200 JPEG thumbnail.

        Returns ``None`` when no thumbnail has been generated yet so the
        UI can render a skeleton or fall back to a placeholder. Image
        assets fall back to the original (still useful but heavier) when
        the thumbnail key is unset; video assets return ``None`` since
        the original video bytes aren't a usable preview.
        """
        if asset.thumbnail_minio_key:
            return self.storage.presigned_get(
                asset.thumbnail_minio_key, expires_seconds=expires_seconds
            )
        if asset.kind == AssetKind.image:
            ext = asset.original_name.rsplit(".", 1)[-1] if "." in asset.original_name else "bin"
            return self.storage.presigned_get(
                f"assets/{asset.xxh3_128}/original.{ext}", expires_seconds=expires_seconds
            )
        return None

    def _task_assets_query(
        self, *, task: Task, q: str | None, status: AssetStatusFilter
    ):
        stmt = select(Asset).where(Asset.task_id == task.id)
        if q:
            stmt = stmt.where(Asset.original_name.ilike(f"%{q}%"))
        if status != "all":
            ann_exists = exists().where(
                Annotation.frame_id == Frame.id, Frame.asset_id == Asset.id
            )
            if status == "annotated":
                stmt = stmt.where(ann_exists)
            else:  # "unannotated"
                stmt = stmt.where(~ann_exists)
        return stmt

    def delete(self, *, asset: Asset) -> None:
        ext = asset.original_name.rsplit(".", 1)[-1] if "." in asset.original_name else "bin"
        try:
            self.storage.remove_object(f"assets/{asset.xxh3_128}/original.{ext}")
        except Exception:
            pass
        self.session.delete(asset)
        self.session.flush()

    def upload_archive(self, *, task: Task, archive_bytes: bytes) -> list[Asset]:
        if len(archive_bytes) > _MAX_BYTES:
            raise AssetTooLarge("archive exceeds 1 GiB")
        out: list[Asset] = []
        mime_for_ext = {
            "png": "image/png",
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "webp": "image/webp",
        }
        try:
            zf = zipfile.ZipFile(BytesIO(archive_bytes))
        except zipfile.BadZipFile as exc:
            raise AssetArchiveInvalid("file is not a valid zip archive") from exc
        with zf:
            for member in zf.infolist():
                if member.is_dir():
                    continue
                # Reject obviously oversized members before decompressing into memory
                # (zip-bomb mitigation). file_size is the central-directory uncompressed size.
                if member.file_size > _MAX_BYTES:
                    continue
                ext = member.filename.lower().rsplit(".", 1)[-1] if "." in member.filename else ""
                mime = mime_for_ext.get(ext)
                if mime is None:
                    continue
                data = zf.read(member)
                try:
                    out.append(self.upload(task=task, original_name=member.filename, mime=mime, body=data))
                except AssetDuplicate:
                    continue  # silently skip duplicates inside an archive
        return out

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
