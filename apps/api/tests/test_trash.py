"""Regression tests for ``GET /trash`` — two same-named tasks in the
same project must both appear when both are soft-deleted.

A user reported deleting two tasks both named ``task2`` and finding
only one of them in the trash UI. The frontend renders the list keyed
by ``${kind}-${id}`` so two distinct task rows would render
independently — so the bug, if any, has to be in the API response
itself. These tests pin the contract and would have caught a silent
dedup-by-name regression."""

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


def _hdr(t):
    return {"Authorization": f"Bearer {t}"}


def _setup(client):
    client.post(
        "/auth/register", json={"email": "trash@x.com", "password": "hunter22"},
    )
    token = client.post(
        "/auth/login",
        json={"email": "trash@x.com", "password": "hunter22"},
    ).json()["access_token"]
    pid = client.post(
        "/projects", json={"name": "P"}, headers=_hdr(token),
    ).json()["id"]
    return token, pid


def test_trash_lists_two_same_named_deleted_tasks(db_session) -> None:
    """Both soft-deleted task rows show up with distinct ids even when
    their ``name`` collides."""
    client = _client(db_session)
    token, pid = _setup(client)

    t1 = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "task2", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    t2 = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "task2", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    assert t1 != t2

    client.delete(f"/projects/{pid}/tasks/{t1}", headers=_hdr(token))
    client.delete(f"/projects/{pid}/tasks/{t2}", headers=_hdr(token))

    r = client.get("/trash", headers=_hdr(token))
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    task_items = [i for i in items if i["kind"] == "task" and i["name"] == "task2"]
    assert len(task_items) == 2, (
        "expected both same-named tasks to appear in trash, "
        f"got {len(task_items)}: {task_items}"
    )
    ids = {i["id"] for i in task_items}
    assert ids == {t1, t2}


def test_trash_distinguishes_tasks_by_id(db_session) -> None:
    """Restoring one of two same-named deleted tasks must leave the
    other one in trash (proves they're independent rows)."""
    client = _client(db_session)
    token, pid = _setup(client)

    t1 = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "task2", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    t2 = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "task2", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    client.delete(f"/projects/{pid}/tasks/{t1}", headers=_hdr(token))
    client.delete(f"/projects/{pid}/tasks/{t2}", headers=_hdr(token))

    # Restore only t1.
    r = client.post(f"/trash/task/{t1}/restore", headers=_hdr(token))
    assert r.status_code == 204, r.text

    r = client.get("/trash", headers=_hdr(token))
    items = r.json()["items"]
    task_items = [i for i in items if i["kind"] == "task" and i["name"] == "task2"]
    assert len(task_items) == 1
    assert task_items[0]["id"] == t2
