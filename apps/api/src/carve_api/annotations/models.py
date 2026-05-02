# Armin Mehri — mehri.armin@gmail.com
import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from carve_api.db import Base


class AnnotationKind(str, enum.Enum):
    bbox = "bbox"
    polygon = "polygon"
    mask = "mask"
    tag = "tag"


class Annotation(Base):
    __tablename__ = "annotations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    frame_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("frames.id", ondelete="CASCADE"), nullable=True, index=True
    )
    class_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("classes.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    kind: Mapped[AnnotationKind] = mapped_column(Enum(AnnotationKind, name="annotation_kind"), nullable=False)
    geometry: Mapped[dict] = mapped_column(JSONB, nullable=False)
    track_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    z_order: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0", default=0, index=True
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    # Phase 5 review workflow (plan-09 task-01).
    # ``status`` is one of {"proposed", "accepted", "rejected"} — using a
    # plain string + Literal at the schema layer rather than a DB enum so
    # we don't churn an enum type for a small finite set.
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="proposed", default="proposed"
    )
    reviewed_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Snapshot of the geometry the last reviewer saw — used to detect
    # post-review edits and reset status back to ``proposed``.
    prev_geometry: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    __table_args__ = (
        Index("ix_annotations_task_id_status", "task_id", "status"),
    )
