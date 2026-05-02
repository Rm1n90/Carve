# Armin Mehri — mehri.armin@gmail.com
"""Pydantic schemas for the Phase 5 review workflow (plan-09 task-02).

Reviewers accept or reject proposed annotations. The endpoints accept an
optional free-form ``note`` for future audit trail; it is currently NOT
persisted server-side (see ``service.review_one``).
"""

from typing import Literal

from pydantic import BaseModel, Field


ReviewDecision = Literal["accept", "reject"]


class ReviewIn(BaseModel):
    """Single-annotation review request body."""

    decision: ReviewDecision
    # ``note`` is accepted for forward compatibility (free-text reviewer
    # comment) but is not persisted today. Present so clients don't break
    # when we wire it up later.
    note: str | None = None


class BatchReviewIn(BaseModel):
    """Bulk review request body. Capped at 500 ids per call to keep the
    transaction bounded and cheap to roll back on conflict."""

    ids: list[str] = Field(min_length=1, max_length=500)
    decision: ReviewDecision
    note: str | None = None


class BatchReviewOut(BaseModel):
    """Result envelope: how many ids were actually reviewed vs skipped
    (skipped = not visible to caller, not found, or otherwise inaccessible).
    Skipped ids deliberately do NOT 404 — bulk-review is best-effort across
    a heterogeneous selection."""

    reviewed: int
    skipped: int
