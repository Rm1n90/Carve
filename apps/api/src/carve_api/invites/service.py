"""Invitation service (Plan-13 Phase 7 Task 4).

Encapsulates all DB-touching logic for project invitations:
  * create-invite (token generation + hash, duplicate / member checks)
  * list-pending (non-accepted, non-expired)
  * revoke (delete by id)
  * accept (existing-user vs new-user paths, idempotent guards)

The raw token is generated with ``secrets.token_urlsafe(32)`` and is
ONLY ever returned in-memory to the caller of ``create``. Persistence
uses a SHA-256 hex digest. There is no log line, debug print, or
exception message that includes the raw token.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.errors import AppError
from carve_api.invites.models import ProjectInvite
from carve_api.projects.models import Project, ProjectMember


INVITE_TTL = timedelta(days=7)


class InviteNotFound(AppError):
    http_status = 404
    code = "invite_not_found"


class InviteExpired(AppError):
    http_status = 410
    code = "invite_expired"


class InviteAlreadyAccepted(AppError):
    http_status = 409
    code = "invite_already_accepted"


class EmailAlreadyMember(AppError):
    http_status = 409
    code = "email_already_member"


class DuplicateInvite(AppError):
    """Raised when an outstanding invite already exists for ``email``."""

    http_status = 409
    code = "duplicate_invite"

    def __init__(self, existing_id: uuid.UUID) -> None:
        super().__init__("invite already exists")
        self.existing_id = existing_id


def generate_token() -> str:
    """Spec MUST: ``secrets.token_urlsafe(32)``."""
    return secrets.token_urlsafe(32)


def hash_token(raw: str) -> str:
    """SHA-256 hex digest of ``raw``. 64 hex chars."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


class InviteService:
    def __init__(self, session: Session) -> None:
        self.session = session

    # ---- create -------------------------------------------------------

    def create(
        self,
        *,
        project: Project,
        email: str,
        role: str,
        invited_by: User,
    ) -> tuple[ProjectInvite, str]:
        """Insert an invite row. Returns ``(invite, raw_token)``."""
        normalized = email.strip().lower()

        # Already a member of this project? (case-insensitive)
        existing_member_id = self.session.execute(
            select(User.id)
            .join(ProjectMember, ProjectMember.user_id == User.id)
            .where(
                ProjectMember.project_id == project.id,
                func.lower(User.email) == normalized,
                User.deleted_at.is_(None),
            )
            .limit(1)
        ).scalar_one_or_none()
        if existing_member_id is not None:
            raise EmailAlreadyMember("email already a project member")

        outstanding_id = self.session.execute(
            select(ProjectInvite.id)
            .where(
                ProjectInvite.project_id == project.id,
                func.lower(ProjectInvite.email) == normalized,
                ProjectInvite.accepted_at.is_(None),
                ProjectInvite.expires_at > _now(),
            )
            .limit(1)
        ).scalar_one_or_none()
        if outstanding_id is not None:
            raise DuplicateInvite(outstanding_id)

        raw = generate_token()
        invite = ProjectInvite(
            project_id=project.id,
            email=normalized,
            role=role,
            token_hash=hash_token(raw),
            invited_by=invited_by.id,
            expires_at=_now() + INVITE_TTL,
        )
        self.session.add(invite)
        self.session.flush()
        return invite, raw

    # ---- list / get / revoke -----------------------------------------

    def list_pending(self, *, project_id: uuid.UUID) -> list[ProjectInvite]:
        return list(
            self.session.execute(
                select(ProjectInvite)
                .where(
                    ProjectInvite.project_id == project_id,
                    ProjectInvite.accepted_at.is_(None),
                    ProjectInvite.expires_at > _now(),
                )
                .order_by(ProjectInvite.created_at.desc())
            ).scalars()
        )

    def get_by_id(
        self, *, project_id: uuid.UUID, invite_id: uuid.UUID
    ) -> ProjectInvite | None:
        return self.session.execute(
            select(ProjectInvite).where(
                ProjectInvite.id == invite_id,
                ProjectInvite.project_id == project_id,
            )
        ).scalar_one_or_none()

    def revoke(self, *, invite: ProjectInvite) -> None:
        if invite.accepted_at is not None:
            raise InviteAlreadyAccepted("invite already accepted")
        self.session.delete(invite)
        self.session.flush()

    # ---- accept ------------------------------------------------------

    def lookup_by_token(self, raw_token: str) -> ProjectInvite | None:
        return self.session.execute(
            select(ProjectInvite).where(
                ProjectInvite.token_hash == hash_token(raw_token)
            )
        ).scalar_one_or_none()

    def assert_acceptable(self, invite: ProjectInvite) -> None:
        if invite.accepted_at is not None:
            raise InviteAlreadyAccepted("invite already accepted")
        if invite.expires_at <= _now():
            raise InviteExpired("invite expired")

    def mark_accepted(
        self, *, invite: ProjectInvite, user: User
    ) -> None:
        invite.accepted_at = _now()
        invite.accepted_by = user.id
        self.session.flush()
