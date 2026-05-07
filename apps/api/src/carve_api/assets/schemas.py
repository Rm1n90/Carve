# Armin Mehri — mehri.armin@gmail.com
from datetime import datetime
from pydantic import BaseModel
from carve_api.assets.models import AssetKind


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
    thumbnail_url: str | None = None
    # Plan-18 — class ids of tag annotations on this asset. Empty when
    # none. The grid renders these as small color dots on each thumbnail
    # so the user can see how each image is classified without opening
    # the editor.
    tag_class_ids: list[str] = []
    # v3.26 — true when the client should kick POST /frames/extract before
    # the editor can open this asset. Always false for images and for
    # videos that already have frames extracted.
    extract_required: bool = False

    @classmethod
    def from_orm_asset(
        cls,
        a,
        thumbnail_url: str | None = None,
        tag_class_ids: list[str] | None = None,
    ):
        return cls(
            id=str(a.id), task_id=str(a.task_id), kind=a.kind, xxh3_128=a.xxh3_128,
            mime=a.mime, size_bytes=a.size_bytes, width=a.width, height=a.height,
            frames=a.frames, original_name=a.original_name, created_at=a.created_at,
            thumbnail_url=thumbnail_url,
            tag_class_ids=tag_class_ids or [],
            extract_required=(a.kind == AssetKind.video and (a.frames or 0) == 0),
        )


class AssetWithUrl(BaseModel):
    """Single-asset GET response: the asset row + a presigned URL to fetch
    the original bytes + the asset's primary frame_id.

    For image assets the frame_id is the (single) Frame row created at
    upload time. The editor uses it to scope annotations PER ASSET; without
    it every annotation saves with frame_id=null and the per-task
    annotations query returns ALL annotations regardless of which asset
    you are viewing — fix v2.5.1.

    For video assets frame_id is null (use the dedicated frames endpoint
    to enumerate per-frame ids).
    """

    asset: AssetOut
    url: str
    frame_id: str | None = None


class AssetCount(BaseModel):
    total: int
    annotated: int
    unannotated: int


class AssetListPage(BaseModel):
    items: list[AssetOut]
    total: int
    limit: int
    offset: int
