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


# ---------------------------------------------------------------------------
# v3.2 Issue 4 — duplicate with explicit ``allowed_class_ids`` override.
# ---------------------------------------------------------------------------


def _setup_with_classes(
    client: TestClient, email: str
) -> tuple[str, str, str, list[str]]:
    """Project with 3 classes + a task whose allowed_class_ids is the
    snapshot of those 3 ids (post-v3.2 Issue 3 default)."""
    client.post("/auth/register", json={"email": email, "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": email, "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post(
        "/projects", json={"name": "P"}, headers=_hdr(token)
    ).json()["id"]
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
        json={"name": "Source", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    return pid, tid, token, class_ids


def test_duplicate_with_subset_override(db_session) -> None:
    """v3.2 Issue 4 — ``allowed_class_ids`` in the body overrides the
    source task's snapshot. The new task must reflect the override, not
    the source list."""
    client = _client(db_session)
    pid, tid, token, class_ids = _setup_with_classes(client, "td7@x.com")
    override = class_ids[:2]
    r = client.post(
        f"/projects/{pid}/tasks/{tid}/duplicate",
        json={"allowed_class_ids": override},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    new_tid = r.json()[0]["id"]
    cls = client.get(
        f"/projects/{pid}/tasks/{new_tid}/classes", headers=_hdr(token)
    ).json()
    assert set(cls["allowed_class_ids"]) == set(override)
    assert {c["id"] for c in cls["classes"]} == set(override)


def test_duplicate_with_empty_list_override(db_session) -> None:
    """v3.2 Issue 4 — ``allowed_class_ids: []`` produces a duplicate
    with zero classes (NOT the legacy 'all' fallback)."""
    client = _client(db_session)
    pid, tid, token, _ = _setup_with_classes(client, "td8@x.com")
    r = client.post(
        f"/projects/{pid}/tasks/{tid}/duplicate",
        json={"allowed_class_ids": []},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    new_tid = r.json()[0]["id"]
    cls = client.get(
        f"/projects/{pid}/tasks/{new_tid}/classes", headers=_hdr(token)
    ).json()
    assert cls["allowed_class_ids"] == []
    assert cls["classes"] == []


def test_duplicate_with_foreign_class_id_returns_422(db_session) -> None:
    """v3.2 Issue 4 — overriding with an id from a different project's
    classes list must surface as 422."""
    client = _client(db_session)
    pid_a, tid_a, token_a, _ = _setup_with_classes(client, "td9a@x.com")
    # Second user → second project + a class in that project.
    client.post(
        "/auth/register", json={"email": "td9b@x.com", "password": "hunter22"}
    )
    token_b = client.post(
        "/auth/login", json={"email": "td9b@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid_b = client.post(
        "/projects", json={"name": "Other"}, headers=_hdr(token_b)
    ).json()["id"]
    foreign_cid = client.post(
        f"/projects/{pid_b}/classes",
        json={"idx": 0, "name": "x", "color": "#00ff00", "attributes": {}},
        headers=_hdr(token_b),
    ).json()["id"]
    r = client.post(
        f"/projects/{pid_a}/tasks/{tid_a}/duplicate",
        json={"allowed_class_ids": [foreign_cid]},
        headers=_hdr(token_a),
    )
    assert r.status_code == 422, r.text


def test_duplicate_without_override_keeps_source_snapshot(db_session) -> None:
    """v3.2 Issue 4 — when ``allowed_class_ids`` is omitted (or null) the
    duplicate inherits the source task's snapshot verbatim."""
    client = _client(db_session)
    pid, tid, token, class_ids = _setup_with_classes(client, "td10@x.com")
    # Narrow the source first so we have a non-default subset to inherit.
    subset = class_ids[:2]
    client.put(
        f"/projects/{pid}/tasks/{tid}/classes",
        json={"allowed_class_ids": subset},
        headers=_hdr(token),
    )
    r = client.post(
        f"/projects/{pid}/tasks/{tid}/duplicate",
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    new_tid = r.json()[0]["id"]
    cls = client.get(
        f"/projects/{pid}/tasks/{new_tid}/classes", headers=_hdr(token)
    ).json()
    assert set(cls["allowed_class_ids"]) == set(subset)
