"""Tests for the class_keybindings table + service + router."""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy.exc import IntegrityError

from carve_api.projects.models import Class, ClassKeybinding, Project
from carve_api.auth.models import User, UserRole


@pytest.fixture
def fixture_project_with_classes(db_session):
    """Builds a User, a Project, and 3 Class rows. Returns the triplet."""
    user = User(
        id=uuid.uuid4(), email="t@test.com", password_hash="x",
        role=UserRole.member,
    )
    project = Project(id=uuid.uuid4(), name="P", owner_id=user.id)
    db_session.add_all([user, project])
    db_session.flush()
    classes = [
        Class(
            id=uuid.uuid4(), project_id=project.id,
            idx=i, name=f"c{i}", color="#abcdef",
        )
        for i in range(3)
    ]
    db_session.add_all(classes)
    db_session.commit()
    return user, project, classes


def test_class_keybinding_persists(db_session, fixture_project_with_classes):
    user, project, classes = fixture_project_with_classes
    db_session.add(ClassKeybinding(
        user_id=user.id, project_id=project.id,
        digit=1, class_id=classes[0].id,
    ))
    db_session.commit()
    rows = db_session.query(ClassKeybinding).all()
    assert len(rows) == 1
    assert rows[0].digit == 1


def test_unique_class_per_user_project(
    db_session, fixture_project_with_classes,
):
    """The UNIQUE (user, project, class_id) constraint forbids binding
    the same class to two digits — that's the "one digit per class"
    contract from the spec."""
    user, project, classes = fixture_project_with_classes
    db_session.add(ClassKeybinding(
        user_id=user.id, project_id=project.id,
        digit=1, class_id=classes[0].id,
    ))
    db_session.commit()
    db_session.add(ClassKeybinding(
        user_id=user.id, project_id=project.id,
        digit=2, class_id=classes[0].id,
    ))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_digit_range_check(db_session, fixture_project_with_classes):
    user, project, classes = fixture_project_with_classes
    db_session.add(ClassKeybinding(
        user_id=user.id, project_id=project.id,
        digit=10, class_id=classes[0].id,
    ))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_class_delete_cascades(db_session, fixture_project_with_classes):
    user, project, classes = fixture_project_with_classes
    db_session.add(ClassKeybinding(
        user_id=user.id, project_id=project.id,
        digit=1, class_id=classes[0].id,
    ))
    db_session.commit()
    db_session.delete(classes[0])
    db_session.commit()
    assert db_session.query(ClassKeybinding).count() == 0
