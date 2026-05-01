from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


# Phase 5 review workflow (plan-09 task-01). Kept as ``Literal`` rather
# than an enum so we don't churn an enum just for the status field.
AnnotationStatus = Literal["proposed", "accepted", "rejected"]

from carve_api.annotations.models import AnnotationKind


class BboxGeometry(BaseModel):
    """Bbox geometry with strict validation — rejects negative origins
    and zero/negative dimensions at the API edge.

    Audit bug L: previously the geometry was an opaque ``dict[str, Any]``
    and the service-layer ``_validate_geometry`` only checked that w/h
    were positive — negative x/y could flow through and corrupt the DB.

    Existing rows with negative coordinates remain unchanged; this only
    rejects NEW writes.
    """

    x: float = Field(ge=0)
    y: float = Field(ge=0)
    w: float = Field(gt=0)
    h: float = Field(gt=0)

    model_config = {"extra": "allow"}


class PolygonGeometry(BaseModel):
    """Polygon must have at least 3 (x, y) points; coordinates >= 0."""

    points: list[tuple[float, float]] = Field(min_length=3)

    model_config = {"extra": "allow"}

    @model_validator(mode="after")
    def _coords_non_negative(self) -> "PolygonGeometry":
        for px, py in self.points:
            if px < 0 or py < 0:
                raise ValueError("polygon points must be non-negative")
        return self


class MaskGeometry(BaseModel):
    """COCO RLE mask: ``size = [h, w]`` (both > 0) and a non-empty
    ``counts`` string."""

    counts: str = Field(min_length=1)
    size: tuple[int, int]

    model_config = {"extra": "allow"}

    @model_validator(mode="after")
    def _size_positive(self) -> "MaskGeometry":
        h, w = self.size
        if h <= 0 or w <= 0:
            raise ValueError("mask size dims must be > 0")
        return self


class TagGeometry(BaseModel):
    """Tag annotations have no geometry — empty dict (an empty
    ``{kind: "tag"}`` shim is also accepted for client convenience)."""

    model_config = {"extra": "allow"}


_GEOMETRY_VALIDATORS: dict[AnnotationKind, type[BaseModel]] = {
    AnnotationKind.bbox: BboxGeometry,
    AnnotationKind.polygon: PolygonGeometry,
    AnnotationKind.mask: MaskGeometry,
    AnnotationKind.tag: TagGeometry,
}


def _validate_geometry_for_kind(kind: AnnotationKind, g: dict[str, Any]) -> None:
    """Run the per-kind Pydantic validator on a raw geometry dict.

    Raises ``ValueError`` (which Pydantic surfaces as a 422) when the dict
    doesn't match the kind's schema.
    """

    validator = _GEOMETRY_VALIDATORS.get(kind)
    if validator is None:
        # Unknown kinds shouldn't reach here — the AnnotationKind enum
        # already constrains the input. Defensive no-op.
        return
    # ``model_validate`` raises a Pydantic ``ValidationError``.
    validator.model_validate(g)


class AnnotationIn(BaseModel):
    # ``extra="forbid"`` ensures inbound writes cannot smuggle review-
    # workflow fields (``status``, ``reviewed_by_id``, ``reviewed_at``,
    # ``prev_geometry``) through the create/batch-create paths. Those
    # fields are only mutated by the dedicated review endpoint.
    model_config = {"extra": "forbid"}

    frame_id: str | None = None
    class_id: str
    kind: AnnotationKind
    geometry: dict[str, Any]
    track_id: str | None = None
    z_order: int | None = None
    # Optional client-supplied identifier echoed back in batch responses
    # so the client can correlate created rows to its draft state without
    # relying on iteration order. Audit bug M.
    temp_id: str | None = None

    @model_validator(mode="after")
    def _validate_geometry_shape(self) -> "AnnotationIn":
        _validate_geometry_for_kind(self.kind, self.geometry)
        return self


class AnnotationPatch(BaseModel):
    geometry: dict[str, Any] | None = None
    class_id: str | None = None
    track_id: str | None = None
    z_order: int | None = None
    # ``kind`` is unknown at patch time (the original kind is on the
    # database row), so geometry shape validation has to happen in the
    # service layer where the row is loaded. We DO still apply the
    # generic legacy ``_validate_geometry`` call there.


class AnnotationOut(BaseModel):
    id: str
    task_id: str
    frame_id: str | None
    class_id: str
    kind: AnnotationKind
    geometry: dict
    track_id: str | None
    z_order: int = 0
    created_by: str | None
    created_at: datetime
    updated_at: datetime
    # Phase 5 review-workflow fields (plan-09 task-01).
    status: AnnotationStatus = "proposed"
    reviewed_by_id: str | None = None
    reviewed_at: datetime | None = None
    prev_geometry: dict | None = None

    @classmethod
    def from_orm_annotation(cls, a):
        return cls(
            id=str(a.id), task_id=str(a.task_id),
            frame_id=str(a.frame_id) if a.frame_id else None,
            class_id=str(a.class_id), kind=a.kind, geometry=a.geometry,
            track_id=str(a.track_id) if a.track_id else None,
            z_order=int(getattr(a, "z_order", 0) or 0),
            created_by=str(a.created_by) if a.created_by else None,
            created_at=a.created_at, updated_at=a.updated_at,
            status=getattr(a, "status", "proposed"),
            reviewed_by_id=(
                str(a.reviewed_by_id)
                if getattr(a, "reviewed_by_id", None) is not None
                else None
            ),
            reviewed_at=getattr(a, "reviewed_at", None),
            prev_geometry=getattr(a, "prev_geometry", None),
        )


class BatchUpdate(BaseModel):
    id: str
    geometry: dict[str, Any] | None = None
    class_id: str | None = None
    track_id: str | None = None
    z_order: int | None = None


class BatchIn(BaseModel):
    create: list[AnnotationIn] = Field(default_factory=list)
    update: list[BatchUpdate] = Field(default_factory=list)
    delete: list[str] = Field(default_factory=list)


class BatchOut(BaseModel):
    created: list[AnnotationOut]
    updated: list[AnnotationOut]
    deleted: list[str]
    # Parallel to ``created`` — entry ``i`` holds the temp_id the client
    # supplied for ``created[i]`` (or None if not supplied). Lets the
    # client correlate server IDs back to its draft state without
    # depending on iteration order. Audit bug M.
    created_temp_ids: list[str | None] = Field(default_factory=list)
