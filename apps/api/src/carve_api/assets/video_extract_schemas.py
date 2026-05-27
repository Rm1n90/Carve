# Armin Mehri — mehri.armin@gmail.com
"""Pydantic schemas for the video → image extraction batch endpoints.

The strategy vocabulary (``auto | all | every_nth | count``) intentionally
matches the existing ``extract_frames_for_video`` worker in
``carve_api/jobs/frames.py`` so there is one set of names in the codebase.
The frontend labels ``count`` as "Total of K (smart)" to the user but the
wire value is ``count``.
"""
from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


ExtractMode = Literal["auto", "all", "every_nth", "count"]
JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]


class BatchEnqueueIn(BaseModel):
    """Request body for ``POST /…/video-extract/batch``."""

    source_asset_ids: list[uuid.UUID] = Field(min_length=1)
    mode: ExtractMode
    n_or_k: int = Field(ge=0)
    quality: int = Field(ge=1, le=100)

    model_config = ConfigDict(extra="forbid")

    @field_validator("quality", mode="before")
    @classmethod
    def _clamp_quality(cls, v):  # type: ignore[no-untyped-def]
        try:
            iv = int(v)
        except (TypeError, ValueError):
            return v
        return max(1, min(100, iv))

    @field_validator("n_or_k")
    @classmethod
    def _n_or_k_for_step_modes(cls, v: int, info) -> int:  # type: ignore[no-untyped-def]
        mode = info.data.get("mode")
        if mode in ("every_nth", "count") and v <= 0:
            raise ValueError(f"n_or_k must be >= 1 for mode={mode}")
        return v


class BatchJobItem(BaseModel):
    job_id: str
    source_asset_id: uuid.UUID
    source_filename: str
    status: JobStatus
    progress: int = Field(ge=0, le=100)
    frames_extracted: int = Field(ge=0)
    dedup_skipped: int = Field(ge=0)
    error_message: str | None = None


class BatchEnqueueOut(BaseModel):
    batch_id: uuid.UUID
    jobs: list[BatchJobItem]


class BatchStatusOut(BaseModel):
    batch_id: uuid.UUID
    jobs: list[BatchJobItem]
