"""Member access per AI tool (Settings → Configuration → Member access).

Each of SAM, My model, Smart Find and Logo AI has its own setting:
admins only, members on tasks opened for them (the task's "AI tools for
members" switch; the default), or members on every task. Admins are
never limited by it.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from carve_api import config
from carve_api.auth.jwt import create_access_token
from carve_api.auth.models import User, UserRole
from carve_api.auth.passwords import hash_password
from carve_api.config import Settings, get_settings
from carve_api.deps import get_db
from carve_api.main import create_app
from carve_api.projects.models import Project, ProjectMember, Task, TaskKind


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
        email=f"{label}-{uuid.uuid4().hex[:6]}@access.example.com",
        password_hash=hash_password("x" * 12),
        role=role,
    )
    db_session.add(u)
    db_session.flush()
    return u


@pytest.fixture()
def modes(monkeypatch):
    """Set member modes through the environment, with no saved values."""
    monkeypatch.setattr(config, "_last_overrides", {})
    monkeypatch.setattr("carve_api.app_settings.service.read_overrides", lambda *a, **k: {})

    def set_(**env: str) -> None:
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        get_settings.cache_clear()

    yield set_
    get_settings.cache_clear()


@pytest.fixture()
def world(db_session) -> dict:
    admin = _user(db_session, "admin", UserRole.admin)
    member = _user(db_session, "member", UserRole.member)
    project = Project(name="Access", owner_id=admin.id)
    db_session.add(project)
    db_session.flush()
    db_session.add(ProjectMember(project_id=project.id, user_id=member.id, role="member"))
    task = Task(project_id=project.id, name="T", kind=TaskKind.image)
    db_session.add(task)
    db_session.flush()
    return {"admin": admin, "member": member, "task": task}


def _calls(c: TestClient, tid, hdr) -> dict[str, int]:
    """One route per tool; anything but 403 means it got past the gate."""
    return {
        "sam": c.post(
            f"/tasks/{tid}/sam/auto-text-batch",
            json={"class_ids": [str(uuid.uuid4())]},
            headers=hdr,
        ).status_code,
        "my_model": c.post(
            f"/tasks/{tid}/auto-annotate?weight_id={uuid.uuid4()}", headers=hdr
        ).status_code,
        "yoloe": c.post(
            f"/tasks/{tid}/yoloe/batch", json={"mode": "prompt_free", "params": {}}, headers=hdr
        ).status_code,
    }


def test_each_tool_follows_its_own_setting(db_session, world, modes) -> None:
    modes(MEMBERS_SAM="all_tasks", MEMBERS_MY_MODEL="admins", MEMBERS_YOLOE="opened_tasks")
    c = _client(db_session)
    task, member = world["task"], world["member"]

    got = _calls(c, task.id, _hdr(member))
    assert got["sam"] != 403 and got["my_model"] == 403 and got["yoloe"] == 403
    r = c.post(f"/tasks/{task.id}/auto-annotate?weight_id={uuid.uuid4()}", headers=_hdr(member))
    assert r.json() == {
        "error": "gpu_forbidden",
        "message": "My model is restricted to workspace admins.",
    }

    # Opening the task lets Smart Find through, not a tool set to admins only.
    task.gpu_access_for_members = True
    db_session.flush()
    got = _calls(c, task.id, _hdr(member))
    assert got["yoloe"] != 403 and got["my_model"] == 403

    # Admins are never limited.
    assert 403 not in _calls(c, task.id, _hdr(world["admin"])).values()


def test_the_default_keeps_the_task_switch(db_session, world, modes) -> None:
    modes()
    c = _client(db_session)
    assert set(_calls(c, world["task"].id, _hdr(world["member"])).values()) == {403}
    world["task"].gpu_access_for_members = True
    db_session.flush()
    assert 403 not in _calls(c, world["task"].id, _hdr(world["member"])).values()


def test_logo_ai_follows_the_older_switch_until_set(monkeypatch) -> None:
    base = {
        "POSTGRES_USER": "u",
        "POSTGRES_PASSWORD": "p",
        "POSTGRES_DB": "d",
        "JWT_SECRET": "j" * 64,
        "PASSWORD_PEPPER": "p" * 32,
        "MINIO_ROOT_USER": "u",
        "MINIO_ROOT_PASSWORD": "p",
    }
    assert Settings(**base).members_logo_ai == "admins"
    assert Settings(**base, LOGO_AI_ALLOW_MEMBERS=True).members_logo_ai == "opened_tasks"
    assert (
        Settings(**base, LOGO_AI_ALLOW_MEMBERS=True, MEMBERS_LOGO_AI="all_tasks").members_logo_ai
        == "all_tasks"
    )


def test_anyone_signed_in_can_read_the_modes(db_session, world, modes) -> None:
    modes(MEMBERS_YOLOE="all_tasks")
    r = _client(db_session).get("/workspace/ai-access", headers=_hdr(world["member"]))
    assert r.json() == {
        "sam": "opened_tasks",
        "my_model": "opened_tasks",
        "yoloe": "all_tasks",
        "logo_ai": "admins",
    }
