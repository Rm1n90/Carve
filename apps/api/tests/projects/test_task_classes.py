"""v3.1 Issue 3 (Option A: subset model) — task-scoped classes.

Covers GET/PUT ``/projects/{p}/tasks/{t}/classes``:
  - GET on a freshly-created task returns the snapshot of project
    classes at creation time (v3.2 Issue 3)
  - GET with NULL subset returns all project classes (legacy fallback;
    preserved for back-compat with rows existing before the 0014
    migration ran)
  - GET with a subset returns only that subset
  - PUT subset (admin/owner) succeeds; GET reflects the new state
  - PUT empty array is allowed (zero classes for the task)
  - PUT clears the subset back to "all" via ``null``
  - PUT validates that ids belong to the same project (422 otherwise)
  - Non-admin / non-owner caller gets 403

v3.2 Issue 3 — ``TaskService.create`` now snapshots the project's
current class ids onto the new task. New classes added to the project
after task creation no longer auto-appear in existing tasks.
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


def _register(client: TestClient, email: str) -> str:
    client.post("/auth/register", json={"email": email, "password": "hunter22"})
    return client.post(
        "/auth/login", json={"email": email, "password": "hunter22"}
    ).json()["access_token"]


def _setup(
    client: TestClient, email: str = "tc@x.com"
) -> tuple[str, str, str, list[str]]:
    """Register a user, create a project + 3 classes, then a task.

    v3.2 Issue 3 — classes are created *before* the task so the new
    task's auto-snapshotted ``allowed_class_ids`` reflects all 3 ids.
    Returns ``(project_id, task_id, token, [class_id, ...])``.
    """
    token = _register(client, email)
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()[
        "id"
    ]
    class_ids: list[str] = []
    for i, name in enumerate(["alpha", "beta", "gamma"]):
        cid = client.post(
            f"/projects/{pid}/classes",
            json={
                "idx": i,
                "name": name,
                "color": "#ff0000",
                "attributes": {},
            },
            headers=_hdr(token),
        ).json()["id"]
        class_ids.append(cid)
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "Task A", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    return pid, tid, token, class_ids


def test_get_task_classes_returns_snapshot_at_creation(db_session) -> None:
    """v3.2 Issue 3 — fresh task is created with a snapshot of the
    project's current class ids (not NULL). The effective list and the
    raw ``allowed_class_ids`` both reflect that snapshot."""
    client = _client(db_session)
    pid, tid, token, class_ids = _setup(client, email="tc1@x.com")
    r = client.get(
        f"/projects/{pid}/tasks/{tid}/classes", headers=_hdr(token)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["allowed_class_ids"] is not None
    assert set(body["allowed_class_ids"]) == set(class_ids)
    assert {c["id"] for c in body["classes"]} == set(class_ids)


def test_new_class_does_not_auto_appear_in_existing_task(db_session) -> None:
    """v3.2 Issue 3 — adding a class to the project AFTER a task was
    created must NOT inject that class into the task's snapshot."""
    client = _client(db_session)
    pid, tid, token, class_ids = _setup(client, email="tc1b@x.com")
    # Add a 4th class to the project after the task already exists.
    new_cid = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 99, "name": "delta", "color": "#0000ff", "attributes": {}},
        headers=_hdr(token),
    ).json()["id"]
    # The task's allowed_class_ids must still contain only the original 3.
    r = client.get(
        f"/projects/{pid}/tasks/{tid}/classes", headers=_hdr(token)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["allowed_class_ids"] is not None
    assert set(body["allowed_class_ids"]) == set(class_ids)
    assert new_cid not in set(body["allowed_class_ids"])
    assert {c["id"] for c in body["classes"]} == set(class_ids)


def test_task_created_when_project_has_no_classes_gets_empty_snapshot(
    db_session,
) -> None:
    """v3.2 Issue 3 — a task created against a project that has zero
    classes is created with ``allowed_class_ids = []`` (not NULL).
    Classes added later do NOT auto-appear."""
    client = _client(db_session)
    token = _register(client, "tc1c@x.com")
    pid = client.post(
        "/projects", json={"name": "P"}, headers=_hdr(token)
    ).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    # Now add a class to the project.
    client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "x", "color": "#ff00ff", "attributes": {}},
        headers=_hdr(token),
    )
    r = client.get(
        f"/projects/{pid}/tasks/{tid}/classes", headers=_hdr(token)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # Empty list — NOT NULL — so the legacy "NULL means all" fallback
    # does not bleed the new class into the empty-snapshot task.
    assert body["allowed_class_ids"] == []
    assert body["classes"] == []


def test_put_subset_then_get_reflects(db_session) -> None:
    client = _client(db_session)
    pid, tid, token, class_ids = _setup(client, email="tc2@x.com")
    subset = class_ids[:2]
    r = client.put(
        f"/projects/{pid}/tasks/{tid}/classes",
        json={"allowed_class_ids": subset},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body["allowed_class_ids"]) == set(subset)
    assert {c["id"] for c in body["classes"]} == set(subset)
    # And a fresh GET sees the same subset.
    r2 = client.get(
        f"/projects/{pid}/tasks/{tid}/classes", headers=_hdr(token)
    )
    assert r2.status_code == 200
    assert {c["id"] for c in r2.json()["classes"]} == set(subset)


def test_put_empty_array_allowed(db_session) -> None:
    client = _client(db_session)
    pid, tid, token, _ = _setup(client, email="tc3@x.com")
    r = client.put(
        f"/projects/{pid}/tasks/{tid}/classes",
        json={"allowed_class_ids": []},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["allowed_class_ids"] == []
    assert body["classes"] == []


def test_put_null_clears_subset(db_session) -> None:
    client = _client(db_session)
    pid, tid, token, class_ids = _setup(client, email="tc4@x.com")
    # First narrow to a subset…
    client.put(
        f"/projects/{pid}/tasks/{tid}/classes",
        json={"allowed_class_ids": class_ids[:1]},
        headers=_hdr(token),
    )
    # …then clear it.
    r = client.put(
        f"/projects/{pid}/tasks/{tid}/classes",
        json={"allowed_class_ids": None},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["allowed_class_ids"] is None
    assert {c["id"] for c in body["classes"]} == set(class_ids)


def test_put_class_id_from_other_project_returns_422(db_session) -> None:
    client = _client(db_session)
    pid_a, tid_a, token_a, _ = _setup(client, email="tc5a@x.com")
    # Second user → second project + a class in *that* project.
    token_b = _register(client, "tc5b@x.com")
    pid_b = client.post(
        "/projects", json={"name": "Other"}, headers=_hdr(token_b)
    ).json()["id"]
    foreign_class = client.post(
        f"/projects/{pid_b}/classes",
        json={"idx": 0, "name": "x", "color": "#00ff00", "attributes": {}},
        headers=_hdr(token_b),
    ).json()["id"]
    # Apply foreign class id to project A's task → 422.
    r = client.put(
        f"/projects/{pid_a}/tasks/{tid_a}/classes",
        json={"allowed_class_ids": [foreign_class]},
        headers=_hdr(token_a),
    )
    assert r.status_code == 422, r.text


def test_put_non_owner_non_admin_returns_403(db_session) -> None:
    client = _client(db_session)
    pid, tid, _owner_token, class_ids = _setup(client, email="tc6a@x.com")
    other_token = _register(client, "tc6b@x.com")
    r = client.put(
        f"/projects/{pid}/tasks/{tid}/classes",
        json={"allowed_class_ids": class_ids[:1]},
        headers=_hdr(other_token),
    )
    assert r.status_code == 403, r.text


def test_duplicate_carries_subset(db_session) -> None:
    """v3.1 Issue 3 — duplicating a task copies its allowed_class_ids."""
    client = _client(db_session)
    pid, tid, token, class_ids = _setup(client, email="tc7@x.com")
    subset = class_ids[:2]
    client.put(
        f"/projects/{pid}/tasks/{tid}/classes",
        json={"allowed_class_ids": subset},
        headers=_hdr(token),
    )
    dup = client.post(
        f"/projects/{pid}/tasks/{tid}/duplicate", headers=_hdr(token)
    )
    assert dup.status_code == 201, dup.text
    new_tid = dup.json()[0]["id"]
    r = client.get(
        f"/projects/{pid}/tasks/{new_tid}/classes", headers=_hdr(token)
    )
    assert r.status_code == 200, r.text
    assert set(r.json()["allowed_class_ids"]) == set(subset)
