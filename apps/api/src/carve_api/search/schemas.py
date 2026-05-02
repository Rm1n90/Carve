"""Pydantic schemas for the workspace search API (Plan-13 Phase 7 Task 8)."""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel


class SearchAssetHit(BaseModel):
    asset_id: uuid.UUID
    project_id: uuid.UUID
    project_name: str
    task_id: uuid.UUID
    task_name: str
    original_name: str
    kind: Literal["image", "video"]
    thumbnail_url: str | None = None
    match_snippet: str | None = None


class SearchAssetsPage(BaseModel):
    items: list[SearchAssetHit]
    next_cursor: str | None = None
