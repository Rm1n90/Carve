"""Tests for /search/assets (Plan-13 Phase 7 Task 8).

Covers the spec checklist:
  * workspace=true returns hits across two member projects but NOT a
    third project the caller is not a member of.
  * Filter by class_id narrows the hits to assets with that class.
"""
from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.jwt import create_access_token
from carve_api.auth.models import User, UserRole
from carve_api.deps import get_db
from carve_api.main import create_app
from carve_api.projects.models import Class, Project, ProjectMember, Task, TaskKind


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(user: User) -> dict[str, str]:
    token = create_access_token(subject=str(user.id), role=user.role.value)
    return {"Authorization": f"Bearer {token}"}


def _seed_asset(
    db,
    *,
    task: Task,
    name: str,
    size: int = 1024,
) -> tuple[Asset, Frame]:
    a = Asset(
        task_id=task.id,
        kind=AssetKind.image,
        xxh3_128=uuid.uuid4().hex,
        mime="image/png",
        size_bytes=size,
        width=100,
        height=80,
        frames=1,
        original_name=name,
    )
    db.add(a)
    db.flush()
    f = Frame(asset_id=a.id, idx=0, pts_ms=0)
    db.add(f)
    db.flush()
    return a, f


@pytest.fixture
def world(db_session) -> dict[str, Any]:
    """Three projects. Caller is a member of P1 and P2, not P3.

    Each project has one task with one asset.
    """
    caller = User(
        email=f"search-{uuid.uuid4()}@x.com",
        password_hash="x",
        role=UserRole.member,
    )
    other = User(
        email=f"search-other-{uuid.uuid4()}@x.com",
        password_hash="x",
        role=UserRole.member,
    )
    db_session.add_all([caller, other])
    db_session.flush()

    out: dict[str, Any] = {"caller": caller, "other": other, "projects": []}
    for i, name in enumerate(["P1", "P2", "P3"]):
        p = Project(name=f"S-{name}", owner_id=other.id)
        db_session.add(p)
        db_session.flush()
        if name in ("P1", "P2"):
            db_session.add(
                ProjectMember(project_id=p.id, user_id=caller.id, role="member")
            )
        db_session.add(
            ProjectMember(project_id=p.id, user_id=other.id, role="owner")
        )
        t = Task(project_id=p.id, name=f"T-{name}", kind=TaskKind.image)
        db_session.add(t)
        db_session.flush()
        c = Class(project_id=p.id, idx=0, name=f"car-{name}", color="#ff0000")
        db_session.add(c)
        db_session.flush()
        a, f = _seed_asset(db_session, task=t, name=f"hello-{name}.png")
        out["projects"].append(
            {"project": p, "task": t, "class": c, "asset": a, "frame": f}
        )
    db_session.flush()
    return out


def test_workspace_search_respects_membership(db_session, world) -> None:
    client = _client(db_session)
    caller = world["caller"]

    r = client.get(
        "/search/assets",
        params={"workspace": "true", "q": "hello"},
        headers=_hdr(caller),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    project_names = {hit["project_name"] for hit in body["items"]}
    assert "S-P1" in project_names
    assert "S-P2" in project_names
    # Caller is NOT a member of P3, so it must not leak.
    assert "S-P3" not in project_names


def test_filter_by_class_id_narrows_hits(db_session, world) -> None:
    client = _client(db_session)
    caller = world["caller"]
    p1 = world["projects"][0]
    p2 = world["projects"][1]

    # Annotate P1's asset with P1's class only.
    db_session.add(
        Annotation(
            task_id=p1["task"].id,
            frame_id=p1["frame"].id,
            class_id=p1["class"].id,
            kind=AnnotationKind.bbox,
            geometry={"x": 1, "y": 1, "w": 10, "h": 10},
            status="accepted",
        )
    )
    db_session.flush()

    # Filter by P1's class id -- only P1's asset should come back.
    r = client.get(
        "/search/assets",
        params={"class_id": str(p1["class"].id)},
        headers=_hdr(caller),
    )
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    asset_ids = {hit["asset_id"] for hit in items}
    assert str(p1["asset"].id) in asset_ids
    assert str(p2["asset"].id) not in asset_ids


def test_search_unauth_returns_401(db_session, world) -> None:
    _ = world
    client = _client(db_session)
    r = client.get("/search/assets")
    assert r.status_code in (401, 403)
