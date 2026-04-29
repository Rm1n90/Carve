import re
import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from carve_api.projects.models import TaskKind

_HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=4000)


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=4000)


class ProjectOut(BaseModel):
    id: str
    name: str
    description: str | None
    owner_id: str
    created_at: datetime

    @classmethod
    def from_orm_project(cls, p) -> "ProjectOut":
        return cls(
            id=str(p.id),
            name=p.name,
            description=p.description,
            owner_id=str(p.owner_id),
            created_at=p.created_at,
        )


class TaskIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: TaskKind


class TaskOut(BaseModel):
    id: str
    project_id: str
    name: str
    kind: TaskKind
    created_at: datetime

    @classmethod
    def from_orm_task(cls, t) -> "TaskOut":
        return cls(
            id=str(t.id),
            project_id=str(t.project_id),
            name=t.name,
            kind=t.kind,
            created_at=t.created_at,
        )


class ClassIn(BaseModel):
    idx: int = Field(ge=0, le=10000)
    name: str = Field(min_length=1, max_length=120)
    color: str
    attributes: dict = Field(default_factory=dict)

    @field_validator("color")
    @classmethod
    def _color_hex(cls, v: str) -> str:
        if not _HEX_COLOR.match(v):
            raise ValueError("color must be #RRGGBB")
        return v


class ClassPatch(BaseModel):
    idx: int | None = Field(default=None, ge=0, le=10000)
    name: str | None = Field(default=None, min_length=1, max_length=120)
    color: str | None = None
    attributes: dict | None = None

    @field_validator("color")
    @classmethod
    def _color_hex(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not _HEX_COLOR.match(v):
            raise ValueError("color must be #RRGGBB")
        return v


class ClassOut(BaseModel):
    id: str
    project_id: str
    idx: int
    name: str
    color: str
    attributes: dict
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
