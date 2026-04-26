import uuid

import pytest

from carve_api.auth.models import User, UserRole
from carve_api.projects.models import Project
from carve_api.projects.service import (
    NotProjectOwner,
    ProjectNotFound,
    ProjectService,
)


def _user(db, email: str, role: UserRole = UserRole.member) -> User:
    u = User(email=email, password_hash="x", role=role)
    db.add(u)
    db.flush()
    return u


def test_create_project(db_session) -> None:
    owner = _user(db_session, "o@x.com")
    svc = ProjectService(db_session)
    p = svc.create(actor=owner, name="P1", description="hello")
    assert p.name == "P1"
    assert p.owner_id == owner.id


def test_list_returns_all_projects(db_session) -> None:
    db_session.query(Project).delete()
    a = _user(db_session, "a@x.com")
    b = _user(db_session, "b@x.com")
    svc = ProjectService(db_session)
    svc.create(actor=a, name="A1")
    svc.create(actor=b, name="B1")
    rows = svc.list_visible(actor=a)
    assert {r.name for r in rows} == {"A1", "B1"}


def test_get_returns_project(db_session) -> None:
    o = _user(db_session, "o3@x.com")
    svc = ProjectService(db_session)
    p = svc.create(actor=o, name="G1")
    assert svc.get(actor=o, project_id=p.id).id == p.id


def test_get_unknown_raises(db_session) -> None:
    o = _user(db_session, "o4@x.com")
    svc = ProjectService(db_session)
    with pytest.raises(ProjectNotFound):
        svc.get(actor=o, project_id=uuid.uuid4())


def test_update_only_owner(db_session) -> None:
    o = _user(db_session, "o5@x.com")
    intruder = _user(db_session, "in@x.com")
    svc = ProjectService(db_session)
    p = svc.create(actor=o, name="X")
    with pytest.raises(NotProjectOwner):
        svc.update(actor=intruder, project_id=p.id, name="Hacked")
    updated = svc.update(actor=o, project_id=p.id, name="Renamed")
    assert updated.name == "Renamed"


def test_admin_can_edit_any(db_session) -> None:
    boss = _user(db_session, "boss@x.com", role=UserRole.admin)
    member = _user(db_session, "m@x.com")
    svc = ProjectService(db_session)
    p = svc.create(actor=member, name="M1")
    assert svc.update(actor=boss, project_id=p.id, name="Edit").name == "Edit"


def test_delete_only_owner_or_admin(db_session) -> None:
    o = _user(db_session, "od@x.com")
    other = _user(db_session, "ot@x.com")
    svc = ProjectService(db_session)
    p = svc.create(actor=o, name="D1")
    with pytest.raises(NotProjectOwner):
        svc.delete(actor=other, project_id=p.id)
    svc.delete(actor=o, project_id=p.id)
    with pytest.raises(ProjectNotFound):
        svc.get(actor=o, project_id=p.id)
