# Armin Mehri — mehri.armin@gmail.com
import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger, DateTime, Enum, ForeignKey, Integer, String, UniqueConstraint, func
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from carve_api.db import Base


class AssetKind(str, enum.Enum):
    image = "image"
    video = "video"


class Asset(Base):
    __tablename__ = "assets"
    # Dedup is by (task_id, original_name) enforced in AssetService.upload_stream
    # — NOT by content hash. Identical bytes under different filenames are
    # allowed (multiple assets may share one content-addressed blob; deletion
    # ref-counts the hash). The old UniqueConstraint("task_id", "xxh3_128") was
    # dropped in alembic 0037.

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
    thumbnail_minio_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
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
