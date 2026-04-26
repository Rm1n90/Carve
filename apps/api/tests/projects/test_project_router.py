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
    pid = r.json()["id"]
    r = client.get("/projects", headers=_hdr(token))
    assert r.status_code == 200
    assert any(p["id"] == pid for p in r.json())


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
