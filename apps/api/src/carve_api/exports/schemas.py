# Armin Mehri — mehri.armin@gmail.com
"""Pydantic schemas for the export API."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class ExportSplits(BaseModel):
    train: float = Field(default=0.8, ge=0.0, le=1.0)
    val: float = Field(default=0.1, ge=0.0, le=1.0)
    test: float = Field(default=0.1, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _splits_sum_to_one(self) -> "ExportSplits":
        total = self.train + self.val + self.test
        if abs(total - 1.0) >= 1e-6:
            raise ValueError(
                f"splits must sum to 1.0 (got {total:.6f})",
            )
        return self


class ExportIn(BaseModel):
    format: Literal["yolo", "coco"]
    class_remap: dict[str, dict[str, Any] | None] = Field(default_factory=dict)
    splits: ExportSplits = Field(default_factory=ExportSplits)
    include_images: bool = True
    # Plan-20.1 — how mixed-kind annotations are written into YOLO label
    # files. Ignored for COCO (which handles all kinds natively).
    #   - "detection":    polygons / masks are collapsed to their tight
    #                     bbox so every line is the standard 5-token YOLO
    #                     detection format. Trainable with task=detect.
    #   - "segmentation": (default) bboxes are promoted to 4-vertex
    #                     polygons so every line is a YOLO-seg polygon
    #                     line. Trainable with task=segment.
    #   - "tags_only":    no geometric labels are written; only the
    #                     image-level tag sidecar. Trainable as a
    #                     classification task.
    yolo_mode: Literal["detection", "segmentation", "tags_only"] = "segmentation"


class ExportOut(BaseModel):
    id: str
    task_id: str
    format: str
    status: str
    minio_key: str | None
    error: str | None
    created_by: str | None
    created_at: datetime
    completed_at: datetime | None

    @classmethod
    def from_orm_export(cls, e) -> "ExportOut":
        return cls(
            id=str(e.id),
            task_id=str(e.task_id),
            format=e.format,
            status=e.status,
            minio_key=e.minio_key,
            error=e.error,
            created_by=str(e.created_by) if e.created_by else None,
            created_at=e.created_at,
            completed_at=e.completed_at,
        )


class ExportProgressOut(BaseModel):
    """What the GET /tasks/{tid}/exports/{eid} endpoint returns."""
    id: str
    status: str
    download_url: str | None
    error: str | None
    completed_at: datetime | None
