# Armin Mehri — mehri.armin@gmail.com
"""Pydantic schemas for the project invitation flow (Plan-13 Phase 7 Task 4)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field


# Owner is intentionally NOT in this literal -- you cannot invite a
# user as ``owner``; ownership transfer is a separate (future) flow.
InviteRoleLiteral = Literal["admin", "member", "viewer"]


class InviteCreateIn(BaseModel):
    email: EmailStr
    role: InviteRoleLiteral


class InviteOut(BaseModel):
    """Returned by ``POST /projects/{pid}/invites``.

    The raw ``token`` is included exactly once -- in the response to
    the create call. It is never stored or returned again.
    """

    id: uuid.UUID
    project_id: uuid.UUID
    email: str
    role: str
    token: str
    expires_at: datetime


class InviteListItemOut(BaseModel):
    """One row of ``GET /projects/{pid}/invites``. Excludes the token."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    email: str
    role: str
    invited_by: uuid.UUID | None = None
    created_at: datetime
    expires_at: datetime


class InvitePreviewOut(BaseModel):
    """Read-only token preview returned by ``GET /invites/{token}/preview``."""

    project_id: uuid.UUID
    project_name: str
    email: str
    role: str
    requires_password: bool


class InviteAcceptIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    password: str | None = Field(default=None, min_length=8, max_length=200)


class InviteAcceptUserOut(BaseModel):
    id: uuid.UUID
    email: str
    role: str


class InviteAcceptOut(BaseModel):
    user: InviteAcceptUserOut
    project_id: uuid.UUID
    role: str
    jwt: str | None = None
    refresh_token: str | None = None


class MemberRoleIn(BaseModel):
    role: Literal["owner", "admin", "member", "viewer"]
