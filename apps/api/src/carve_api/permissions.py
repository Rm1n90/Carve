# Armin Mehri — mehri.armin@gmail.com
"""Workspace-role capability gates (outsourcing hardening).

Carve's workspace roles are ``admin``, ``member`` and ``viewer``. Project
membership (``project_members``) decides *which* projects a non-admin can
see; this module decides *what they may do* once inside one. Two
capability families are withheld from every non-admin:

**Data movement** — dataset export, asset upload, annotation import,
task duplication and cross-project class copy. Admin-only with no
per-task override: the point of the gate is that an outsourced annotator
cannot carry the dataset out of Carve, nor push foreign data in.

**GPU / model features** — My Model predict, Auto-Annotate, Smart Find
(YOLOE), interactive SAM, SAM tracking, retrain, and the global device /
SAM-variant switches. Admin-only *by default*; a workspace admin can
re-open them for one specific task by setting
``tasks.gpu_access_for_members`` (Task settings → "AI tools for
members"). Global controls that affect every user (device preference,
active SAM variant, unload/free-memory) stay admin-only regardless —
there is no per-task meaning for a workspace-wide switch.

Everything an annotator actually needs — listing assets, reading images,
creating/editing/deleting annotations, saving, reviewing — is untouched.

Enforcement lives here, on the server. The web app also hides the
corresponding controls, but that is cosmetic: hiding a button does not
stop a crafted request, so every gated route calls into this module.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from carve_api.auth.models import User, UserRole
from carve_api.deps import get_current_user

if TYPE_CHECKING:  # pragma: no cover - typing only
    from carve_api.projects.models import Task


# Error codes returned as ``{"error": <code>, "message": ...}``. The web
# app matches on the code to render a role-appropriate explanation
# instead of a bare "Forbidden".
DATA_MOVEMENT_FORBIDDEN = "data_movement_forbidden"
GPU_FORBIDDEN = "gpu_forbidden"
ADMIN_ONLY = "admin_only"

_DATA_MOVEMENT_MESSAGE = (
    "Exporting, uploading, importing, copying and duplicating are "
    "restricted to workspace admins."
)
_GPU_MESSAGE = (
    "AI and model tools are restricted to workspace admins. An admin can "
    "enable them for a specific task from that task's settings."
)
_ADMIN_MESSAGE = "This action is restricted to workspace admins."


def is_admin(user: User) -> bool:
    """True for workspace admins — the only unrestricted role."""
    return user.role == UserRole.admin


def _forbid(code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={"error": code, "message": message},
    )


# ---------------------------------------------------------------------------
# Data movement — export / upload / import / duplicate / copy
# ---------------------------------------------------------------------------


def require_data_movement(user: User) -> User:
    """Gate export, upload, import, duplicate and cross-project copy.

    No per-task override by design: a task-scoped exemption would defeat
    the purpose, since the annotator picks which task they are in.
    """
    if not is_admin(user):
        raise _forbid(DATA_MOVEMENT_FORBIDDEN, _DATA_MOVEMENT_MESSAGE)
    return user


def data_movement_guard(user: User = Depends(get_current_user)) -> User:
    """``Depends`` form of :func:`require_data_movement`.

    Use on routes that have no other reason to resolve the actor, so the
    gate runs before the handler body (and before any file upload is
    consumed).
    """
    return require_data_movement(user)


# ---------------------------------------------------------------------------
# GPU / model features
# ---------------------------------------------------------------------------


def task_gpu_allowed(user: User, task: Task) -> bool:
    """Whether ``user`` may run GPU-backed inference against ``task``."""
    if is_admin(user):
        return True
    return bool(getattr(task, "gpu_access_for_members", False))


def require_gpu_task(
    db: Session, user: User, task_id: uuid.UUID
) -> Task:
    """Resolve a task for a GPU-backed route, enforcing the model gate.

    Drop-in replacement for
    :func:`carve_api.projects.service.require_visible_task` on every
    inference route: same visibility/IDOR semantics (a non-member still
    gets 404, never 403), plus a 403 when the actor is a non-admin and
    the task has not been granted AI access.
    """
    from carve_api.projects.service import require_visible_task

    task = require_visible_task(db, user, task_id)
    if not task_gpu_allowed(user, task):
        raise _forbid(GPU_FORBIDDEN, _GPU_MESSAGE)
    return task


def require_gpu_admin(user: User) -> User:
    """Gate workspace-wide GPU controls (devices, SAM variant, unload).

    These have no per-task meaning — switching the active SAM variant or
    a device preference changes the model service for everyone — so the
    per-task grant does not apply.
    """
    if not is_admin(user):
        raise _forbid(GPU_FORBIDDEN, _GPU_MESSAGE)
    return user


def gpu_admin_guard(user: User = Depends(get_current_user)) -> User:
    """``Depends`` form of :func:`require_gpu_admin`."""
    return require_gpu_admin(user)


# ---------------------------------------------------------------------------
# Plain admin-only
# ---------------------------------------------------------------------------


def require_admin(user: User) -> User:
    if not is_admin(user):
        raise _forbid(ADMIN_ONLY, _ADMIN_MESSAGE)
    return user


def admin_guard(user: User = Depends(get_current_user)) -> User:
    """``Depends`` form of :func:`require_admin`."""
    return require_admin(user)


__all__ = [
    "ADMIN_ONLY",
    "DATA_MOVEMENT_FORBIDDEN",
    "GPU_FORBIDDEN",
    "admin_guard",
    "data_movement_guard",
    "gpu_admin_guard",
    "is_admin",
    "require_admin",
    "require_data_movement",
    "require_gpu_admin",
    "require_gpu_task",
    "task_gpu_allowed",
]
