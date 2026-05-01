"""HTTP endpoints for the Phase 5 review workflow (plan-09 task-02).

Mounted under the existing ``/annotations`` prefix so the routes live
alongside the per-id annotation routes (``/annotations/{id}``).
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from carve_api.annotations.schemas import AnnotationOut
from carve_api.auth.models import User, UserRole
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.reviews.schemas import BatchReviewIn, BatchReviewOut, ReviewIn
from carve_api.reviews.service import ReviewForbidden, ReviewService


router = APIRouter(prefix="/annotations", tags=["reviews"])


def _http(err: AppError) -> HTTPException:
    """Translate an AppError into FastAPI's HTTPException.

    Mirrors the helper in ``annotations.router`` / ``inference.router``
    so the review endpoints participate in the same error envelope.
    """
    return HTTPException(status_code=err.http_status, detail=err.code)


def _require_reviewer_role(user: User) -> None:
    """Reviewers must be ``admin`` or ``member`` — viewers are read-only."""
    if user.role not in (UserRole.admin, UserRole.member):
        raise ReviewForbidden("only admin/member can review")


@router.post(
    "/{annotation_id}/review",
    response_model=AnnotationOut,
    status_code=status.HTTP_200_OK,
)
def review_annotation(
    annotation_id: uuid.UUID,
    payload: ReviewIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AnnotationOut:
    try:
        _require_reviewer_role(user)
        a = ReviewService(db).review_one(
            actor=user, annotation_id=annotation_id, decision=payload.decision
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return AnnotationOut.from_orm_annotation(a)


@router.post("/batch:review", response_model=BatchReviewOut)
def batch_review_annotations(
    payload: BatchReviewIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> BatchReviewOut:
    try:
        _require_reviewer_role(user)
    except AppError as exc:
        raise _http(exc) from exc
    # Pre-parse uuids; malformed strings count as "skipped" rather than
    # 422 — keeps the bulk op resilient to mixed-quality client data.
    parsed: list[uuid.UUID] = []
    skipped_parse = 0
    for raw in payload.ids:
        try:
            parsed.append(uuid.UUID(raw))
        except (TypeError, ValueError):
            skipped_parse += 1
    reviewed, skipped = ReviewService(db).batch_review(
        actor=user, ids=parsed, decision=payload.decision
    )
    db.commit()
    return BatchReviewOut(reviewed=reviewed, skipped=skipped + skipped_parse)
