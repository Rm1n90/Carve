import uuid

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


def _login(client, email, password) -> str:
    return client.post(
        "/auth/login", json={"email": email, "password": password}
    ).json()["access_token"]


def _hdr(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_create_project_requires_auth(db_session) -> None:
    client = _client(db_session)
    r = client.post("/projects", json={"name": "P"})
    assert r.status_code == 401


def test_create_and_list_project(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "u@x.com", "password": "hunter22"})
    token = _login(client, "u@x.com", "hunter22")
    r = client.post("/projects", json={"name": "P1"}, headers=_hdr(token))
    assert r.status_code == 201
    body = r.json()
    pid = body["id"]
    # v3.3 Issue 2 — POST response must include owner_email.
    assert body.get("owner_email") == "u@x.com"
    r = client.get("/projects", headers=_hdr(token))
    assert r.status_code == 200
    listed = r.json()
    assert any(p["id"] == pid for p in listed)
    # v3.3 Issue 2 — every list-projects row must include owner_email.
    for p in listed:
        assert "owner_email" in p


def test_get_project_returns_owner_email(db_session) -> None:
    """v3.3 Issue 2 — GET /projects/{id} populates owner_email via JOIN."""
    client = _client(db_session)
    client.post(
        "/auth/register", json={"email": "owner-meta@x.com", "password": "hunter22"}
    )
    token = _login(client, "owner-meta@x.com", "hunter22")
    pid = client.post(
        "/projects", json={"name": "Meta"}, headers=_hdr(token)
    ).json()["id"]
    r = client.get(f"/projects/{pid}", headers=_hdr(token))
    assert r.status_code == 200
    body = r.json()
    assert body["owner_email"] == "owner-meta@x.com"
    assert "created_at" in body


def test_get_404(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "u2@x.com", "password": "hunter22"})
    token = _login(client, "u2@x.com", "hunter22")
    r = client.get(f"/projects/{uuid.uuid4()}", headers=_hdr(token))
    assert r.status_code == 404


def test_patch_only_by_owner(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "owner@x.com", "password": "hunter22"})
    owner = _login(client, "owner@x.com", "hunter22")
    client.post(
        "/auth/register",
        json={"email": "intruder@x.com", "password": "hunter22"},
        headers=_hdr(owner),
    )
    intruder = _login(client, "intruder@x.com", "hunter22")
    pid = client.post("/projects", json={"name": "Mine"}, headers=_hdr(owner)).json()["id"]
    r = client.patch(f"/projects/{pid}", json={"name": "stolen"}, headers=_hdr(intruder))
    assert r.status_code == 403
    r = client.patch(f"/projects/{pid}", json={"name": "renamed"}, headers=_hdr(owner))
    assert r.status_code == 200
    assert r.json()["name"] == "renamed"


def test_delete_only_by_owner(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "od@x.com", "password": "hunter22"})
    owner = _login(client, "od@x.com", "hunter22")
    client.post(
        "/auth/register",
        json={"email": "ot@x.com", "password": "hunter22"},
        headers=_hdr(owner),
    )
    other = _login(client, "ot@x.com", "hunter22")
    pid = client.post("/projects", json={"name": "D"}, headers=_hdr(owner)).json()["id"]
    r = client.delete(f"/projects/{pid}", headers=_hdr(other))
    assert r.status_code == 403
    r = client.delete(f"/projects/{pid}", headers=_hdr(owner))
    assert r.status_code == 204
