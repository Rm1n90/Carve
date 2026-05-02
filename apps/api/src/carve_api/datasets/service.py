"""Service helpers for ``DatasetVersion`` (Plan-13 Phase 7 Task 6).

Stateless static methods so callers (retrain job, export job, router,
tests) can register / list / lookup dataset version rows without
threading an instance through.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.datasets.models import DATASET_KINDS, DatasetVersion


class DatasetService:
    """Thin DAO around :class:`DatasetVersion`. All methods are static."""

    @staticmethod
    def register(
        db: Session,
        *,
        project_id: uuid.UUID,
        task_id: uuid.UUID,
        kind: str,
        source: str | None,
        created_by: uuid.UUID | None,
        label: str,
        summary: dict | None,
        blob_key: str | None,
    ) -> DatasetVersion:
        """Insert a new ``DatasetVersion`` row.

        Caller is responsible for committing; we ``flush`` so callers can
        read back the assigned id immediately.
        """
        if kind not in DATASET_KINDS:
            raise ValueError(
                f"invalid dataset version kind: {kind!r} "
                f"(allowed: {DATASET_KINDS})"
            )
        row = DatasetVersion(
            project_id=project_id,
            task_id=task_id,
            kind=kind,
            source=source,
            created_by=created_by,
            label=label,
            metadata_summary=summary,
            blob_key=blob_key,
        )
        db.add(row)
        db.flush()
        return row

    @staticmethod
    def list_for_project(
        db: Session,
        project_id: uuid.UUID,
        *,
        kind: str | None = None,
        task_id: uuid.UUID | None = None,
        before: datetime | None = None,
        limit: int = 50,
    ) -> list[DatasetVersion]:
        stmt = select(DatasetVersion).where(
            DatasetVersion.project_id == project_id
        )
        if kind is not None:
            stmt = stmt.where(DatasetVersion.kind == kind)
        if task_id is not None:
            stmt = stmt.where(DatasetVersion.task_id == task_id)
        if before is not None:
            stmt = stmt.where(DatasetVersion.created_at < before)
        stmt = stmt.order_by(
            DatasetVersion.created_at.desc(), DatasetVersion.id.desc()
        ).limit(max(1, min(limit, 200)))
        return list(db.execute(stmt).scalars())

    @staticmethod
    def get(
        db: Session, version_id: uuid.UUID
    ) -> DatasetVersion | None:
        return db.get(DatasetVersion, version_id)
