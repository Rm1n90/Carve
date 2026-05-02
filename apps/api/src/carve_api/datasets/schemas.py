"""Pydantic schemas for the dataset versioning HTTP API (Task 6)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


DatasetKind = Literal[
    "retrain", "export", "manual", "rollback_pre", "rollback_post"
]


class DatasetVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    task_id: uuid.UUID
    kind: str
    source: str | None = None
    created_by: uuid.UUID | None = None
    created_at: datetime
    label: str
    frozen: bool
    summary: dict[str, Any] | None = Field(default=None)
    blob_key: str | None = None

    @classmethod
    def from_orm_row(cls, row: Any) -> "DatasetVersionOut":
        return cls(
            id=row.id,
            project_id=row.project_id,
            task_id=row.task_id,
            kind=row.kind,
            source=row.source,
            created_by=row.created_by,
            created_at=row.created_at,
            label=row.label,
            frozen=bool(row.frozen),
            summary=row.metadata_summary,
            blob_key=row.blob_key,
        )


class DatasetVersionDetailOut(DatasetVersionOut):
    download_url: str | None = None


class DatasetDiffByImage(BaseModel):
    image: str
    added: int
    removed: int
    changed: int


class DatasetDiffOut(BaseModel):
    a_id: uuid.UUID
    b_id: uuid.UUID
    added: dict[str, int]
    removed: dict[str, int]
    changed: dict[str, int]
    by_image: list[DatasetDiffByImage]
    summary_a: dict[str, Any]
    summary_b: dict[str, Any]
    note: str | None = None


class RollbackIn(BaseModel):
    task_id: uuid.UUID


class RollbackOut(BaseModel):
    pre_version_id: uuid.UUID
    post_version_id: uuid.UUID
    replaced_count: int
    restored_count: int
