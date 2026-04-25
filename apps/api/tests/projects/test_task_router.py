from fastapi.testclient import TestClient

from vaa_api.deps import get_db
from vaa_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _login(client, email, pw) -> str:
    return client.post("/auth/login", json={"email": email, "password": pw}).json()[
        "access_token"
    ]


def _hdr(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def _new_project(client, token: str, name: str = "P") -> str:
    return client.post("/projects", json={"name": name}, headers=_hdr(token)).json()["id"]


def test_create_task(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "tk@x.com", "password": "hunter22"})
    token = _login(client, "tk@x.com", "hunter22")
    pid = _new_project(client, token)
    r = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "Task A", "kind": "image"},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    assert r.json()["kind"] == "image"


def test_list_tasks_for_project(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "tk2@x.com", "password": "hunter22"})
    token = _login(client, "tk2@x.com", "hunter22")
    pid = _new_project(client, token)
    client.post(f"/projects/{pid}/tasks", json={"name": "T1", "kind": "image"}, headers=_hdr(token))
    client.post(f"/projects/{pid}/tasks", json={"name": "T2", "kind": "video"}, headers=_hdr(token))
    r = client.get(f"/projects/{pid}/tasks", headers=_hdr(token))
    assert r.status_code == 200
    assert {t["name"] for t in r.json()} == {"T1", "T2"}


def test_delete_task_only_owner(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "to@x.com", "password": "hunter22"})
    client.post("/auth/register", json={"email": "to2@x.com", "password": "hunter22"})
    owner = _login(client, "to@x.com", "hunter22")
    other = _login(client, "to2@x.com", "hunter22")
    pid = _new_project(client, owner)
    r = client.post(
        f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(owner)
    )
    tid = r.json()["id"]
    r = client.delete(f"/projects/{pid}/tasks/{tid}", headers=_hdr(other))
    assert r.status_code == 403
    r = client.delete(f"/projects/{pid}/tasks/{tid}", headers=_hdr(owner))
    assert r.status_code == 204


def test_task_kind_validated(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "tv@x.com", "password": "hunter22"})
    token = _login(client, "tv@x.com", "hunter22")
    pid = _new_project(client, token, name="V")
    r = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "X", "kind": "bogus"},
        headers=_hdr(token),
    )
    assert r.status_code == 422
