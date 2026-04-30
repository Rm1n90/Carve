"""v3.5 Phase F5 — workspace-scoped weights.

Coverage:

  * POST /weights uploads a workspace-wide weight (project_id is null).
  * GET /projects/{pid}/weights returns workspace + project-scoped weights.
  * POST /weights/{wid}/default writes to weight_project_defaults with
    a {project_id, task_kind} body and surfaces is_default=true on the
    project-scoped listing.
  * Auto-annotate works for a workspace weight against any task.
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


def _install_fake_storage(monkeypatch) -> None:
    from carve_api.assets import service as assets_svc
    from carve_api.inference import autoannotate as aa_mod
    from carve_api.weights import service as weights_svc

    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(weights_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(aa_mod, "MinioClient", _FakeStorage)


def _make_mock_transport(predict_response: dict[str, Any]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/yolo/load":
            return httpx.Response(200, json={"loaded": "ok"})
        if request.url.path == "/yolo/predict":
            return httpx.Response(200, json=predict_response)
        if request.url.path == "/yolo/inspect":
            return httpx.Response(200, json={"class_names": [], "task_kind": None})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def _setup(client: TestClient, monkeypatch) -> tuple[str, str]:
    _install_fake_storage(monkeypatch)
    client.post("/auth/register", json={"email": "ws@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "ws@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    return token, pid


def _upload_workspace_weight(
    client: TestClient,
    token: str,
    name: str,
    *,
    task_kind: str = "detect",
    class_names: list[str] | None = None,
) -> str:
    fake_pt = b"PK\x03\x04" + b"x" * 256
    import json as _json

    data = {
        "name": name,
        "task_kind": task_kind,
        "class_names": _json.dumps(class_names or []),
    }
    transport = _make_mock_transport({"detections": [], "polygons": []})
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            "/weights",
            data=data,
            files={"file": ("y.pt", io.BytesIO(fake_pt), "application/octet-stream")},
            headers=_hdr(token),
        )
    finally:
        model_client_mod.set_test_transport(None)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _upload_project_weight(
    client: TestClient, token: str, pid: str, name: str
) -> str:
    fake_pt = b"PK\x03\x04" + b"x" * 256
    transport = _make_mock_transport({"detections": [], "polygons": []})
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/projects/{pid}/weights",
            data={"name": name, "task_kind": "detect", "class_names": "[]"},
            files={"file": ("y.pt", io.BytesIO(fake_pt), "application/octet-stream")},
            headers=_hdr(token),
        )
    finally:
        model_client_mod.set_test_transport(None)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_workspace_upload_creates_weight_with_null_project_id(
    db_session, monkeypatch
) -> None:
    client = _client(db_session)
    token, _pid = _setup(client, monkeypatch)
    wid = _upload_workspace_weight(client, token, "ws-yolo")

    r = client.get("/weights", headers=_hdr(token))
    assert r.status_code == 200, r.text
    rows = r.json()
    by_id = {w["id"]: w for w in rows}
    assert by_id[wid]["project_id"] is None
    # Workspace listing has no project context, so is_default is false.
    assert by_id[wid]["is_default"] is False


def test_project_listing_includes_workspace_and_project_weights(
    db_session, monkeypatch
) -> None:
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    wid_ws = _upload_workspace_weight(client, token, "ws-yolo")
    wid_proj = _upload_project_weight(client, token, pid, "proj-yolo")

    r = client.get(f"/projects/{pid}/weights", headers=_hdr(token))
    assert r.status_code == 200, r.text
    rows = r.json()
    by_id = {w["id"]: w for w in rows}
    assert wid_ws in by_id
    assert wid_proj in by_id
    assert by_id[wid_ws]["project_id"] is None
    assert by_id[wid_proj]["project_id"] == pid


def test_set_default_writes_to_defaults_table(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    wid_ws = _upload_workspace_weight(client, token, "ws-yolo")

    r = client.post(
        f"/weights/{wid_ws}/default",
        json={"project_id": pid, "task_kind": "detect"},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["is_default"] is True

    # Project listing should reflect the workspace weight as default.
    rows = client.get(f"/projects/{pid}/weights", headers=_hdr(token)).json()
    flags = {row["id"]: row["is_default"] for row in rows}
    assert flags[wid_ws] is True


def test_workspace_weight_default_is_isolated_per_project(
    db_session, monkeypatch
) -> None:
    """Same workspace weight pinned in one project is NOT default in another."""
    client = _client(db_session)
    token, pid_a = _setup(client, monkeypatch)
    pid_b = client.post("/projects", json={"name": "B"}, headers=_hdr(token)).json()["id"]
    wid_ws = _upload_workspace_weight(client, token, "ws-yolo")

    r = client.post(
        f"/weights/{wid_ws}/default",
        json={"project_id": pid_a, "task_kind": "detect"},
        headers=_hdr(token),
    )
    assert r.status_code == 200

    rows_a = client.get(f"/projects/{pid_a}/weights", headers=_hdr(token)).json()
    rows_b = client.get(f"/projects/{pid_b}/weights", headers=_hdr(token)).json()
    flags_a = {row["id"]: row["is_default"] for row in rows_a}
    flags_b = {row["id"]: row["is_default"] for row in rows_b}
    assert flags_a[wid_ws] is True
    assert flags_b[wid_ws] is False


def test_auto_annotate_workspace_weight_against_any_task(
    db_session, monkeypatch
) -> None:
    """A workspace weight (project_id=null) predicts cleanly against a task
    in any project — the cross-project guard now only fires for
    project-scoped weights bound to a different project."""
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    aid = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(_tiny_png()), "image/png")},
        headers=_hdr(token),
    ).json()["id"]
    client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "car", "color": "#ff0000"},
        headers=_hdr(token),
    )
    wid_ws = _upload_workspace_weight(client, token, "ws-yolo", class_names=["car"])

    transport = _make_mock_transport(
        {
            "detections": [
                {"class_name": "car", "confidence": 0.9, "bbox": {"x": 1, "y": 2, "w": 3, "h": 4}},
            ],
            "polygons": [],
        }
    )
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/assets/{aid}/auto-annotate?weight_id={wid_ws}",
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        assert r.json()["annotations_created"] == 1
    finally:
        model_client_mod.set_test_transport(None)


def test_set_default_rejects_kind_mismatch(db_session, monkeypatch) -> None:
    """The (project, task_kind) slot must match the weight's own task_kind."""
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    wid_det = _upload_workspace_weight(client, token, "det", task_kind="detect")

    r = client.post(
        f"/weights/{wid_det}/default",
        json={"project_id": pid, "task_kind": "segment"},
        headers=_hdr(token),
    )
    assert r.status_code == 400
    body = r.json()
    assert (
        body.get("error") == "weight_invalid"
        or body.get("detail") == "weight_invalid"
    )


def test_old_mappings_endpoints_are_gone(db_session, monkeypatch) -> None:
    """Phase F4 cleanup — GET/PUT /weights/{wid}/mappings return 404
    so callers know to migrate to mapping-suggestions + class_overrides."""
    import uuid

    client = _client(db_session)
    token, _pid = _setup(client, monkeypatch)
    wid = _upload_workspace_weight(client, token, "ws-yolo")

    r = client.get(f"/weights/{wid}/mappings", headers=_hdr(token))
    # FastAPI returns 404 for an unregistered path.
    assert r.status_code == 404

    r2 = client.put(
        f"/weights/{wid}/mappings/{uuid.uuid4()}",
        json={"project_class_id": None},
        headers=_hdr(token),
    )
    assert r2.status_code in (404, 405)
