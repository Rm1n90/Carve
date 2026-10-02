# Armin Mehri — mehri.armin@gmail.com
"""What other parts of the app must check before they pull the ground
out from under a Logo AI run."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.errors import AppError
from carve_api.logo_ai.models import TERMINAL_STATUSES, LogoAiJob
from carve_api.projects.models import Task


class LogoAiRunActive(AppError):
    """A Logo AI run is still going on the thing being deleted."""

    http_status = 409
    code = "logo_ai_job_active"


def require_no_active_run(
    session: Session,
    *,
    task_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
) -> None:
    """Refuse to delete a task (or a project's tasks) with a run in
    progress.

    Deleting the task deletes the run's rows with it. Batches already
    with the provider would then go on running, and being billed, with
    nothing left here that knows to stop them or read them. Canceling
    the run first stops them and keeps what they had produced.
    """
    query = select(LogoAiJob.id).where(LogoAiJob.status.not_in(TERMINAL_STATUSES))
    if task_id is not None:
        query = query.where(LogoAiJob.task_id == task_id)
    else:
        query = query.join(Task, Task.id == LogoAiJob.task_id).where(
            Task.project_id == project_id
        )
    if session.execute(query.limit(1)).first() is not None:
        raise LogoAiRunActive(
            "A Logo AI run is still in progress here. Cancel it first (Logo AI → "
            "Runs), so that its batches are stopped at the provider and what "
            "they produced is kept."
        )
