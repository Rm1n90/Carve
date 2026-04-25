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


def _hdr(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def _setup(client) -> tuple[str, str]:
    client.post("/auth/register", json={"email": "cl@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "cl@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post("/projects", json={"name": "C"}, headers=_hdr(token)).json()["id"]
    return pid, token


def test_create_class(db_session) -> None:
    client = _client(db_session)
    pid, token = _setup(client)
    r = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "car", "color": "#ff0000"},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["idx"] == 0
    assert body["name"] == "car"


def test_list_classes_in_idx_order(db_session) -> None:
    client = _client(db_session)
    pid, token = _setup(client)
    client.post(
        f"/projects/{pid}/classes",
        json={"idx": 1, "name": "b", "color": "#000000"},
        headers=_hdr(token),
    )
    client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "a", "color": "#111111"},
        headers=_hdr(token),
    )
    r = client.get(f"/projects/{pid}/classes", headers=_hdr(token))
    rows = r.json()
    assert [c["idx"] for c in rows] == [0, 1]


def test_class_idx_uniqueness_returns_409(db_session) -> None:
    client = _client(db_session)
    pid, token = _setup(client)
    client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "a", "color": "#111111"},
        headers=_hdr(token),
    )
    r = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "z", "color": "#222222"},
        headers=_hdr(token),
    )
    assert r.status_code == 409


def test_color_validated(db_session) -> None:
    client = _client(db_session)
    pid, token = _setup(client)
    r = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "x", "color": "not-a-hex"},
        headers=_hdr(token),
    )
    assert r.status_code == 422


def test_patch_and_delete_class(db_session) -> None:
    client = _client(db_session)
    pid, token = _setup(client)
    r = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "old", "color": "#000000"},
        headers=_hdr(token),
    )
    cid = r.json()["id"]
    r = client.patch(
        f"/projects/{pid}/classes/{cid}",
        json={"name": "new", "color": "#abcdef"},
        headers=_hdr(token),
    )
    assert r.status_code == 200
    assert r.json()["name"] == "new"
    r = client.delete(f"/projects/{pid}/classes/{cid}", headers=_hdr(token))
    assert r.status_code == 204
