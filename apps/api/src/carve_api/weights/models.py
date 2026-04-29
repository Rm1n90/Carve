import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from carve_api.db import Base


class WeightTaskKind(str, enum.Enum):
    detect = "detect"
    segment = "segment"
    classify = "classify"
    pose = "pose"


class Weight(Base):
    __tablename__ = "weights"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    task_kind: Mapped[WeightTaskKind] = mapped_column(
        Enum(WeightTaskKind, name="weight_task_kind"), nullable=False
    )
    minio_key: Mapped[str] = mapped_column(String(255), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    class_names: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # v3.3 Issue 4 — at most one default per (project_id, task_kind), enforced
    # at the DB layer via a partial unique index (see 0015 migration). The
    # auto-annotate endpoint falls back to this when no explicit weight_id is
    # supplied, and the editor predict popover pre-selects it on open.
    is_default: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )


class WeightClassMapping(Base):
    """Explicit mapping between a YOLO weight's classes and project classes.

    v3.3 Issue 3c — auto-populated by name-match on weight upload, can be
    manually overridden via the weight detail panel, and consulted by the
    auto-annotate pipeline before falling back to the legacy name match.
    """

    __tablename__ = "weight_class_mappings"
    __table_args__ = (
        UniqueConstraint(
            "weight_id", "weight_class_idx", name="uq_weight_class_mappings_weight_idx"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    weight_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("weights.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    weight_class_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    weight_class_name: Mapped[str] = mapped_column(String(255), nullable=False)
    project_class_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("classes.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
