# Armin Mehri — mehri.armin@gmail.com
"""Pydantic schemas for saved views (Plan-13 Phase 7 Task 8)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class SavedViewIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    query: dict[str, Any] = Field(default_factory=dict)
    shared: bool = False


class SavedViewPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    query: dict[str, Any] | None = None
    shared: bool | None = None


class SavedViewOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    task_id: uuid.UUID
    owner: uuid.UUID | None
    name: str
    query: dict[str, Any]
    shared: bool
    created_at: datetime
    updated_at: datetime
