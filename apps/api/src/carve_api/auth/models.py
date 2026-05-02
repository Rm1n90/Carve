import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from carve_api.db import Base


class UserRole(str, enum.Enum):
    admin = "admin"
    member = "member"
    viewer = "viewer"


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
