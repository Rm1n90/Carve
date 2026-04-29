"""v3.3 Issue 3c — weight ↔ project class mapping table.

Coverage axes:

  * upload seeds one ``WeightClassMapping`` row per inspected class
  * project class names auto-populate ``project_class_id``; misses stay NULL
  * PUT mapping updates ``project_class_id`` (and accepts ``null`` to disconnect)
  * predict path uses the mapping table; null mappings tally in skipped_by_class
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
    client.post("/auth/register", json={"email": "wm@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "wm@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    return token, pid


def _seed_classes(client: TestClient, token: str, pid: str) -> dict[str, str]:
    """Project gets two real classes (car, truck); 'person' will stay unmatched."""
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


def _upload_weight(
    client: TestClient,
    token: str,
    pid: str,
    *,
    class_names: list[str],
) -> str:
    fake_pt = b"PK\x03\x04" + b"x" * 256
    import json as _json

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
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _make_mock_transport(predict_response: dict[str, Any]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/yolo/load":
            return httpx.Response(200, json={"loaded": "ok"})
        if request.url.path == "/yolo/predict":
            return httpx.Response(200, json=predict_response)
        if request.url.path == "/yolo/inspect":
            # Empty so the upload falls back to the form-supplied class_names.
            return httpx.Response(200, json={"class_names": [], "task_kind": None})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def test_upload_seeds_mapping_rows_with_name_match(db_session, monkeypatch) -> None:
    """Three weight classes — two match project classes, one stays null."""
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    project_classes = _seed_classes(client, token, pid)

    transport = _make_mock_transport({"detections": [], "polygons": []})
    model_client_mod.set_test_transport(transport)
    try:
        wid = _upload_weight(
            client, token, pid, class_names=["person", "car", "truck"]
        )
    finally:
        model_client_mod.set_test_transport(None)

    r = client.get(f"/weights/{wid}/mappings", headers=_hdr(token))
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 3
    by_idx = {row["weight_class_idx"]: row for row in rows}
    assert by_idx[0]["weight_class_name"] == "person"
    assert by_idx[0]["project_class_id"] is None
    assert by_idx[1]["weight_class_name"] == "car"
    assert by_idx[1]["project_class_id"] == project_classes["car"]
    assert by_idx[2]["weight_class_name"] == "truck"
    assert by_idx[2]["project_class_id"] == project_classes["truck"]


def test_put_mapping_updates_project_class(db_session, monkeypatch) -> None:
    """PUT swaps a mapping to a different project class and accepts null."""
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    project_classes = _seed_classes(client, token, pid)

    transport = _make_mock_transport({"detections": [], "polygons": []})
    model_client_mod.set_test_transport(transport)
    try:
        wid = _upload_weight(client, token, pid, class_names=["car"])
    finally:
        model_client_mod.set_test_transport(None)

    rows = client.get(f"/weights/{wid}/mappings", headers=_hdr(token)).json()
    mid = rows[0]["id"]
    # car-mapped → swap to truck
    r = client.put(
        f"/weights/{wid}/mappings/{mid}",
        json={"project_class_id": project_classes["truck"]},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["project_class_id"] == project_classes["truck"]

    # Disconnect (null)
    r2 = client.put(
        f"/weights/{wid}/mappings/{mid}",
        json={"project_class_id": None},
        headers=_hdr(token),
    )
    assert r2.status_code == 200
    assert r2.json()["project_class_id"] is None


def test_predict_uses_mapping_and_tallies_skipped(db_session, monkeypatch) -> None:
    """Mapping with null project_class_id → detection dropped + counted."""
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    project_classes = _seed_classes(client, token, pid)

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

    transport = _make_mock_transport(
        {
            "detections": [
                {"class_name": "car", "confidence": 0.9, "bbox": {"x": 1, "y": 2, "w": 3, "h": 4}},
                # 'person' has no project class → mapping null → tallied as skipped
                {"class_name": "person", "confidence": 0.8, "bbox": {"x": 5, "y": 6, "w": 7, "h": 8}},
            ],
            "polygons": [],
        }
    )
    model_client_mod.set_test_transport(transport)
    try:
        wid = _upload_weight(client, token, pid, class_names=["car", "person"])
        r = client.post(
            f"/assets/{aid}/auto-annotate?weight_id={wid}",
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["annotations_created"] == 1
        assert body["skipped_count"] == 1
        assert body["skipped_by_class"].get("person") == 1
        # The created annotation points at the project's 'car' class.
        assert body["annotations"][0]["class_id"] == project_classes["car"]
    finally:
        model_client_mod.set_test_transport(None)


def test_predict_uses_mapping_after_manual_override(db_session, monkeypatch) -> None:
    """User remaps a weight class (idx=0 'person' → project 'car') and predict
    starts attributing 'person' detections to the 'car' project class."""
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    project_classes = _seed_classes(client, token, pid)

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

    transport = _make_mock_transport(
        {
            "detections": [
                {"class_name": "person", "confidence": 0.9, "bbox": {"x": 1, "y": 2, "w": 3, "h": 4}},
            ],
            "polygons": [],
        }
    )
    model_client_mod.set_test_transport(transport)
    try:
        wid = _upload_weight(client, token, pid, class_names=["person"])

        rows = client.get(f"/weights/{wid}/mappings", headers=_hdr(token)).json()
        mid = rows[0]["id"]
        # Manual override: bind weight's "person" to project's "car" class.
        client.put(
            f"/weights/{wid}/mappings/{mid}",
            json={"project_class_id": project_classes["car"]},
            headers=_hdr(token),
        )

        r = client.post(
            f"/assets/{aid}/auto-annotate?weight_id={wid}",
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["annotations_created"] == 1
        assert body["skipped_count"] == 0
        assert body["annotations"][0]["class_id"] == project_classes["car"]
    finally:
        model_client_mod.set_test_transport(None)
