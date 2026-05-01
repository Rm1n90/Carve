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

from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation
from carve_api.annotations.service import AnnotationNotFound
from carve_api.auth.models import User
from carve_api.errors import AppError
from carve_api.projects.service import (
    TaskNotFound,
    require_visible_task,
)


class ReviewForbidden(AppError):
    """Raised when the actor's role isn't allowed to review.

    Mirrors the project-wide pattern (e.g. ``SamTrackFailed``,
    ``NotProjectOwner``) so the router can translate via ``_http()``
    instead of constructing an ``HTTPException`` directly.
    """

    http_status = 403
    code = "forbidden"


_TERMINAL = {"accept": "accepted", "reject": "rejected"}


def _decision_to_status(decision: str) -> str:
    if decision not in _TERMINAL:
        # Defensive — the request schema's Literal already constrains
        # this; reaching here means a programmer-side mistake.
        raise ValueError(f"unknown decision: {decision!r}")
    return _TERMINAL[decision]


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
        method only checks task visibility. Raises
        :class:`AnnotationNotFound` when the annotation doesn't exist
        OR when its task isn't visible (mask "task not found" as
        "annotation not found" for IDOR mitigation, mirroring the
        annotations router).
        """
        a = self.session.get(Annotation, annotation_id)
        if a is None:
            raise AnnotationNotFound("annotation not found")
        try:
            require_visible_task(self.session, actor, a.task_id)
        except AppError as exc:
            # Mask "task not found" / project-level access failures as
            # "annotation not found" for the same IDOR-mitigation reason
            # as the annotations router.
            raise AnnotationNotFound("annotation not found") from exc

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
        across a heterogeneous selection. Only the specific access
        errors are swallowed; anything else propagates so the caller
        sees real bugs (rather than them being silently miscounted as
        "skipped").
        """
        reviewed = 0
        skipped = 0
        for ann_id in ids:
            try:
                self.review_one(
                    actor=actor, annotation_id=ann_id, decision=decision
                )
            except (AnnotationNotFound, TaskNotFound):
                skipped += 1
            else:
                reviewed += 1
        return reviewed, skipped
