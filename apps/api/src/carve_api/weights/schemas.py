from datetime import datetime

from pydantic import BaseModel

from carve_api.weights.models import WeightTaskKind


class WeightOut(BaseModel):
    id: str
    project_id: str
    name: str
    task_kind: WeightTaskKind
    minio_key: str
    size_bytes: int
    class_names: list[str]
    created_by: str | None
    created_at: datetime

    @classmethod
    def from_orm_weight(cls, w) -> "WeightOut":
        return cls(
            id=str(w.id),
            project_id=str(w.project_id),
            name=w.name,
            task_kind=w.task_kind,
            minio_key=w.minio_key,
            size_bytes=w.size_bytes,
            class_names=list(w.class_names or []),
            created_by=str(w.created_by) if w.created_by else None,
            created_at=w.created_at,
        )
