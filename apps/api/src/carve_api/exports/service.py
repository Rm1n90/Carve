"""DB helpers for the Export row."""

import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from carve_api.errors import AppError
from carve_api.exports.models import Export


class ExportNotFound(AppError):
    http_status = 404
    code = "export_not_found"


class ExportService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def create(
        self,
        *,
        task_id: uuid.UUID,
        actor_id: uuid.UUID,
        fmt: str,
        class_remap: dict,
    ) -> Export:
        e = Export(
            task_id=task_id,
            format=fmt,
            class_remap=class_remap,
            status="pending",
            created_by=actor_id,
        )
        self.session.add(e)
        self.session.flush()
        return e

    def get(self, *, export_id: uuid.UUID) -> Export:
        e = self.session.get(Export, export_id)
        if e is None:
            raise ExportNotFound("export not found")
        return e

    def mark_completed(self, *, export_id: uuid.UUID, minio_key: str) -> Export:
        e = self.get(export_id=export_id)
        e.status = "completed"
        e.minio_key = minio_key
        e.completed_at = datetime.now(UTC)
        self.session.flush()
        return e

    def mark_failed(self, *, export_id: uuid.UUID, error: str) -> Export:
        e = self.get(export_id=export_id)
        e.status = "failed"
        e.error = error
        e.completed_at = datetime.now(UTC)
        self.session.flush()
        return e
