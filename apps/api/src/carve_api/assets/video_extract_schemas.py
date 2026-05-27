"""
Pydantic schemas for video extract batch endpoints.

Handles input validation, response serialization, and field constraints for:
- Batch enqueue requests
- Batch enqueue responses
- Job status tracking
"""

from typing import List, Literal

from pydantic import BaseModel, Field, field_validator


ExtractMode = Literal["every_nth", "count"]
JobStatus = Literal["pending", "processing", "completed", "failed"]


class BatchEnqueueIn(BaseModel):
    """Input schema for batch video extraction enqueue."""

    sources: List[str] = Field(
        ...,
        min_length=1,
        description="List of video source paths. Must contain at least one source.",
    )
    mode: ExtractMode = Field(
        ...,
        description="Extraction mode: 'every_nth' or 'count'.",
    )
    n_or_k: int = Field(
        ...,
        ge=0,
        description="Frame interval (every_nth) or count (count). Must be >= 0.",
    )
    quality: int = Field(
        default=85,
        ge=1,
        le=100,
        description="Output image quality (1-100, clamped).",
    )

    @field_validator("n_or_k")
    @classmethod
    def validate_n_or_k(cls, v: int, info) -> int:
        """Enforce n_or_k > 0 for every_nth and count modes."""
        if v <= 0:
            raise ValueError("n_or_k must be > 0 for extraction modes")
        return v

    @field_validator("quality", mode="before")
    @classmethod
    def clamp_quality(cls, v) -> int:
        """Clamp quality to valid range 1..100."""
        if not isinstance(v, int):
            v = int(v)
        return max(1, min(100, v))


class BatchEnqueueOut(BaseModel):
    """Response schema for batch video extraction enqueue."""

    batch_id: str = Field(
        ...,
        description="Unique identifier for the batch job.",
    )


class BatchJobItem(BaseModel):
    """Individual job info in batch status response."""

    source: str = Field(
        ...,
        description="Video source path.",
    )
    status: JobStatus = Field(
        ...,
        description="Current job status.",
    )
    frames_extracted: int = Field(
        ...,
        ge=0,
        description="Number of frames extracted so far.",
    )


class BatchStatusOut(BaseModel):
    """Response schema for batch status query."""

    batch_id: str = Field(
        ...,
        description="Unique identifier for the batch job.",
    )
    jobs: List[BatchJobItem] = Field(
        default_factory=list,
        description="List of individual job statuses.",
    )
