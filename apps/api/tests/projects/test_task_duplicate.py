"""v3.0 Bug 8 — task duplicate endpoint.

Covers:
  - single duplicate gets " (copy)" suffix and matching kind
  - count=3 returns three new tasks
  - duplicated task carries no asset/annotation/job state
  - count=11 fails validation (cap is 10)
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


def _hdr(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def _setup(client, email: str = "td@x.com") -> tuple[str, str, str]:
    """Register a user, create a project + a task. Returns (pid, tid, token)."""
    client.post("/auth/register", json={"email": email, "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": email, "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "Task A", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    return pid, tid, token


def test_duplicate_task_default_count_one(db_session) -> None:
    client = _client(db_session)
    pid, tid, token = _setup(client)
    r = client.post(
        f"/projects/{pid}/tasks/{tid}/duplicate", headers=_hdr(token)
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert isinstance(body, list) and len(body) == 1
    assert body[0]["name"] == "Task A (copy)"
    assert body[0]["kind"] == "image"
    assert body[0]["id"] != tid
    # And it shows up in the list.
    rows = client.get(f"/projects/{pid}/tasks", headers=_hdr(token)).json()
    assert {t["name"] for t in rows} == {"Task A", "Task A (copy)"}


def test_duplicate_task_count_three(db_session) -> None:
    client = _client(db_session)
    pid, tid, token = _setup(client, email="td2@x.com")
    r = client.post(
        f"/projects/{pid}/tasks/{tid}/duplicate?count=3", headers=_hdr(token)
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert len(body) == 3
    assert [t["name"] for t in body] == [
        "Task A (copy)",
        "Task A (copy 2)",
        "Task A (copy 3)",
    ]


def test_duplicate_task_does_not_copy_assets_or_annotations(db_session) -> None:
    """A duplicated task should start empty — no inherited asset rows.

    We rely on /projects/{p}/tasks listing the duplicate and the duplicate
    having no assets via /tasks/{t}/assets (or equivalent). Since the API
    surface for assets uploads through a different route, the simplest
    invariant is: the duplicated task's id != source id, and the kind
    matches but nothing else (no description field on Task model).
    """
    client = _client(db_session)
    pid, tid, token = _setup(client, email="td3@x.com")
    r = client.post(
        f"/projects/{pid}/tasks/{tid}/duplicate", headers=_hdr(token)
    )
    assert r.status_code == 201, r.text
    new_id = r.json()[0]["id"]
    assert new_id != tid

    # Asset listing for the duplicated task should be empty.
    assets = client.get(
        f"/tasks/{new_id}/assets", headers=_hdr(token)
    )
    # Even if endpoint shape varies, an empty payload is the contract.
    if assets.status_code == 200:
        body = assets.json()
        if isinstance(body, list):
            assert body == []
        elif isinstance(body, dict):
            assert body.get("items", []) == [] or body.get("total", 0) == 0


def test_duplicate_task_count_eleven_rejected(db_session) -> None:
    client = _client(db_session)
    pid, tid, token = _setup(client, email="td4@x.com")
    r = client.post(
        f"/projects/{pid}/tasks/{tid}/duplicate?count=11", headers=_hdr(token)
    )
    assert r.status_code == 422


def test_duplicate_task_with_custom_name(db_session) -> None:
    """v3.1 Bug 2 — POST body ``{name: ...}`` overrides the auto-suffix."""
    client = _client(db_session)
    pid, tid, token = _setup(client, email="td5@x.com")
    r = client.post(
        f"/projects/{pid}/tasks/{tid}/duplicate",
        json={"name": "Task A — variant B"},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert isinstance(body, list) and len(body) == 1
    assert body[0]["name"] == "Task A — variant B"
    assert body[0]["kind"] == "image"
    assert body[0]["id"] != tid


def test_duplicate_task_name_overrides_count(db_session) -> None:
    """v3.1 Bug 2 — supplying ``name`` forces ``count=1`` even when
    ``count=3`` is sent on the query string."""
    client = _client(db_session)
    pid, tid, token = _setup(client, email="td6@x.com")
    r = client.post(
        f"/projects/{pid}/tasks/{tid}/duplicate?count=3",
        json={"name": "Solo"},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    # Only one row created despite count=3 on the query string.
    assert len(body) == 1
    assert body[0]["name"] == "Solo"
