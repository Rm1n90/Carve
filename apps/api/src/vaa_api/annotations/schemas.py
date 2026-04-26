from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from vaa_api.annotations.models import AnnotationKind


class AnnotationIn(BaseModel):
    frame_id: str | None = None
    class_id: str
    kind: AnnotationKind
    geometry: dict[str, Any]
    track_id: str | None = None


class AnnotationPatch(BaseModel):
    geometry: dict[str, Any] | None = None
    class_id: str | None = None
    track_id: str | None = None


class AnnotationOut(BaseModel):
    id: str
    task_id: str
    frame_id: str | None
    class_id: str
    kind: AnnotationKind
    geometry: dict
    track_id: str | None
    created_by: str | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_orm_annotation(cls, a):
        return cls(
            id=str(a.id), task_id=str(a.task_id),
            frame_id=str(a.frame_id) if a.frame_id else None,
            class_id=str(a.class_id), kind=a.kind, geometry=a.geometry,
            track_id=str(a.track_id) if a.track_id else None,
            created_by=str(a.created_by) if a.created_by else None,
            created_at=a.created_at, updated_at=a.updated_at,
        )


class BatchUpdate(BaseModel):
    id: str
    geometry: dict[str, Any] | None = None
    class_id: str | None = None
    track_id: str | None = None


class BatchIn(BaseModel):
    create: list[AnnotationIn] = Field(default_factory=list)
    update: list[BatchUpdate] = Field(default_factory=list)
    delete: list[str] = Field(default_factory=list)


class BatchOut(BaseModel):
    created: list[AnnotationOut]
    updated: list[AnnotationOut]
    deleted: list[str]
