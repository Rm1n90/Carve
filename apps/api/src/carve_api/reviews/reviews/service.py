"""Service layer for the Phase 5 review workflow (plan-09 task-02).

Single-call ``review_one`` flips a single annotation's status; ``batch_review``
loops it over a list, swallowing per-row access errors so the caller can
report a ``reviewed`` / ``skipped`` envelope without 404s leaking row
existence to unauthorized callers.
"""

from __future__ import annotations

import copy
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation
from carve_api.auth.models import User
from carve_api.errors import AppError
from carve_api.projects.models import Task as TaskModel
from carve_api.projects.service import ProjectService, TaskService


_TERMINAL = {"accept": "accepted", "reject": "rejected"}


def _decision_to_status(decision: str) -> str:
    if decision not in _TERMINAL:
        # Defensive — the request schema's Literal already constrains
        # this; reaching here means a programmer-side mistake.
        raise ValueError(f"unknown decision: {decision!r}")
    return _TERMINAL[decision]


def _resolve_visible_task(db: Session, user: User, task_id: uuid.UUID) -> TaskModel:
    """Mirror of ``annotations.router._require_visible_task`` — kept here
    to avoid an import cycle through the router module."""
    task = db.get(TaskModel, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task_not_found")
    project = ProjectService(db).get(actor=user, project_id=task.project_id)
    TaskService(db).get(project=project, task_id=task.id)
    return task


class ReviewService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def review_one(
        self,
        *,
        actor: User,
        annotation_id: uuid.UUID,
        decision: str,
    ) -> Annotation:
        """Flip a single annotation's review status.

        Caller is responsible for the role gate (member/admin) — this
        method only checks task visibility. Raises ``HTTPException(404)``
        when the annotation doesn't exist or its task isn't visible.
        """
        a = self.session.get(Annotation, annotation_id)
        if a is None:
            raise HTTPException(status_code=404, detail="annotation_not_found")
        try:
            _resolve_visible_task(self.session, actor, a.task_id)
        except HTTPException as exc:
            # Mask "task not found" as "annotation not found" for the
            # same IDOR-mitigation reason as the annotations router.
            raise HTTPException(
                status_code=404, detail="annotation_not_found"
            ) from exc

        target_status = _decision_to_status(decision)
        # Snapshot the geometry as it stands NOW so a future edit can
        # be compared against what the reviewer signed off on.
        # ``copy.deepcopy`` keeps the JSONB dict independent of the
        # live geometry attribute (ORM holds a reference, not a copy).
        a.prev_geometry = copy.deepcopy(a.geometry)
        a.status = target_status
        a.reviewed_by_id = actor.id
        a.reviewed_at = datetime.now(timezone.utc)
        self.session.flush()
        return a

    def batch_review(
        self,
        *,
        actor: User,
        ids: list[uuid.UUID],
        decision: str,
    ) -> tuple[int, int]:
        """Review many ids transactionally.

        Returns ``(reviewed_count, skipped_count)``. Skipped entries are
        ids the caller can't access (or that don't exist) — they are
        deliberately NOT 404'd, since this is a best-effort bulk op
        across a heterogeneous selection.
        """
        reviewed = 0
        skipped = 0
        for ann_id in ids:
            try:
                self.review_one(
                    actor=actor, annotation_id=ann_id, decision=decision
                )
            except HTTPException:
                skipped += 1
            except AppError:
                skipped += 1
            else:
                reviewed += 1
        return reviewed, skipped
