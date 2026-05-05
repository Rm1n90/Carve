# Armin Mehri — mehri.armin@gmail.com
import re
import uuid
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from carve_api.projects.models import TaskKind

# Plan-13 Phase 7 Task 1 -- canonical role tuple + literal type. Mirrors
# the CHECK constraint on ``project_members.role``. Keep these two
# definitions in sync if a new role is ever added.
PROJECT_MEMBER_ROLES: tuple[str, ...] = ("owner", "admin", "member", "viewer")
ProjectMemberRoleLiteral = Literal["owner", "admin", "member", "viewer"]


class ProjectMemberInIn(BaseModel):
    """One member entry on the create-project payload."""

    user_id: UUID
    role: ProjectMemberRoleLiteral


class ProjectMemberRow(BaseModel):
    """Read-side row for project membership listings.

    ``user_id`` is serialised as a plain string for symmetry with the
    rest of the project read schemas (see ``ProjectOut.owner_id``).
    """

    user_id: str
    email: str
    role: ProjectMemberRoleLiteral
    added_at: datetime

    model_config = ConfigDict(from_attributes=True)

_HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    # Plan-13 Phase 7 Task 1 -- optional initial member set on the
    # create-project path only. Validated by the router (Task 2 wires up
    # access checks; this task only adds the schema field). ``None``
    # means "no extra members; only the implicit creator/owner row".
    members: list[ProjectMemberInIn] | None = None


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=4000)


class ProjectOut(BaseModel):
    id: str
    name: str
    description: str | None
    owner_id: str
    # v3.3 Issue 2 — surface the owner's email so the UI can label projects
    # with "Created by …". ``None`` when the owner row is missing or
    # soft-deleted (defensive; the FK is non-null by schema).
    owner_email: str | None
    created_at: datetime

    @classmethod
    def from_orm_project(cls, p, owner_email: str | None = None) -> "ProjectOut":
        return cls(
            id=str(p.id),
            name=p.name,
            description=p.description,
            owner_id=str(p.owner_id),
            owner_email=owner_email,
            created_at=p.created_at,
        )


class TaskIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: TaskKind
    # Plan-15 Track G — optional schedule. ISO 8601 datetime with tz.
    due_date: datetime | None = None


class TaskPatch(BaseModel):
    """PATCH body for ``/projects/{p}/tasks/{t}``.

    All fields optional. ``archived`` toggles ``archived_at``: ``True``
    sets it to now, ``False`` clears it. ``due_date`` accepts ``None``
    to clear the schedule.
    """

    name: str | None = Field(default=None, min_length=1, max_length=120)
    due_date: datetime | None = None
    archived: bool | None = None
    # Plan-21 — task completion toggle. ``True`` stamps ``completed_at``
    # + ``completed_by``; ``False`` clears both. ``None`` (default) means
    # "leave the completion state alone".
    completed: bool | None = None


class TaskOut(BaseModel):
    id: str
    project_id: str
    name: str
    kind: TaskKind
    created_at: datetime
    due_date: datetime | None = None
    archived_at: datetime | None = None
    # Plan-21 — task completion fields. Both null means in-progress.
    completed_at: datetime | None = None
    completed_by: UUID | None = None

    @classmethod
    def from_orm_task(cls, t) -> "TaskOut":
        return cls(
            id=str(t.id),
            project_id=str(t.project_id),
            name=t.name,
            kind=t.kind,
            created_at=t.created_at,
            due_date=getattr(t, "due_date", None),
            archived_at=getattr(t, "archived_at", None),
            completed_at=getattr(t, "completed_at", None),
            completed_by=getattr(t, "completed_by", None),
        )


class TaskCompletionStatus(BaseModel):
    """Plan-21 — completion-status payload for the editor's smart banner.

    ``annotated_assets`` counts assets that have at least one annotation
    in this task (frame-level dedup is intentionally skipped: an asset
    is "annotated" the moment it has any annotation row). ``percent`` is
    a 0..1 float so the UI can show progress at-a-glance.
    """

    total_assets: int
    annotated_assets: int
    percent: float


class ClassIn(BaseModel):
    idx: int = Field(ge=0, le=10000)
    name: str = Field(min_length=1, max_length=120)
    color: str
    attributes: dict = Field(default_factory=dict)
    # v3.8 Phase 3 — optional SAM 3 text concept; empty string treated
    # the same as None (class not eligible for Text-SAM).
    text_prompt: str | None = Field(default=None, max_length=200)

    @field_validator("color")
    @classmethod
    def _color_hex(cls, v: str) -> str:
        if not _HEX_COLOR.match(v):
            raise ValueError("color must be #RRGGBB")
        return v

    @field_validator("text_prompt")
    @classmethod
    def _normalize_prompt(cls, v: str | None) -> str | None:
        if v is None:
            return None
        s = v.strip()
        return s if s else None


class ClassPatch(BaseModel):
    idx: int | None = Field(default=None, ge=0, le=10000)
    name: str | None = Field(default=None, min_length=1, max_length=120)
    color: str | None = None
    attributes: dict | None = None
    # v3.8 Phase 3 — patchable text prompt. Pass empty string to clear.
    text_prompt: str | None = Field(default=None, max_length=200)

    @field_validator("color")
    @classmethod
    def _color_hex(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not _HEX_COLOR.match(v):
            raise ValueError("color must be #RRGGBB")
        return v

    @field_validator("text_prompt")
    @classmethod
    def _normalize_prompt(cls, v: str | None) -> str | None:
        if v is None:
            return None
        s = v.strip()
        return s if s else None


class ClassOut(BaseModel):
    id: str
    project_id: str
    idx: int
    name: str
    color: str
    attributes: dict
    text_prompt: str | None
    created_at: datetime

    @classmethod
    def from_orm_class(cls, c) -> "ClassOut":
        return cls(
            id=str(c.id),
            project_id=str(c.project_id),
            idx=c.idx,
            name=c.name,
            color=c.color,
            attributes=c.attributes,
            text_prompt=getattr(c, "text_prompt", None),
            created_at=c.created_at,
        )


class ImportClassesIn(BaseModel):
    source_project_id: uuid.UUID


class ImportClassesOut(BaseModel):
    imported: int
    skipped: int


class TaskClassesIn(BaseModel):
    """Body for ``PUT /projects/{p}/tasks/{t}/classes``.

    v3.1 Issue 3 (Option A: subset model). ``None`` clears any subset and
    falls back to "all project classes". An explicit empty list is a
    legal "no classes" state; a populated list is the subset.
    """

    allowed_class_ids: list[uuid.UUID] | None = None


class TaskClassesOut(BaseModel):
    """Response for ``GET /projects/{p}/tasks/{t}/classes``.

    ``classes`` is the *effective* list (filtered by the task's subset
    when one is set, otherwise the full project list). The frontend
    editor and exporter consume ``classes`` directly.
    """

    classes: list["ClassOut"]
    allowed_class_ids: list[uuid.UUID] | None


class DuplicateTaskIn(BaseModel):
    """Optional body for the task-duplicate endpoint.

    v3.1 Bug 2 — when ``name`` is provided the backend uses it verbatim
    instead of the auto-generated ``(copy)`` suffix. ``count`` is forced
    to 1 in that path because a single custom name cannot apply to
    multiple copies without conflict.

    v3.2 Issue 4 — ``allowed_class_ids`` lets the user override the new
    task's class subset at duplicate time. Semantics:
      - field omitted entirely → keep the source task's snapshot
      - explicit ``null`` → keep the source task's snapshot (same as
        omitted)
      - empty list ``[]`` → new task has zero classes
      - populated list → new task uses exactly that subset (validated
        against the source project's class ids; cross-project ids return
        422 from the router)
    """

    name: str | None = Field(default=None, min_length=1, max_length=120)
    allowed_class_ids: list[uuid.UUID] | None = Field(default=None)
