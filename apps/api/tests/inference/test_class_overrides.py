"""v3.5 Phase F2 — POST /assets/{aid}/auto-annotate accepts class_overrides.

Coverage:

  * `class_overrides` rebinds a weight class to a different project class.
  * `null` override marks a weight class as "skip" (counted in
    skipped_by_class on the response).
  * Missing entries fall back to the existing case-insensitive name-match
    so legacy callers keep their behavior.
  * Unknown / cross-project project_class_id is silently dropped (treated
    as "no override for that idx").
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


def _setup_world(client, monkeypatch):
    """User → project → image task → asset → 2 classes (car, truck) →
    weight with class_names=["car","truck"]."""
    _install_fake_storage(monkeypatch)
    client.post("/auth/register", json={"email": "co@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "co@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
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

    transport = _make_mock_transport({"detections": [], "polygons": []})
    model_client_mod.set_test_transport(transport)
    try:
        fake_pt = b"PK\x03\x04" + b"x" * 256
        wid = client.post(
            f"/projects/{pid}/weights",
            data={
                "name": "yolo",
                "task_kind": "detect",
                "class_names": '["car","truck"]',
            },
            files={"file": ("y.pt", io.BytesIO(fake_pt), "application/octet-stream")},
            headers=_hdr(token),
        ).json()["id"]
    finally:
        model_client_mod.set_test_transport(None)
    return token, pid, tid, aid, wid, car["id"], truck["id"]


def test_overrides_rebind_weight_class_to_different_project_class(
    db_session, monkeypatch
) -> None:
    """Override weight idx=0 ('car') → project's 'truck' class."""
    client = _client(db_session)
    token, pid, tid, aid, wid, car_id, truck_id = _setup_world(client, monkeypatch)

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
            f"/assets/{aid}/auto-annotate?weight_id={wid}",
            json={"class_overrides": {"0": truck_id}},
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["annotations_created"] == 1
        assert body["skipped_count"] == 0
        # Detection 'car' was rebound to project 'truck'
        assert body["annotations"][0]["class_id"] == truck_id
    finally:
        model_client_mod.set_test_transport(None)


def test_null_override_marks_weight_class_as_skip(db_session, monkeypatch) -> None:
    """`class_overrides: {0: null}` → idx=0 detections are skipped, tallied."""
    client = _client(db_session)
    token, pid, tid, aid, wid, car_id, truck_id = _setup_world(client, monkeypatch)

    transport = _make_mock_transport(
        {
            "detections": [
                {"class_name": "car", "confidence": 0.9, "bbox": {"x": 1, "y": 2, "w": 3, "h": 4}},
                {"class_name": "truck", "confidence": 0.8, "bbox": {"x": 5, "y": 6, "w": 7, "h": 8}},
            ],
            "polygons": [],
        }
    )
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/assets/{aid}/auto-annotate?weight_id={wid}",
            json={"class_overrides": {"0": None}},
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        # 'car' (idx 0) skipped, 'truck' (idx 1) name-matches and lands.
        assert body["annotations_created"] == 1
        assert body["skipped_count"] == 1
        assert body["skipped_by_class"].get("car") == 1
        assert body["annotations"][0]["class_id"] == truck_id
    finally:
        model_client_mod.set_test_transport(None)


def test_missing_overrides_fall_back_to_name_match(db_session, monkeypatch) -> None:
    """Indices not in `class_overrides` keep using name-match."""
    client = _client(db_session)
    token, pid, tid, aid, wid, car_id, truck_id = _setup_world(client, monkeypatch)

    transport = _make_mock_transport(
        {
            "detections": [
                # idx=0 'car' has an override → goes to truck_id
                {"class_name": "car", "confidence": 0.9, "bbox": {"x": 1, "y": 2, "w": 3, "h": 4}},
                # idx=1 'truck' is NOT in overrides → name-match → truck_id
                {"class_name": "truck", "confidence": 0.8, "bbox": {"x": 5, "y": 6, "w": 7, "h": 8}},
            ],
            "polygons": [],
        }
    )
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/assets/{aid}/auto-annotate?weight_id={wid}",
            json={"class_overrides": {"0": truck_id}},
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["annotations_created"] == 2
        assert body["skipped_count"] == 0
        cls_ids = {a["class_id"] for a in body["annotations"]}
        # Both detections land on truck_id (override + name-match)
        assert cls_ids == {truck_id}
    finally:
        model_client_mod.set_test_transport(None)


def test_no_body_keeps_legacy_name_match_behavior(db_session, monkeypatch) -> None:
    """No JSON body / no overrides — pure case-insensitive name-match."""
    client = _client(db_session)
    token, pid, tid, aid, wid, car_id, truck_id = _setup_world(client, monkeypatch)

    transport = _make_mock_transport(
        {
            "detections": [
                {"class_name": "CAR", "confidence": 0.9, "bbox": {"x": 1, "y": 2, "w": 3, "h": 4}},
                {"class_name": "Truck", "confidence": 0.8, "bbox": {"x": 5, "y": 6, "w": 7, "h": 8}},
                {"class_name": "Cat", "confidence": 0.7, "bbox": {"x": 1, "y": 1, "w": 1, "h": 1}},
            ],
            "polygons": [],
        }
    )
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/assets/{aid}/auto-annotate?weight_id={wid}",
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["annotations_created"] == 2
        assert body["skipped_count"] == 1
        assert body["skipped_by_class"].get("Cat") == 1
        cls_ids = {a["class_id"] for a in body["annotations"]}
        assert cls_ids == {car_id, truck_id}
    finally:
        model_client_mod.set_test_transport(None)


def test_invalid_override_id_is_silently_dropped(db_session, monkeypatch) -> None:
    """A project_class_id that doesn't belong to this project falls through
    to name-match (defensive against a stale predict popover)."""
    import uuid

    client = _client(db_session)
    token, pid, tid, aid, wid, car_id, truck_id = _setup_world(client, monkeypatch)

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
            f"/assets/{aid}/auto-annotate?weight_id={wid}",
            json={"class_overrides": {"0": str(uuid.uuid4())}},
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        # Bad uuid dropped → name-match still binds 'car' → car_id
        assert body["annotations_created"] == 1
        assert body["annotations"][0]["class_id"] == car_id
    finally:
        model_client_mod.set_test_transport(None)
