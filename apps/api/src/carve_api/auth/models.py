# Armin Mehri — mehri.armin@gmail.com
import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    String,
    Text,
    false,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from carve_api.db import Base


class UserRole(str, enum.Enum):
    # Tier above ``admin``: the only role that may manage admin accounts,
    # reset another user's password, block/unblock, revoke sessions,
    # purge the trash or suspend a project. See ``carve_api.permissions``.
    superadmin = "superadmin"
    admin = "admin"
    member = "member"
    viewer = "viewer"


#: Roles carrying full workspace-admin authority.
#:
#: Every "is this user an admin?" test MUST go through this set rather
#: than comparing against ``UserRole.admin`` directly — a bare equality
#: check silently excludes superadmins, which would leave the highest
#: role with *fewer* permissions than the one below it. Also usable in
#: SQLAlchemy filters via ``User.role.in_(ADMIN_LEVEL_ROLES)``.
ADMIN_LEVEL_ROLES: tuple["UserRole", ...] = (UserRole.superadmin, UserRole.admin)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[UserRole] = mapped_column(
        Enum(UserRole, name="user_role"), nullable=False, default=UserRole.member
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # Bug 14: soft delete. Admins remove members from Settings -> Members.
    # Every read-side query that returns a User to a client must filter on
    # ``deleted_at IS NULL`` so a removed user never reappears.
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    # Plan-13 Phase 7 Task 5 -- OIDC subject identifier for SSO-linked
    # users. NULL for locally-registered accounts. Uniqueness is enforced
    # by a partial unique index (see migration 0026); not declared with
    # ``unique=True`` here because that would translate to an ALL-rows
    # unique constraint and break multiple NULL rows on some dialects.
    sso_subject: Mapped[str | None] = mapped_column(
        String(255), nullable=True, default=None
    )
    # --- superadmin account controls (alembic 0039) --------------------
    # A blocked account cannot log in, and any request it makes with an
    # already-issued token fails immediately because ``get_current_user``
    # re-reads this row on every request.
    blocked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None, index=True
    )
    blocked_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True, default=None,
    )
    blocked_reason: Mapped[str | None] = mapped_column(
        Text, nullable=True, default=None
    )
    # "Force logout". JWTs are stateless, so revocation is expressed as a
    # cutoff: a token whose ``iat`` predates this instant is refused.
    # Stamped when a superadmin resets the password or revokes sessions.
    sessions_valid_from: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    # v3.20 -- per-user keyboard shortcut overrides. Sparse map of
    # ``action_id -> chord``; absent keys mean "use the default chord".
    # Empty string is reserved for "unbound" (handler stays registered
    # but never fires; UI doesn't expose this state in v1). The column
    # is non-nullable with a server default of ``{}`` so existing rows
    # (and writers that never touched it) read back as "all defaults".
    shortcut_overrides: Mapped[dict[str, str]] = mapped_column(
        JSONB, nullable=False, server_default="{}"
    )
    # v3.21+ — per-user VLM-FO1 precision filter opt-in. Default False
    # matches the spec's feature-OFF posture. The editor reads this on
    # mount and writes via PUT /me/vlm-fo1.
    vlm_fo1_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=false(),
    )
