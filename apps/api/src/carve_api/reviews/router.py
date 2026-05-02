# Armin Mehri — mehri.armin@gmail.com
"""HTTP endpoints for the Phase 5 review workflow (plan-09 task-02).

Mounted under the existing ``/annotations`` prefix so the routes live
alongside the per-id annotation routes (``/annotations/{id}``).
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation
from carve_api.annotations.schemas import AnnotationOut
from carve_api.assets.models import Asset
from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.projects.models import Task
from carve_api.projects.service import (
    _MUTATING_ROLES,
    get_project_role,
)
from carve_api.reviews.schemas import BatchReviewIn, BatchReviewOut, ReviewIn
from carve_api.reviews.service import ReviewForbidden, ReviewService


router = APIRouter(prefix="/annotations", tags=["reviews"])


def _http(err: AppError) -> HTTPException:
    """Translate an AppError into FastAPI's HTTPException.

    Mirrors the helper in ``annotations.router`` / ``inference.router``
    so the review endpoints participate in the same error envelope.
    """
    return HTTPException(status_code=err.http_status, detail=err.code)


def _require_reviewer_role_for_annotation(
    db, user: User, annotation_id: uuid.UUID
) -> None:
    """Plan-13 Phase 7 Task 2 — reviewer auth is project-role based.

    Resolves the annotation's project (via its task) and requires the
    actor to have a mutating role (owner/admin/member) on that project.
    Viewers and non-members get :class:`ReviewForbidden` (403). When the
    annotation does not exist this returns silently — the service layer
    surfaces ``annotation_not_found`` (404) afterwards.
    """
    a = db.get(Annotation, annotation_id)
    if a is None:
        return
    task = db.get(Task, a.task_id)
    if task is None:
        return
    role = get_project_role(db, user.id, task.project_id)
    if role is None or role not in _MUTATING_ROLES:
        raise ReviewForbidden("only project member/admin/owner can review")


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
        _require_reviewer_role_for_annotation(db, user, annotation_id)
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
    # Plan-13 Phase 7 Task 2 — per-id project role check happens inside
    # ``ReviewService.batch_review`` which silently skips ids the actor
    # lacks the mutating role for, matching the existing "skipped"
    # semantics for unknown / unauthorised ids.
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
