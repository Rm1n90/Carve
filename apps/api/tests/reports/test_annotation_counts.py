"""Annotation counts by person (superadmin): per task or per class, with
AI-made annotations counted apart, the Trash left out, and a period."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.jwt import create_access_token
from carve_api.auth.models import User, UserRole
from carve_api.auth.passwords import hash_password
from carve_api.deps import get_db
from carve_api.main import create_app
from carve_api.projects.models import Class, Project, Task, TaskKind

URL = "/admin/reports/annotations"


def _client(db_session) -> TestClient:
    app = create_app()

    def _ov():
        yield db_session

    app.dependency_overrides[get_db] = _ov
    return TestClient(app)


def _hdr(u: User) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(subject=str(u.id), role=u.role.value)}"}


def _user(db_session, label: str, role: UserRole) -> User:
    u = User(
        email=f"{label}-{uuid.uuid4().hex[:6]}@counts.example.com",
        password_hash=hash_password("x" * 12),
        role=role,
    )
    db_session.add(u)
    db_session.flush()
    return u


def _frame(db_session, task: Task) -> uuid.UUID:
    asset = Asset(
        task_id=task.id,
        kind=AssetKind.image,
        xxh3_128=uuid.uuid4().hex,
        mime="image/png",
        size_bytes=10,
        frames=1,
        original_name=f"a{uuid.uuid4()}.png",
    )
    db_session.add(asset)
    db_session.flush()
    f = Frame(asset_id=asset.id, idx=0, pts_ms=0)
    db_session.add(f)
    db_session.flush()
    return f.id


def _ann(db_session, task, frame_id, klass, user, *, ai=False, days_ago=0) -> None:
    at = datetime.now(UTC) - timedelta(days=days_ago)
    db_session.add(
        Annotation(
            task_id=task.id,
            frame_id=frame_id,
            class_id=klass.id,
            kind=AnnotationKind.bbox,
            geometry={"x": 0, "y": 0, "w": 10, "h": 10},
            created_by=user.id,
            confidence=0.9 if ai else None,
            created_at=at,
            updated_at=at,
        )
    )


@pytest.fixture()
def world(db_session) -> dict:
    sa = _user(db_session, "super", UserRole.superadmin)
    alice = _user(db_session, "alice", UserRole.member)
    bob = _user(db_session, "bob", UserRole.member)
    project = Project(name=f"Counts {uuid.uuid4().hex[:4]}", owner_id=sa.id)
    db_session.add(project)
    db_session.flush()
    nike = Class(project_id=project.id, idx=0, name="nike", color="#ff0000", attributes={})
    adidas = Class(project_id=project.id, idx=1, name="adidas", color="#00ff00", attributes={})
    t1 = Task(project_id=project.id, name="Set 1", kind=TaskKind.image)
    t2 = Task(project_id=project.id, name="Set 2", kind=TaskKind.image)
    binned = Task(
        project_id=project.id, name="Binned", kind=TaskKind.image, deleted_at=datetime.now(UTC)
    )
    db_session.add_all([nike, adidas, t1, t2, binned])
    db_session.flush()
    f1, f2, f3, fb = (_frame(db_session, t) for t in (t1, t1, t2, binned))
    _ann(db_session, t1, f1, nike, alice)
    _ann(db_session, t1, f1, adidas, alice)
    _ann(db_session, t1, f2, nike, alice, ai=True)
    _ann(db_session, t1, f2, nike, alice, days_ago=30)
    _ann(db_session, t2, f3, nike, bob)
    _ann(db_session, t2, f3, adidas, bob, ai=True)
    _ann(db_session, binned, fb, nike, bob)
    db_session.flush()
    return {"sa": sa, "alice": alice, "bob": bob, "project": project, "t1": t1, "t2": t2}


def _rows(c, world, **params) -> list[dict]:
    params.setdefault("project_id", str(world["project"].id))
    r = c.get(URL, params=params, headers=_hdr(world["sa"]))
    assert r.status_code == 200, r.text
    return r.json()["rows"]


def test_counts_per_task_and_person(db_session, world) -> None:
    rows = _rows(_client(db_session), world)
    got = {(r["task_name"], r["email"]): (r["total"], r["from_ai"], r["images"]) for r in rows}
    # The task in the Trash is left out.
    assert got == {
        ("Set 1", world["alice"].email): (4, 1, 2),
        ("Set 2", world["bob"].email): (2, 1, 1),
    }
    assert rows[0]["project_name"] == world["project"].name


def test_counts_per_class_for_one_task_and_a_period(db_session, world) -> None:
    c = _client(db_session)
    rows = _rows(c, world, group_by="class", task_id=str(world["t1"].id))
    assert {(r["class_name"], r["total"]) for r in rows} == {("nike", 3), ("adidas", 1)}
    recent = _rows(c, world, task_id=str(world["t1"].id), days=7)
    assert [(r["total"], r["from_ai"]) for r in recent] == [(3, 1)]


def test_only_the_superadmin_sees_the_counts(db_session, world) -> None:
    c = _client(db_session)
    admin = _user(db_session, "admin", UserRole.admin)
    assert c.get(URL, headers=_hdr(admin)).status_code == 403
    assert c.get(URL, params={"group_by": "user"}, headers=_hdr(world["sa"])).status_code == 422
