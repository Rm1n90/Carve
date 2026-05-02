# Armin Mehri — mehri.armin@gmail.com
"""Pydantic schemas for the singleton workspace endpoints (v3.1 Bug 6).

``WorkspaceOut`` mirrors the column set in ``models.Workspace`` plus a
derived ``members_count`` so the Settings → Workspace UI can show one
linkable stat without an extra round-trip to /auth/members.

``WorkspaceUpdateIn`` validates partial updates: empty string is rejected
for ``name`` (length floor of 1) since the singleton invariant is "always
has a non-empty name"; ``description`` accepts any string up to 2000
chars or ``None`` to clear it.
"""
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class WorkspaceOut(BaseModel):
    id: UUID
    name: str
    description: str | None
    created_at: datetime
    updated_at: datetime
    members_count: int


class WorkspaceUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
