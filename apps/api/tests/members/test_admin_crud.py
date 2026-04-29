"""Bug 14 — admin member CRUD endpoints.

Covers POST /auth/members and DELETE /auth/members/{user_id}:

- Admin creates a member -> 201
- Admin can mint another admin (role override)
- Member tries to create -> 403
- Email collision -> 409
- Admin deletes member -> 204; subsequent GET excludes them; login fails
- Admin deletes self -> 400 cannot_delete_self
- Last-admin guard: deleting the sole admin via self-delete returns 400
- Member tries to delete -> 403
- Delete unknown user -> 404

Pattern matches tests/auth/test_phase2_extras.py: TestClient with the shared
``db_session`` fixture overriding ``get_db``.
"""
from fastapi.testclient import TestClient

from carve_api.auth.models import User
from carve_api.deps import get_db
from carve_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _bootstrap_admin(client: TestClient) -> str:
    client.post(
        "/auth/register",
        json={"email": "admin@x.com", "password": "hunter22"},
    )
    return client.post(
        "/auth/login",
        json={"email": "admin@x.com", "password": "hunter22"},
    ).json()["access_token"]


def _login_token(client: TestClient, email: str, password: str) -> str:
    return client.post(
        "/auth/login", json={"email": email, "password": password}
    ).json()["access_token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# --------------------------- POST /auth/members ---------------------------


def test_admin_creates_member(db_session) -> None:
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    admin = _bootstrap_admin(client)

    r = client.post(
        "/auth/members",
        json={"email": "alice@x.com", "password": "hunter22", "role": "member"},
        headers=_auth(admin),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["email"] == "alice@x.com"
    assert body["role"] == "member"

    login = client.post(
        "/auth/login", json={"email": "alice@x.com", "password": "hunter22"}
    )
    assert login.status_code == 200


def test_admin_creates_admin_member(db_session) -> None:
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    admin = _bootstrap_admin(client)

    r = client.post(
        "/auth/members",
        json={"email": "boss2@x.com", "password": "hunter22", "role": "admin"},
        headers=_auth(admin),
    )
    assert r.status_code == 201
    assert r.json()["role"] == "admin"


def test_member_cannot_create_member(db_session) -> None:
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    admin = _bootstrap_admin(client)
    client.post(
        "/auth/members",
        json={"email": "staff@x.com", "password": "hunter22", "role": "member"},
        headers=_auth(admin),
    )
    staff = _login_token(client, "staff@x.com", "hunter22")

    r = client.post(
        "/auth/members",
        json={"email": "interloper@x.com", "password": "hunter22", "role": "member"},
        headers=_auth(staff),
    )
    assert r.status_code == 403


def test_email_collision_returns_409(db_session) -> None:
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    admin = _bootstrap_admin(client)
    client.post(
        "/auth/members",
        json={"email": "dup@x.com", "password": "hunter22", "role": "member"},
        headers=_auth(admin),
    )

    r = client.post(
        "/auth/members",
        json={"email": "dup@x.com", "password": "another1", "role": "member"},
        headers=_auth(admin),
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "email_taken"


# ---------------------- DELETE /auth/members/{user_id} ----------------------


def test_admin_deletes_member(db_session) -> None:
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    admin = _bootstrap_admin(client)
    created = client.post(
        "/auth/members",
        json={"email": "gone@x.com", "password": "hunter22", "role": "member"},
        headers=_auth(admin),
    ).json()

    r = client.delete(
        f"/auth/members/{created['id']}", headers=_auth(admin)
    )
    assert r.status_code == 204

    listed = client.get("/auth/members", headers=_auth(admin)).json()
    assert all(m["email"] != "gone@x.com" for m in listed)

    relog = client.post(
        "/auth/login", json={"email": "gone@x.com", "password": "hunter22"}
    )
    assert relog.status_code == 401


def test_admin_cannot_delete_self(db_session) -> None:
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    admin = _bootstrap_admin(client)
    me = client.get("/auth/me", headers=_auth(admin)).json()

    r = client.delete(f"/auth/members/{me['id']}", headers=_auth(admin))
    assert r.status_code == 400
    assert r.json()["detail"] == "cannot_delete_self"


def test_cannot_delete_last_admin_via_self_delete(db_session) -> None:
    """The audit's "delete last admin -> 400" requirement is enforced by
    two cooperating guards in delete_member:

      1. ``cannot_delete_self`` blocks an admin from deleting themselves.
      2. ``cannot_delete_last_admin`` blocks deleting any admin row when
         it's the only active admin in the workspace.

    With only one admin in the workspace, the only API caller who could
    target that admin row IS that admin (others can't bypass the admin
    dependency). So in practice the (1) self-delete path fires first.
    This test pins the combined contract: a sole admin cannot be removed
    via the API regardless of which guard fires first.
    """
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    admin = _bootstrap_admin(client)
    me = client.get("/auth/me", headers=_auth(admin)).json()

    r = client.delete(f"/auth/members/{me['id']}", headers=_auth(admin))
    assert r.status_code == 400
    assert r.json()["detail"] in {"cannot_delete_self", "cannot_delete_last_admin"}

    # Member also remains; admin still exists (not soft-deleted).
    listed = client.get("/auth/members", headers=_auth(admin)).json()
    assert any(m["email"] == "admin@x.com" for m in listed)


def test_member_cannot_delete(db_session) -> None:
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    admin = _bootstrap_admin(client)
    target = client.post(
        "/auth/members",
        json={"email": "victim@x.com", "password": "hunter22", "role": "member"},
        headers=_auth(admin),
    ).json()
    client.post(
        "/auth/members",
        json={"email": "attacker@x.com", "password": "hunter22", "role": "member"},
        headers=_auth(admin),
    )
    attacker = _login_token(client, "attacker@x.com", "hunter22")

    r = client.delete(
        f"/auth/members/{target['id']}", headers=_auth(attacker)
    )
    assert r.status_code == 403


def test_delete_404_for_unknown_user(db_session) -> None:
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    admin = _bootstrap_admin(client)

    r = client.delete(
        "/auth/members/00000000-0000-0000-0000-000000000000",
        headers=_auth(admin),
    )
    assert r.status_code == 404
