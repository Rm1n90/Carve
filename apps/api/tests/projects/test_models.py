import uuid

import pytest
from sqlalchemy.exc import IntegrityError

from vaa_api.auth.models import User, UserRole
from vaa_api.projects.models import Class, Project, Task, TaskKind


def test_project_task_class_create(db_session) -> None:
    user = User(email="o@x.com", password_hash="x", role=UserRole.admin)
    db_session.add(user)
    db_session.flush()

    p = Project(name="Proj", description="d", owner_id=user.id)
    db_session.add(p)
    db_session.flush()
    assert p.id is not None
    assert p.created_at is not None

    t = Task(project_id=p.id, name="T1", kind=TaskKind.image)
    db_session.add(t)
    db_session.flush()
    assert t.id is not None

    c = Class(project_id=p.id, idx=0, name="car", color="#ff0000")
    db_session.add(c)
    db_session.flush()
    assert c.id is not None


def test_class_idx_unique_within_project(db_session) -> None:
    user = User(email="o2@x.com", password_hash="x", role=UserRole.admin)
    db_session.add(user)
    db_session.flush()
    p = Project(name="Proj2", owner_id=user.id)
    db_session.add(p)
    db_session.flush()
    db_session.add(Class(project_id=p.id, idx=0, name="a", color="#000000"))
    db_session.flush()
    with pytest.raises(IntegrityError):
        db_session.add(Class(project_id=p.id, idx=0, name="b", color="#111111"))
        db_session.flush()


def test_task_kind_enum_values() -> None:
    assert {k.value for k in TaskKind} == {"image", "video"}
