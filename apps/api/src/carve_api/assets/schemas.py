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

    @classmethod
    def from_orm_asset(cls, a, thumbnail_url: str | None = None):
        return cls(
            id=str(a.id), task_id=str(a.task_id), kind=a.kind, xxh3_128=a.xxh3_128,
            mime=a.mime, size_bytes=a.size_bytes, width=a.width, height=a.height,
            frames=a.frames, original_name=a.original_name, created_at=a.created_at,
            thumbnail_url=thumbnail_url,
        )


class AssetCount(BaseModel):
    total: int
    annotated: int
    unannotated: int


class AssetListPage(BaseModel):
    items: list[AssetOut]
    total: int
    limit: int
    offset: int
