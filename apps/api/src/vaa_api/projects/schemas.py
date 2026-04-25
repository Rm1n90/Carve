from datetime import datetime

from pydantic import BaseModel, Field

from vaa_api.projects.models import TaskKind


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
