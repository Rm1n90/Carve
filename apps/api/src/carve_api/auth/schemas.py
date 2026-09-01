# Armin Mehri — mehri.armin@gmail.com
from typing import Literal

from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

from carve_api.auth.models import UserRole


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class CreateMemberIn(BaseModel):
    """Bug 14: admin-create-member payload. The role is constrained to
    ``admin`` or ``member`` because ``viewer`` was removed from the v3.0
    admin-invite flow (the existing role-edit dropdown still exposes it
    so legacy data isn't broken)."""

    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    role: Literal["admin", "member"] | None = "member"


class SetPasswordIn(BaseModel):
    """Superadmin-driven password reset for another account.

    Deliberately has no ``current_password`` field: the whole point is
    that a superadmin can restore access to an account whose password
    nobody knows. Every session of the target user is revoked as a side
    effect, so the reset cannot be undone by an already-open browser tab.
    """

    new_password: str = Field(min_length=8, max_length=128)


class BlockUserIn(BaseModel):
    """Reason is optional but strongly encouraged — it is shown to the
    blocked user on their next login attempt."""

    reason: str | None = Field(default=None, max_length=500)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "Bearer"


class UserOut(BaseModel):
    id: str
    email: EmailStr
    role: UserRole
    # Account-control state (alembic 0039). ``blocked`` is derived rather
    # than exposing the raw timestamp, because that is what every caller
    # actually branches on; the timestamp is there for display.
    blocked: bool = False
    blocked_at: datetime | None = None
    blocked_reason: str | None = None

    @classmethod
    def from_orm_user(cls, u) -> "UserOut":
        return cls(
            id=str(u.id),
            email=u.email,
            role=u.role,
            blocked=getattr(u, "blocked_at", None) is not None,
            blocked_at=getattr(u, "blocked_at", None),
            blocked_reason=getattr(u, "blocked_reason", None),
        )


class RefreshIn(BaseModel):
    refresh_token: str


class ChangePasswordIn(BaseModel):
    """Payload for self-service password change (audit Bug 16)."""

    current_password: str = Field(min_length=1)
    new_password: str = Field(min_length=8, max_length=128)
