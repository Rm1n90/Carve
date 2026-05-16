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


# ---------------------------------------------------------------------------
# Service-layer tests (Task 3)
# ---------------------------------------------------------------------------
from carve_api.projects.keybindings import (
    EffectiveBinding,
    compose_effective_bindings,
    set_binding,
    delete_binding,
)


def test_compose_empty_returns_seed_of_first_nine(
    db_session, fixture_project_with_classes,
):
    """No stored rows + 3 classes → 3 seed rows in idx order."""
    user, project, classes = fixture_project_with_classes
    result = compose_effective_bindings(
        db_session, user_id=user.id, project_id=project.id,
    )
    assert result == [
        EffectiveBinding(digit=1, class_id=classes[0].id, source="seed"),
        EffectiveBinding(digit=2, class_id=classes[1].id, source="seed"),
        EffectiveBinding(digit=3, class_id=classes[2].id, source="seed"),
    ]


def test_compose_stored_takes_precedence(
    db_session, fixture_project_with_classes,
):
    user, project, classes = fixture_project_with_classes
    # Bind class[2] to digit 1 explicitly; seed would have given c[0].
    db_session.add(ClassKeybinding(
        user_id=user.id, project_id=project.id,
        digit=1, class_id=classes[2].id,
    ))
    db_session.commit()
    result = compose_effective_bindings(
        db_session, user_id=user.id, project_id=project.id,
    )
    by_digit = {b.digit: b for b in result}
    assert by_digit[1].class_id == classes[2].id
    assert by_digit[1].source == "stored"
    # classes[2] is taken by the stored row → seed must skip it on
    # other digits. The remaining seed slots get classes[0] and [1].
    assert by_digit[2].class_id == classes[0].id
    assert by_digit[2].source == "seed"
    assert by_digit[3].class_id == classes[1].id


def test_set_binding_creates(db_session, fixture_project_with_classes):
    user, project, classes = fixture_project_with_classes
    set_binding(
        db_session,
        user_id=user.id,
        project_id=project.id,
        digit=4,
        class_id=classes[0].id,
    )
    db_session.commit()
    rows = db_session.query(ClassKeybinding).all()
    assert len(rows) == 1
    assert rows[0].digit == 4
    assert rows[0].class_id == classes[0].id


def test_set_binding_moves_existing_class(
    db_session, fixture_project_with_classes,
):
    """Re-binding a class to a different digit must DELETE its old row
    in the same transaction (UNIQUE-driven move-not-duplicate)."""
    user, project, classes = fixture_project_with_classes
    set_binding(
        db_session, user_id=user.id, project_id=project.id,
        digit=1, class_id=classes[0].id,
    )
    db_session.commit()
    set_binding(
        db_session, user_id=user.id, project_id=project.id,
        digit=5, class_id=classes[0].id,
    )
    db_session.commit()
    rows = db_session.query(ClassKeybinding).all()
    assert len(rows) == 1
    assert rows[0].digit == 5


def test_set_binding_overwrites_existing_digit(
    db_session, fixture_project_with_classes,
):
    """Re-binding a digit to a different class replaces the row."""
    user, project, classes = fixture_project_with_classes
    set_binding(
        db_session, user_id=user.id, project_id=project.id,
        digit=1, class_id=classes[0].id,
    )
    db_session.commit()
    set_binding(
        db_session, user_id=user.id, project_id=project.id,
        digit=1, class_id=classes[1].id,
    )
    db_session.commit()
    rows = db_session.query(ClassKeybinding).all()
    assert len(rows) == 1
    assert rows[0].class_id == classes[1].id


def test_delete_binding_removes_row(
    db_session, fixture_project_with_classes,
):
    user, project, classes = fixture_project_with_classes
    set_binding(
        db_session, user_id=user.id, project_id=project.id,
        digit=1, class_id=classes[0].id,
    )
    db_session.commit()
    delete_binding(
        db_session, user_id=user.id, project_id=project.id, digit=1,
    )
    db_session.commit()
    assert db_session.query(ClassKeybinding).count() == 0


def test_delete_binding_idempotent(
    db_session, fixture_project_with_classes,
):
    user, project, _ = fixture_project_with_classes
    delete_binding(
        db_session, user_id=user.id, project_id=project.id, digit=7,
    )
    # No row existed; no error.
    db_session.commit()
