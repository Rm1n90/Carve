# Armin Mehri — mehri.armin@gmail.com
"""HTTP routes for workspace search (Plan-13 Phase 7 Task 8).

Single endpoint:

  * ``GET /search/assets``  -- substring match on filenames, scoped to
    the caller's project memberships. ACL is enforced inside the
    service layer (workspace admins see all; non-admins see only
    projects with a ``project_members`` row).
"""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.search.schemas import SearchAssetHit, SearchAssetsPage
from carve_api.search.service import search_assets


router = APIRouter(tags=["search"])


def _thumbnail_for(asset) -> str | None:
    """Best-effort thumbnail presign — never raises into the response."""
    try:
        from carve_api.assets.service import AssetService  # local import keeps storage optional in tests
        from carve_api.db import SessionLocal  # noqa: F401 -- type only

        # We only need the storage client; build a transient AssetService
        # without holding the request session reference.
        svc = AssetService.__new__(AssetService)
        from carve_api.storage.client import MinioClient

        svc.storage = MinioClient.from_settings()
        return svc.thumbnail_url_for(asset)
    except Exception:  # noqa: BLE001 -- storage may be unavailable in tests
        return None


@router.get("/search/assets", response_model=SearchAssetsPage)
def search_assets_endpoint(
    q: str | None = Query(default=None, max_length=255),
    workspace: bool = Query(default=False),
    project_id: uuid.UUID | None = Query(default=None),
    task_id: uuid.UUID | None = Query(default=None),
    kind: Literal["image", "video"] | None = Query(default=None),
    class_id: uuid.UUID | None = Query(default=None),
    min_size: int | None = Query(default=None, ge=0),
    max_size: int | None = Query(default=None, ge=0),
    status: Literal["proposed", "accepted", "rejected"] | None = Query(
        default=None
    ),
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SearchAssetsPage:
    items, next_cursor = search_assets(
        db,
        actor=user,
        q=q,
        workspace=workspace,
        project_id=project_id,
        task_id=task_id,
        kind=kind,
        class_id=class_id,
        min_size=min_size,
        max_size=max_size,
        status=status,
        limit=limit,
        cursor=cursor,
    )
    out: list[SearchAssetHit] = []
    for item in items:
        out.append(
            SearchAssetHit(
                asset_id=item["asset_id"],
                project_id=item["project_id"],
                project_name=item["project_name"],
                task_id=item["task_id"],
                task_name=item["task_name"],
                original_name=item["original_name"],
                kind=item["kind"],
                thumbnail_url=_thumbnail_for(item["asset"]),
                match_snippet=item["match_snippet"],
            )
        )
    return SearchAssetsPage(items=out, next_cursor=next_cursor)
