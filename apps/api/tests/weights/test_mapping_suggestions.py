"""v3.5 Phase F1 — GET /weights/{wid}/mapping-suggestions.

The endpoint replaces the persistent `weight_class_mappings` table with a
transient predict-time helper. It auto-name-matches the weight's classes
against the task's effective allowed classes and lets the predict popover
override per-class.

Coverage:

  * Suggestions match by case-insensitive name; misses are null.
  * Each suggestion exposes the full `alternatives` list of project classes.
  * Honours the task's `allowed_class_ids` subset (only those alternatives
    show up — others are filtered out).
  * 404 on unknown weight, 404 on unknown task.
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


def _setup(client: TestClient, monkeypatch) -> tuple[str, str]:
    _install_fake_storage(monkeypatch)
    client.post("/auth/register", json={"email": "ms@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "ms@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    return token, pid


def _seed_classes(client: TestClient, token: str, pid: str) -> dict[str, str]:
    car = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "car", "color": "#ff0000"},
        headers=_hdr(token),
    ).json()
    truck = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 1, "name": "truck", "color": "#00ff00"},
        headers=_hdr(token),
    ).json()
    return {"car": car["id"], "truck": truck["id"]}


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


def _upload_weight(
    client: TestClient,
    token: str,
    pid: str,
    *,
    class_names: list[str],
) -> str:
    fake_pt = b"PK\x03\x04" + b"x" * 256
    import json as _json

    transport = _make_mock_transport({"detections": [], "polygons": []})
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/projects/{pid}/weights",
            data={
                "name": "yolo",
                "task_kind": "detect",
                "class_names": _json.dumps(class_names),
            },
            files={"file": ("y.pt", io.BytesIO(fake_pt), "application/octet-stream")},
            headers=_hdr(token),
        )
    finally:
        model_client_mod.set_test_transport(None)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _make_task(client: TestClient, token: str, pid: str) -> str:
    return client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]


def test_suggestions_auto_match_by_name(db_session, monkeypatch) -> None:
    """Three weight classes — two match (car, truck), one stays null (person)."""
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    project_classes = _seed_classes(client, token, pid)
    tid = _make_task(client, token, pid)
    wid = _upload_weight(client, token, pid, class_names=["person", "car", "truck"])

    r = client.get(
        f"/weights/{wid}/mapping-suggestions?task_id={tid}",
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    suggestions = body["suggestions"]
    assert len(suggestions) == 3
    by_idx = {s["weight_class_idx"]: s for s in suggestions}
    assert by_idx[0]["weight_class_name"] == "person"
    assert by_idx[0]["suggested_project_class_id"] is None
    assert by_idx[1]["weight_class_name"] == "car"
    assert by_idx[1]["suggested_project_class_id"] == project_classes["car"]
    assert by_idx[2]["weight_class_name"] == "truck"
    assert by_idx[2]["suggested_project_class_id"] == project_classes["truck"]


def test_alternatives_include_all_task_classes(db_session, monkeypatch) -> None:
    """Each suggestion's `alternatives` is the task's full effective class list."""
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    project_classes = _seed_classes(client, token, pid)
    tid = _make_task(client, token, pid)
    wid = _upload_weight(client, token, pid, class_names=["car"])

    r = client.get(
        f"/weights/{wid}/mapping-suggestions?task_id={tid}",
        headers=_hdr(token),
    )
    assert r.status_code == 200
    suggestions = r.json()["suggestions"]
    alts = suggestions[0]["alternatives"]
    alt_ids = {a["id"] for a in alts}
    assert alt_ids == {project_classes["car"], project_classes["truck"]}


def test_alternatives_respect_task_subset(db_session, monkeypatch) -> None:
    """Task with `allowed_class_ids` set narrows the alternatives list."""
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    project_classes = _seed_classes(client, token, pid)
    tid = _make_task(client, token, pid)
    # Restrict task to only "car"
    r0 = client.put(
        f"/projects/{pid}/tasks/{tid}/classes",
        json={"allowed_class_ids": [project_classes["car"]]},
        headers=_hdr(token),
    )
    assert r0.status_code == 200, r0.text

    wid = _upload_weight(client, token, pid, class_names=["car", "truck"])

    r = client.get(
        f"/weights/{wid}/mapping-suggestions?task_id={tid}",
        headers=_hdr(token),
    )
    assert r.status_code == 200
    suggestions = r.json()["suggestions"]
    by_idx = {s["weight_class_idx"]: s for s in suggestions}
    # Both weight classes are returned, but only "car" matches and the
    # alternatives only list classes inside the task's allowed subset.
    assert len(suggestions) == 2
    alts0 = {a["id"] for a in by_idx[0]["alternatives"]}
    alts1 = {a["id"] for a in by_idx[1]["alternatives"]}
    assert alts0 == {project_classes["car"]}
    assert alts1 == {project_classes["car"]}
    assert by_idx[0]["suggested_project_class_id"] == project_classes["car"]
    # "truck" is in the weight but not in the task's allowed subset → no suggestion.
    assert by_idx[1]["suggested_project_class_id"] is None


def test_suggestions_404_unknown_weight(db_session, monkeypatch) -> None:
    import uuid

    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    tid = _make_task(client, token, pid)

    r = client.get(
        f"/weights/{uuid.uuid4()}/mapping-suggestions?task_id={tid}",
        headers=_hdr(token),
    )
    assert r.status_code == 404


def test_suggestions_404_unknown_task(db_session, monkeypatch) -> None:
    import uuid

    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    wid = _upload_weight(client, token, pid, class_names=["car"])

    r = client.get(
        f"/weights/{wid}/mapping-suggestions?task_id={uuid.uuid4()}",
        headers=_hdr(token),
    )
    assert r.status_code == 404


def test_suggestions_works_for_weight_with_no_class_names(
    db_session, monkeypatch
) -> None:
    """A weight uploaded without class_names returns an empty suggestions list."""
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    _seed_classes(client, token, pid)
    tid = _make_task(client, token, pid)
    wid = _upload_weight(client, token, pid, class_names=[])

    r = client.get(
        f"/weights/{wid}/mapping-suggestions?task_id={tid}",
        headers=_hdr(token),
    )
    assert r.status_code == 200
    assert r.json()["suggestions"] == []
