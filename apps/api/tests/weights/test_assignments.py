"""v3.7 Phase 3 Issue 4 — weight <-> project many-to-many assignments.

Coverage:

  * POST /weights/{wid}/assignments creates a (weight, project) row.
  * GET /weights/{wid}/assignments lists assigned projects with names.
  * Duplicate POST is idempotent — returns the existing row.
  * DELETE /weights/{wid}/assignments/{pid} removes the row.
  * Auto-annotate succeeds when the weight is assigned to the task's
    project (even when the weight is itself project-scoped to a
    DIFFERENT project — the assignment unlocks predict access).
  * Auto-annotate fails (400 weight_project_mismatch) when the weight
    is project-scoped to a different project AND has no assignment for
    the task's project.
"""

import io
from typing import Any

import httpx
from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.inference import model_client as model_client_mod
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


def _hdr(t: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {t}"}


def _tiny_png() -> bytes:
    return bytes.fromhex(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA63000000000200015C8B59FA0000000049454E44AE426082"
    )


class _FakeStorage:
    @classmethod
    def from_settings(cls):
        return cls()

    def ensure_bucket(self):
        pass

    def put_object(self, *a, **k):
        pass

    def get_object(self, key):
        return io.BytesIO(_tiny_png())

    def remove_object(self, key):
        pass

    def presigned_get(self, key, **k):
        return f"https://fake/{key}"

    def presigned_get_internal(self, key, **k):
        return f"https://fake-internal/{key}"


def _install_fake_storage(monkeypatch) -> None:
    from carve_api.assets import service as assets_svc
    from carve_api.inference import autoannotate as aa_mod
    from carve_api.weights import service as weights_svc

    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(weights_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(aa_mod, "MinioClient", _FakeStorage)


def _make_mock_transport(
    predict_response: dict[str, Any] | None = None,
) -> httpx.MockTransport:
    body = predict_response or {"detections": [], "polygons": []}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/yolo/load":
            return httpx.Response(200, json={"loaded": "ok"})
        if request.url.path == "/yolo/predict":
            return httpx.Response(200, json=body)
        if request.url.path == "/yolo/inspect":
            return httpx.Response(200, json={"class_names": [], "task_kind": None})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def _setup(client: TestClient, monkeypatch) -> tuple[str, str]:
    _install_fake_storage(monkeypatch)
    client.post("/auth/register", json={"email": "asn@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "asn@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post(
        "/projects", json={"name": "P-A"}, headers=_hdr(token)
    ).json()["id"]
    return token, pid


def _create_project(client: TestClient, token: str, name: str) -> str:
    return client.post(
        "/projects", json={"name": name}, headers=_hdr(token)
    ).json()["id"]


def _upload_project_weight(
    client: TestClient, token: str, pid: str, name: str
) -> str:
    fake_pt = b"PK\x03\x04" + b"x" * 256
    transport = _make_mock_transport()
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/projects/{pid}/weights",
            data={"name": name, "task_kind": "detect", "class_names": "[]"},
            files={
                "file": ("y.pt", io.BytesIO(fake_pt), "application/octet-stream")
            },
            headers=_hdr(token),
        )
    finally:
        model_client_mod.set_test_transport(None)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_post_assignment_creates_row(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid_a = _setup(client, monkeypatch)
    pid_b = _create_project(client, token, "P-B")
    wid = _upload_project_weight(client, token, pid_a, "shared")

    r = client.post(
        f"/weights/{wid}/assignments",
        json={"project_id": pid_b},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["weight_id"] == wid
    assert body["project_id"] == pid_b
    assert body["project_name"] == "P-B"


def test_list_assignments_returns_assigned_projects(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid_a = _setup(client, monkeypatch)
    pid_b = _create_project(client, token, "P-B")
    pid_c = _create_project(client, token, "P-C")
    wid = _upload_project_weight(client, token, pid_a, "shared")

    client.post(
        f"/weights/{wid}/assignments",
        json={"project_id": pid_b},
        headers=_hdr(token),
    )
    client.post(
        f"/weights/{wid}/assignments",
        json={"project_id": pid_c},
        headers=_hdr(token),
    )

    r = client.get(f"/weights/{wid}/assignments", headers=_hdr(token))
    assert r.status_code == 200, r.text
    rows = r.json()
    project_ids = {row["project_id"] for row in rows}
    assert project_ids == {pid_b, pid_c}
    project_names = {row["project_name"] for row in rows}
    assert project_names == {"P-B", "P-C"}


def test_post_assignment_is_idempotent(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid_a = _setup(client, monkeypatch)
    pid_b = _create_project(client, token, "P-B")
    wid = _upload_project_weight(client, token, pid_a, "shared")

    r1 = client.post(
        f"/weights/{wid}/assignments",
        json={"project_id": pid_b},
        headers=_hdr(token),
    )
    assert r1.status_code == 201, r1.text
    # Second POST with the same pair must succeed (idempotent) and the
    # listing must still show exactly one row.
    r2 = client.post(
        f"/weights/{wid}/assignments",
        json={"project_id": pid_b},
        headers=_hdr(token),
    )
    assert r2.status_code == 201, r2.text

    rows = client.get(f"/weights/{wid}/assignments", headers=_hdr(token)).json()
    assert len(rows) == 1
    assert rows[0]["project_id"] == pid_b


def test_delete_assignment_removes_row(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid_a = _setup(client, monkeypatch)
    pid_b = _create_project(client, token, "P-B")
    wid = _upload_project_weight(client, token, pid_a, "shared")

    client.post(
        f"/weights/{wid}/assignments",
        json={"project_id": pid_b},
        headers=_hdr(token),
    )
    r = client.delete(
        f"/weights/{wid}/assignments/{pid_b}", headers=_hdr(token)
    )
    assert r.status_code == 204, r.text

    rows = client.get(f"/weights/{wid}/assignments", headers=_hdr(token)).json()
    assert rows == []


def test_auto_annotate_via_assigned_weight_succeeds(db_session, monkeypatch) -> None:
    """v3.7 Phase 3 Issue 4 — a project-scoped weight assigned to
    another project unlocks auto-annotate for that other project."""
    client = _client(db_session)
    token, pid_a = _setup(client, monkeypatch)
    pid_b = _create_project(client, token, "P-B")
    # Weight is project-scoped to A.
    wid = _upload_project_weight(client, token, pid_a, "shared")
    # And explicitly assigned to B.
    client.post(
        f"/weights/{wid}/assignments",
        json={"project_id": pid_b},
        headers=_hdr(token),
    )

    # Project B has a task with one image asset and a class.
    tid = client.post(
        f"/projects/{pid_b}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    aid = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(_tiny_png()), "image/png")},
        headers=_hdr(token),
    ).json()["id"]
    client.post(
        f"/projects/{pid_b}/classes",
        json={"idx": 0, "name": "car", "color": "#ff0000"},
        headers=_hdr(token),
    )

    transport = _make_mock_transport(
        {
            "detections": [
                {
                    "class_name": "car",
                    "confidence": 0.9,
                    "bbox": {"x": 1, "y": 2, "w": 3, "h": 4},
                }
            ],
            "polygons": [],
        }
    )
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/assets/{aid}/auto-annotate?weight_id={wid}", headers=_hdr(token)
        )
        assert r.status_code == 200, r.text
        assert r.json()["annotations_created"] == 1
    finally:
        model_client_mod.set_test_transport(None)


def test_auto_annotate_via_unassigned_other_project_weight_fails(
    db_session, monkeypatch
) -> None:
    """A project-scoped weight that is NOT assigned to this project is
    rejected with weight_project_mismatch."""
    client = _client(db_session)
    token, pid_a = _setup(client, monkeypatch)
    pid_b = _create_project(client, token, "P-B")
    # Weight is project-scoped to A. No assignment to B.
    wid = _upload_project_weight(client, token, pid_a, "shared")

    tid = client.post(
        f"/projects/{pid_b}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    aid = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(_tiny_png()), "image/png")},
        headers=_hdr(token),
    ).json()["id"]

    transport = _make_mock_transport()
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/assets/{aid}/auto-annotate?weight_id={wid}", headers=_hdr(token)
        )
        assert r.status_code == 400, r.text
        body = r.json()
        # Same envelope-tolerance pattern used in other weight tests.
        assert (
            body.get("error") == "weight_project_mismatch"
            or body.get("detail") == "weight_project_mismatch"
        )
    finally:
        model_client_mod.set_test_transport(None)
