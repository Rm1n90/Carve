import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    Enum,
    ForeignKey,
    String,
    func,
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
    # v3.5 Phase F5 — nullable. ``None`` means workspace-wide (the
    # weight is visible/usable from every project); a project id scopes
    # the weight to that project (legacy behavior).
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
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


class WeightProjectDefault(Base):
    """v3.5 Phase F5 — per-project default weight per task kind.

    The ``(project_id, task_kind)`` primary key replaces the v3.3
    ``weights.is_default`` flag and lets a single workspace-wide weight
    serve as the default for many projects without changing the
    weight's own ``project_id`` (which is now ``NULL`` for workspace
    weights). The auto-annotate endpoint consults this table when the
    caller omits an explicit ``weight_id``.
    """

    __tablename__ = "weight_project_defaults"

    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    task_kind: Mapped[WeightTaskKind] = mapped_column(
        Enum(WeightTaskKind, name="weight_task_kind", create_type=False),
        primary_key=True,
    )
    weight_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("weights.id", ondelete="CASCADE"),
        nullable=False,
    )
