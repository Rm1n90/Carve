# Armin Mehri — mehri.armin@gmail.com
import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from carve_api.db import Base


class TaskKind(str, enum.Enum):
    image = "image"
    video = "video"


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    # v3.32 -- per-project preferred SAM variant. NULL means "use
    # workspace default (settings.sam_model)". Validated against the
    # API's allowed-variant list at the service layer; the column stays
    # permissive so the allow-list can evolve without a schema change.
    # See alembic 0035.
    default_sam_variant: Mapped[str | None] = mapped_column(
        String, nullable=True, default=None
    )


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    kind: Mapped[TaskKind] = mapped_column(Enum(TaskKind, name="task_kind"), nullable=False)
    # v3.1 Issue 3 (Option A: subset model). ``None`` means "use all
    # project classes" (the default for legacy rows). An empty list is a
    # legal-but-unusual "no classes for this task" state. Otherwise the
    # list is the subset of class ids visible/usable in this task.
    allowed_class_ids: Mapped[list[uuid.UUID] | None] = mapped_column(
        ARRAY(UUID(as_uuid=True)), nullable=True, default=None
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    # Plan-15 Track G — optional schedule + archive marker. Both
    # nullable; archived rows are hidden from the default tasks list.
    due_date: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    # Plan-21 — task completion tracking. ``completed_at`` is set when
    # the user marks the task as fully annotated; ``completed_by`` is the
    # acting user. Both clear in tandem when the task is re-opened.
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    completed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )


class Class(Base):
    __tablename__ = "classes"
    __table_args__ = (
        UniqueConstraint("project_id", "idx", name="uq_classes_project_idx"),
        UniqueConstraint("project_id", "name", name="uq_classes_project_name"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    idx: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    color: Mapped[str] = mapped_column(String(7), nullable=False)
    attributes: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # v3.8 Phase 3 — per-class SAM 3 text concept. NULL means the class
    # is not eligible for Text-SAM and the runner UI hides it. See
    # alembic 0020.
    text_prompt: Mapped[str | None] = mapped_column(
        String(200), nullable=True, default=None
    )
    # v3.31 -- self-referential parent for the IS-A hierarchy used by
    # the auto-annotate cross-class NMS resolver. NULL means the class
    # is at the top of its chain. Cycle prevention + max depth 8 are
    # enforced at the API layer (see ClassService.update). FK is
    # ON DELETE SET NULL so deleting a parent orphans its children
    # rather than cascading the delete onto the child rows.
    parent_class_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("classes.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
        default=None,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ClassKeybinding(Base):
    """Per-user, per-project digit→class shortcut binding.

    See docs/superpowers/specs/2026-05-16-class-digit-shortcuts-design.md.
    PK ``(user_id, project_id, digit)``; UNIQUE
    ``(user_id, project_id, class_id)`` enforces one digit per class.
    CASCADE on project_id and class_id keeps the table consistent.
    """

    __tablename__ = "class_keybindings"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "project_id", "class_id",
            name="uq_class_keybindings_user_project_class",
        ),
        CheckConstraint(
            "digit BETWEEN 1 AND 9",
            name="ck_class_keybindings_digit_range",
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id"),
        primary_key=True,
        nullable=False,
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
        nullable=False,
    )
    digit: Mapped[int] = mapped_column(
        SmallInteger,
        primary_key=True,
        nullable=False,
    )
    class_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("classes.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ProjectMember(Base):
    """Per-project membership with a role.

    Plan-13 Phase 7 Task 1. Composite PK ``(project_id, user_id)``;
    secondary index on ``user_id`` to support "what projects am I a
    member of?" lookups. Roles are stored as plain text guarded by a
    CHECK constraint (no PG enum) so future role additions don't
    require an ALTER TYPE migration.
    """

    __tablename__ = "project_members"
    __table_args__ = (
        CheckConstraint(
            "role IN ('owner', 'admin', 'member', 'viewer')",
            name="ck_project_members_role",
        ),
        Index("ix_project_members_user_id", "user_id"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    added_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
