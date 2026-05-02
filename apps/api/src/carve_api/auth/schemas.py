# Armin Mehri — mehri.armin@gmail.com
from typing import Literal

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

    @classmethod
    def from_orm_user(cls, u) -> "UserOut":
        return cls(id=str(u.id), email=u.email, role=u.role)


class RefreshIn(BaseModel):
    refresh_token: str


class ChangePasswordIn(BaseModel):
    """Payload for self-service password change (audit Bug 16)."""

    current_password: str = Field(min_length=1)
    new_password: str = Field(min_length=8, max_length=128)
