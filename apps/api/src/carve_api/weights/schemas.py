from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from carve_api.weights.models import WeightTaskKind


class WeightOut(BaseModel):
    id: str
    # v3.5 Phase F5 — nullable. None means workspace-wide weight.
    project_id: str | None
    name: str
    task_kind: WeightTaskKind
    minio_key: str
    size_bytes: int
    class_names: list[str]
    created_by: str | None
    created_at: datetime
    # v3.5 Phase F5 — per-project default flag, computed by callers
    # against ``weight_project_defaults``. ``False`` when there's no
    # project context (e.g. workspace listing).
    is_default: bool = False
    # Plan-09b Task 5 — opaque audit blob. Populated for retrain-trained
    # weights with the trainer's metrics + hyperparameters; ``None`` for
    # uploaded weights.
    metadata: dict | None = None

    @classmethod
    def from_orm_weight(cls, w, *, is_default: bool = False) -> "WeightOut":
        return cls(
            id=str(w.id),
            project_id=str(w.project_id) if w.project_id is not None else None,
            name=w.name,
            task_kind=w.task_kind,
            minio_key=w.minio_key,
            size_bytes=w.size_bytes,
            class_names=list(w.class_names or []),
            created_by=str(w.created_by) if w.created_by else None,
            created_at=w.created_at,
            is_default=is_default,
            # The ORM attribute is ``metadata_`` (trailing underscore) to
            # avoid clashing with SQLAlchemy's reserved ``Base.metadata``;
            # we expose it as ``metadata`` on the response.
            metadata=getattr(w, "metadata_", None),
        )


class WeightIn(BaseModel):
    """Plan-09b Task 5 — request shape for client-driven weight registration.

    ``metadata`` is intentionally **not** part of the writable surface; it
    is server-derived (today, only the retrain pipeline populates it).
    ``extra="forbid"`` enforces the rejection so a client passing
    ``metadata`` gets a 422 instead of having the value silently dropped.
    """

    model_config = ConfigDict(extra="forbid")

    name: str
    task_kind: WeightTaskKind
    class_names: list[str] = []


class WeightAssignmentOut(BaseModel):
    """v3.7 Phase 3 Issue 4 — one row of the weight ↔ project membership join.

    ``project_name`` is denormalized into the response so the UI can
    render the assigned-projects chip list without a follow-up call.
    """

    weight_id: UUID
    project_id: UUID
    project_name: str
    created_at: datetime


class WeightAssignmentCreate(BaseModel):
    """Body of ``POST /weights/{weight_id}/assignments`` — assign the
    weight to one project. Idempotent: re-posting an existing
    (weight, project) pair returns the existing row.
    """

    project_id: UUID
