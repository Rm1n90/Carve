import re
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
