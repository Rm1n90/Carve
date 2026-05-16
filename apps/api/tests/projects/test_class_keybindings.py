"""Tests for the class_keybindings table + service + router."""
from __future__ import annotations

import uuid
import uuid as _uuid_lib

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from carve_api.auth.models import User, UserRole
from carve_api.deps import get_db
from carve_api.main import create_app
from carve_api.projects.models import Class, ClassKeybinding, Project


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


# ---------------------------------------------------------------------------
# Router tests (Task 4)
# ---------------------------------------------------------------------------


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _login(client, email, password) -> str:
    return client.post(
        "/auth/login", json={"email": email, "password": password},
    ).json()["access_token"]


def _hdr(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _register_and_login(client, password: str = "hunter22") -> tuple[str, str]:
    """Returns (email, token)."""
    email = f"u-{_uuid_lib.uuid4()}@x.com"
    client.post("/auth/register", json={"email": email, "password": password})
    token = _login(client, email, password)
    return email, token


def _create_project(client, token: str, name: str = "P") -> str:
    """Returns project_id (string)."""
    r = client.post("/projects", json={"name": name}, headers=_hdr(token))
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _seed_classes(db_session, project_id: str, num: int) -> list[Class]:
    rows = [
        Class(
            id=_uuid_lib.uuid4(),
            project_id=_uuid_lib.UUID(project_id),
            idx=i,
            name=f"c{i}-{_uuid_lib.uuid4().hex[:6]}",
            color="#abcdef",
        )
        for i in range(num)
    ]
    db_session.add_all(rows)
    db_session.commit()
    return rows


def test_get_returns_seed_when_empty(db_session) -> None:
    client = _client(db_session)
    _, token = _register_and_login(client)
    pid = _create_project(client, token)
    classes = _seed_classes(db_session, pid, num=3)
    r = client.get(f"/projects/{pid}/class-keybindings", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {
        "bindings": [
            {"digit": 1, "class_id": str(classes[0].id), "source": "seed"},
            {"digit": 2, "class_id": str(classes[1].id), "source": "seed"},
            {"digit": 3, "class_id": str(classes[2].id), "source": "seed"},
        ]
    }


def test_put_creates_binding(db_session) -> None:
    client = _client(db_session)
    _, token = _register_and_login(client)
    pid = _create_project(client, token)
    classes = _seed_classes(db_session, pid, num=2)
    r = client.put(
        f"/projects/{pid}/class-keybindings/1",
        json={"class_id": str(classes[1].id)},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    assert r.json() == {
        "digit": 1, "class_id": str(classes[1].id), "source": "stored",
    }


def test_put_invalid_digit_returns_422(db_session) -> None:
    client = _client(db_session)
    _, token = _register_and_login(client)
    pid = _create_project(client, token)
    classes = _seed_classes(db_session, pid, num=1)
    for bad in ("0", "10", "x"):
        r = client.put(
            f"/projects/{pid}/class-keybindings/{bad}",
            json={"class_id": str(classes[0].id)},
            headers=_hdr(token),
        )
        assert r.status_code == 422, (bad, r.text)


def test_put_class_outside_project_returns_422(db_session) -> None:
    client = _client(db_session)
    _, token = _register_and_login(client)
    pid_a = _create_project(client, token, name="A")
    pid_b = _create_project(client, token, name="B")
    _ = _seed_classes(db_session, pid_a, num=1)
    classes_b = _seed_classes(db_session, pid_b, num=1)
    r = client.put(
        f"/projects/{pid_a}/class-keybindings/1",
        json={"class_id": str(classes_b[0].id)},
        headers=_hdr(token),
    )
    assert r.status_code == 422
    assert r.json()["error"] == "class_not_in_project"


def test_delete_clears_binding(db_session) -> None:
    client = _client(db_session)
    _, token = _register_and_login(client)
    pid = _create_project(client, token)
    classes = _seed_classes(db_session, pid, num=2)
    client.put(
        f"/projects/{pid}/class-keybindings/3",
        json={"class_id": str(classes[0].id)},
        headers=_hdr(token),
    )
    r = client.delete(
        f"/projects/{pid}/class-keybindings/3", headers=_hdr(token),
    )
    assert r.status_code == 204


def test_delete_idempotent(db_session) -> None:
    client = _client(db_session)
    _, token = _register_and_login(client)
    pid = _create_project(client, token)
    _seed_classes(db_session, pid, num=1)
    r = client.delete(
        f"/projects/{pid}/class-keybindings/7", headers=_hdr(token),
    )
    assert r.status_code == 204
