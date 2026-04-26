import uuid

from sqlalchemy.orm import Session

from vaa_api.stats.sql import (
    ANNOTATION_DENSITY_SQL,
    CLASS_FREQUENCY_SQL,
    TASK_PROGRESS_SQL,
)


class StatsService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def class_frequency(self, *, project_id: uuid.UUID, task_id: uuid.UUID) -> list[dict]:
        rows = self.session.execute(
            CLASS_FREQUENCY_SQL, {"project_id": project_id, "task_id": task_id}
        ).all()
        return [dict(r._mapping) for r in rows]

    def annotation_density(self, *, task_id: uuid.UUID) -> list[dict]:
        rows = self.session.execute(
            ANNOTATION_DENSITY_SQL, {"task_id": task_id}
        ).all()
        return [dict(r._mapping) for r in rows]

    def task_progress(self, *, task_id: uuid.UUID) -> dict:
        row = self.session.execute(TASK_PROGRESS_SQL, {"task_id": task_id}).one()
        m = row._mapping
        total = m["total_frames"] or 0
        labeled = m["labeled_frames"] or 0
        return {
            "total_frames": total,
            "labeled_frames": labeled,
            "progress_pct": (labeled / total) if total else 0.0,
        }
