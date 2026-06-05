# Armin Mehri — mehri.armin@gmail.com
import uuid
import zipfile
from io import BytesIO
from typing import BinaryIO, Literal

from PIL import Image
from sqlalchemy import distinct, exists, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.config import get_settings
from carve_api.errors import AppError
from carve_api.projects.models import Task, TaskKind
from carve_api.storage.client import MinioClient
from carve_api.storage.hashing import stream_xxh3_128

AssetStatusFilter = Literal["all", "annotated", "unannotated"]

_IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp"}
_VIDEO_MIMES = {"video/mp4", "video/webm", "video/quicktime"}


def _max_upload_bytes() -> int:
    """Configurable single-asset upload ceiling (default 50 GiB).

    The upload path streams to object storage in bounded-memory chunks and
    uses S3 multipart, so this limit is a disk/time budget, not API RAM. Raise
    ``ASSET_MAX_BYTES`` to accept larger source videos. Patched in tests to a
    small value to exercise the 413 path without a multi-GB fixture.
    """
    return get_settings().asset_max_bytes


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
        """Bytes entry point (zip members, tests). Wraps the streaming path so
        there is a single implementation of hash/dedup/store."""
        return self.upload_stream(
            task=task,
            original_name=original_name,
            mime=mime,
            stream=BytesIO(body),
            size=len(body),
        )

    def upload_stream(
        self,
        *,
        task: Task,
        original_name: str,
        mime: str,
        stream: BinaryIO,
        size: int,
    ) -> Asset:
        """Store an upload by streaming ``stream`` (a seekable file object,
        typically the temp file Starlette already spooled the request body
        into) — never materialising the whole asset in memory.

        ``size`` is the known content length; it gates the 413 ceiling before
        any bytes are read. The hash pass and the storage upload each read the
        stream in chunks, so a 50 GB video costs ~one chunk of RAM, not 50 GB.
        """
        if size > _max_upload_bytes():
            raise AssetTooLarge(f"upload exceeds {_max_upload_bytes()} bytes")
        kind = self._kind_for(mime, task.kind)
        stream.seek(0)
        h = stream_xxh3_128(stream)
        width = height = None
        frames = 1
        if kind == AssetKind.image:
            stream.seek(0)
            with Image.open(stream) as im:
                width, height = im.size
        else:
            frames = 0  # populated by the video metadata/extract worker
        try:
            asset = Asset(
                task_id=task.id, kind=kind, xxh3_128=h, mime=mime,
                size_bytes=size, width=width, height=height,
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
        stream.seek(0)
        self.storage.put_object(key, stream, size, mime)

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
        class_id: uuid.UUID | None = None,
        annotation_status: str | None = None,
        min_size: int | None = None,
        max_size: int | None = None,
    ) -> list[Asset]:
        stmt = self._task_assets_query(
            task=task,
            q=q,
            status=status,
            class_id=class_id,
            annotation_status=annotation_status,
            min_size=min_size,
            max_size=max_size,
        ).order_by(Asset.created_at)
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
        class_id: uuid.UUID | None = None,
        annotation_status: str | None = None,
        min_size: int | None = None,
        max_size: int | None = None,
    ) -> int:
        """Total number of assets matching the same filters as ``list_for_task``."""
        sub = self._task_assets_query(
            task=task,
            q=q,
            status=status,
            class_id=class_id,
            annotation_status=annotation_status,
            min_size=min_size,
            max_size=max_size,
        ).subquery()
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

    def tag_class_ids_for(
        self, asset_ids: list[uuid.UUID]
    ) -> dict[str, list[str]]:
        """Plan-18 — return ``{asset_id: [class_id, …]}`` for tag annotations
        across the given asset ids in a single query.

        The grid uses this to render small color dots per tile so the user
        can tell at a glance which images are classified as what. Class
        ids are deduplicated per asset.
        """
        if not asset_ids:
            return {}
        from carve_api.annotations.models import AnnotationKind
        rows = self.session.execute(
            select(Frame.asset_id, Annotation.class_id)
            .join(Annotation, Annotation.frame_id == Frame.id)
            .where(
                Frame.asset_id.in_(asset_ids),
                Annotation.kind == AnnotationKind.tag,
            )
        ).all()
        out: dict[str, list[str]] = {}
        seen: dict[str, set[str]] = {}
        for asset_id, class_id in rows:
            sid = str(asset_id)
            cid = str(class_id)
            seen_set = seen.setdefault(sid, set())
            if cid in seen_set:
                continue
            seen_set.add(cid)
            out.setdefault(sid, []).append(cid)
        return out

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

    def thumbnail_url_for(self, asset: Asset, *, expires_seconds: int = 14400) -> str | None:
        """Presigned URL for the cached 200x200 JPEG thumbnail.

        Returns ``None`` when no thumbnail has been generated yet so the
        UI can render a skeleton or fall back to a placeholder. Image
        assets fall back to the original (still useful but heavier) when
        the thumbnail key is unset; video assets return ``None`` since
        the original video bytes aren't a usable preview.

        v3.33 — default TTL is 4 hours. The editor's thumbnail strip
        caches one presigned URL per asset for the whole annotation
        session. The previous 10 minute default meant every thumbnail
        simultaneously turned into a broken-image icon ten minutes into
        the session, with no recovery path on the client. The web
        client also proactively refetches the strip query every hour so
        URLs stay fresh well within the new window.
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
        self,
        *,
        task: Task,
        q: str | None,
        status: AssetStatusFilter,
        class_id: uuid.UUID | None = None,
        annotation_status: str | None = None,
        min_size: int | None = None,
        max_size: int | None = None,
    ):
        stmt = select(Asset).where(Asset.task_id == task.id)
        if q:
            stmt = stmt.where(Asset.original_name.ilike(f"%{q}%"))
        if min_size is not None:
            stmt = stmt.where(Asset.size_bytes >= min_size)
        if max_size is not None:
            stmt = stmt.where(Asset.size_bytes <= max_size)
        if status != "all":
            ann_exists = exists().where(
                Annotation.frame_id == Frame.id, Frame.asset_id == Asset.id
            )
            if status == "annotated":
                stmt = stmt.where(ann_exists)
            else:  # "unannotated"
                stmt = stmt.where(~ann_exists)
        if class_id is not None or annotation_status is not None:
            ann_q = (
                select(Annotation.id)
                .join(Frame, Frame.id == Annotation.frame_id)
                .where(Frame.asset_id == Asset.id)
            )
            if class_id is not None:
                ann_q = ann_q.where(Annotation.class_id == class_id)
            if annotation_status is not None:
                ann_q = ann_q.where(Annotation.status == annotation_status)
            stmt = stmt.where(ann_q.exists())
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
        """Bytes entry point for zip upload (tests). Wraps the streaming path."""
        return self.upload_archive_stream(task=task, archive_stream=BytesIO(archive_bytes))

    def upload_archive_stream(self, *, task: Task, archive_stream: BinaryIO) -> list[Asset]:
        """Extract image members from a zip read straight off ``archive_stream``.

        ``zipfile`` reads the central directory by seeking and decompresses one
        member at a time, so the whole archive is never held in memory — only
        the current member is. Each member still streams to storage via
        ``upload``/``upload_stream``.
        """
        out: list[Asset] = []
        mime_for_ext = {
            "png": "image/png",
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "webp": "image/webp",
        }
        archive_stream.seek(0)
        try:
            zf = zipfile.ZipFile(archive_stream)
        except zipfile.BadZipFile as exc:
            raise AssetArchiveInvalid("file is not a valid zip archive") from exc
        with zf:
            for member in zf.infolist():
                if member.is_dir():
                    continue
                # Reject oversized members before decompressing (zip-bomb
                # mitigation). file_size is the central-directory uncompressed
                # size, checked against the same configurable ceiling.
                if member.file_size > _max_upload_bytes():
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
        # v3.32 — image tasks now accept video uploads. The mixed-upload
        # flow in the frontend ``AssetUploadDialog`` calls the new
        # ``/video-extract/batch`` endpoint after each video is uploaded;
        # that worker extracts frames into image-kind assets and deletes
        # the source video. A video uploaded to an image task without
        # that follow-up is harmless — it just sits as an orphan video
        # asset until the user re-triggers extraction or deletes it.
        if task_kind == TaskKind.video and kind != AssetKind.video:
            raise AssetMismatchTask("video task accepts videos only")
        return kind
