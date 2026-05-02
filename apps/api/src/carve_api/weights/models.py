# Armin Mehri — mehri.armin@gmail.com
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
    # Plan-09b Task 5 -- nullable JSONB blob; the retrain pipeline writes
    # ``{"retrain": {epochs, imgsz, include_proposed, task_id, metrics,
    # trained_at}}``; the upload path leaves it ``None``. The Python
    # attribute is ``metadata_`` (trailing underscore) to avoid clashing
    # with SQLAlchemy's reserved ``Base.metadata`` attribute; the actual
    # database column is named ``metadata``.
    metadata_: Mapped[dict | None] = mapped_column(
        "metadata", JSONB, nullable=True, default=None
    )


class WeightAssignment(Base):
    """v3.7 Phase 3 Issue 4 — explicit many-to-many weight <-> project.

    A weight can be assigned to multiple projects (and vice versa). This
    is a *membership* relation, not a default. ``WeightService.list_for_project``
    unions weights joined via this table on top of:
      * workspace-wide weights (``Weight.project_id IS NULL``)
      * legacy direct-scoped weights (``Weight.project_id == project.id``)

    Auto-annotate access checks (``inference/autoannotate.py``) treat an
    assigned weight the same as a workspace-wide one: the task's project
    is allowed to predict with it.
    """

    __tablename__ = "weight_assignments"

    weight_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("weights.id", ondelete="CASCADE"),
        primary_key=True,
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
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
