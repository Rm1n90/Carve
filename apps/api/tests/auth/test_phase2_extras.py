"""Phase 2 endpoint coverage: /auth/members, /trash, soft-delete on /projects,
workspace /weights, and /models/sam-active.

These endpoints were added in the v2.0 UI redesign Phase 2 and have no other
test file yet. Grouped here to keep the new-test footprint compact.
"""
from fastapi.testclient import TestClient

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


def _bootstrap_admin(client) -> str:
    client.post(
        "/auth/register",
        json={"email": "admin@x.com", "password": "hunter22"},
    )
    return client.post(
        "/auth/login",
        json={"email": "admin@x.com", "password": "hunter22"},
    ).json()["access_token"]


def _create_member(client, admin_token: str, email: str) -> str:
    client.post(
        "/auth/register",
        json={"email": email, "password": "hunter22"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    return client.post(
        "/auth/login",
        json={"email": email, "password": "hunter22"},
    ).json()["access_token"]


# ----------------------------- /auth/members -----------------------------


def test_list_members_requires_auth(db_session) -> None:
    client = _client(db_session)
    r = client.get("/auth/members")
    assert r.status_code == 401


def test_list_members_returns_users(db_session) -> None:
    client = _client(db_session)
    admin = _bootstrap_admin(client)
    _create_member(client, admin, "alice@x.com")
    _create_member(client, admin, "bob@x.com")

    r = client.get("/auth/members", headers={"Authorization": f"Bearer {admin}"})
    assert r.status_code == 200
    emails = {u["email"] for u in r.json()}
    assert {"admin@x.com", "alice@x.com", "bob@x.com"} <= emails


def test_admin_can_change_member_role(db_session) -> None:
    client = _client(db_session)
    admin = _bootstrap_admin(client)
    _create_member(client, admin, "m@x.com")

    members = client.get(
        "/auth/members", headers={"Authorization": f"Bearer {admin}"}
    ).json()
    target = next(u for u in members if u["email"] == "m@x.com")

    r = client.patch(
        f"/auth/members/{target['id']}/role",
        json={"role": "viewer"},
        headers={"Authorization": f"Bearer {admin}"},
    )
    assert r.status_code == 200
    assert r.json()["role"] == "viewer"


def test_member_cannot_change_role(db_session) -> None:
    client = _client(db_session)
    admin = _bootstrap_admin(client)
    member_token = _create_member(client, admin, "m@x.com")

    members = client.get(
        "/auth/members", headers={"Authorization": f"Bearer {admin}"}
    ).json()
    target = next(u for u in members if u["email"] == "m@x.com")

    r = client.patch(
        f"/auth/members/{target['id']}/role",
        json={"role": "admin"},
        headers={"Authorization": f"Bearer {member_token}"},
    )
    assert r.status_code == 403


def test_cannot_demote_last_admin(db_session) -> None:
    client = _client(db_session)
    admin = _bootstrap_admin(client)

    me = client.get(
        "/auth/me", headers={"Authorization": f"Bearer {admin}"}
    ).json()

    r = client.patch(
        f"/auth/members/{me['id']}/role",
        json={"role": "member"},
        headers={"Authorization": f"Bearer {admin}"},
    )
    assert r.status_code == 409


# ------------------------- soft-delete projects -------------------------


def test_deleted_project_not_listed_by_default(db_session) -> None:
    client = _client(db_session)
    admin = _bootstrap_admin(client)
    headers = {"Authorization": f"Bearer {admin}"}

    p = client.post("/projects", json={"name": "P1"}, headers=headers).json()
    client.delete(f"/projects/{p['id']}", headers=headers)

    listed = client.get("/projects", headers=headers).json()
    assert all(x["id"] != p["id"] for x in listed)


def test_deleted_project_returned_with_include_deleted(db_session) -> None:
    client = _client(db_session)
    admin = _bootstrap_admin(client)
    headers = {"Authorization": f"Bearer {admin}"}

    p = client.post("/projects", json={"name": "P2"}, headers=headers).json()
    client.delete(f"/projects/{p['id']}", headers=headers)

    listed = client.get(
        "/projects", params={"include_deleted": "true"}, headers=headers
    ).json()
    assert any(x["id"] == p["id"] for x in listed)


def test_get_deleted_project_returns_404(db_session) -> None:
    client = _client(db_session)
    admin = _bootstrap_admin(client)
    headers = {"Authorization": f"Bearer {admin}"}

    p = client.post("/projects", json={"name": "P3"}, headers=headers).json()
    client.delete(f"/projects/{p['id']}", headers=headers)

    r = client.get(f"/projects/{p['id']}", headers=headers)
    assert r.status_code == 404


# ------------------------------ /trash ------------------------------


def test_trash_lists_deleted_project(db_session) -> None:
    client = _client(db_session)
    admin = _bootstrap_admin(client)
    headers = {"Authorization": f"Bearer {admin}"}

    p = client.post("/projects", json={"name": "ToTrash"}, headers=headers).json()
    client.delete(f"/projects/{p['id']}", headers=headers)

    r = client.get("/trash", headers=headers).json()
    matches = [i for i in r["items"] if i["id"] == p["id"]]
    assert len(matches) == 1
    assert matches[0]["kind"] == "project"
    assert matches[0]["name"] == "ToTrash"


def test_restore_brings_project_back(db_session) -> None:
    client = _client(db_session)
    admin = _bootstrap_admin(client)
    headers = {"Authorization": f"Bearer {admin}"}

    p = client.post("/projects", json={"name": "Restore"}, headers=headers).json()
    client.delete(f"/projects/{p['id']}", headers=headers)

    r = client.post(f"/trash/project/{p['id']}/restore", headers=headers)
    assert r.status_code == 204

    listed = client.get("/projects", headers=headers).json()
    assert any(x["id"] == p["id"] for x in listed)


def test_hard_delete_admin_only(db_session) -> None:
    client = _client(db_session)
    admin = _bootstrap_admin(client)
    member_token = _create_member(client, admin, "m@x.com")
    headers_admin = {"Authorization": f"Bearer {admin}"}
    headers_member = {"Authorization": f"Bearer {member_token}"}

    p = client.post("/projects", json={"name": "Hard"}, headers=headers_admin).json()
    client.delete(f"/projects/{p['id']}", headers=headers_admin)

    # Member can't hard-delete.
    r1 = client.delete(f"/trash/project/{p['id']}", headers=headers_member)
    assert r1.status_code == 403

    # Admin can.
    r2 = client.delete(f"/trash/project/{p['id']}", headers=headers_admin)
    assert r2.status_code == 204

    # Now even with include_deleted, the row is gone.
    listed = client.get(
        "/projects", params={"include_deleted": "true"}, headers=headers_admin
    ).json()
    assert all(x["id"] != p["id"] for x in listed)


# ---------------------------- /weights & /models ----------------------------


def test_workspace_weights_endpoint_returns_empty_for_fresh_workspace(db_session) -> None:
    client = _client(db_session)
    admin = _bootstrap_admin(client)

    r = client.get("/weights", headers={"Authorization": f"Bearer {admin}"})
    assert r.status_code == 200
    assert r.json() == []


def test_sam_active_endpoint_returns_active_and_available(db_session) -> None:
    client = _client(db_session)
    admin = _bootstrap_admin(client)

    r = client.get("/models/sam-active", headers={"Authorization": f"Bearer {admin}"})
    assert r.status_code == 200
    body = r.json()
    assert "active" in body
    assert isinstance(body["available"], list)
    assert len(body["available"]) >= 4
