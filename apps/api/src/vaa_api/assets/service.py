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
            pass
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
