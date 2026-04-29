"""v3.3 Issue 4 — default weight selection."""

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


def _hdr(t):
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


def _setup(client, monkeypatch):
    _install_fake_storage(monkeypatch)
    client.post("/auth/register", json={"email": "wd@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "wd@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    return token, pid


def _upload_weight(client, token, pid, name: str, task_kind: str = "detect") -> str:
    fake_pt = b"PK\x03\x04" + b"x" * 256
    r = client.post(
        f"/projects/{pid}/weights",
        data={"name": name, "task_kind": task_kind, "class_names": "[]"},
        files={"file": ("y.pt", io.BytesIO(fake_pt), "application/octet-stream")},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_set_default_marks_weight_as_default(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    wid = _upload_weight(client, token, pid, "first")

    r = client.post(f"/weights/{wid}/default", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["is_default"] is True
    assert body["id"] == wid


def test_set_default_on_second_clears_first(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    wid_a = _upload_weight(client, token, pid, "a")
    wid_b = _upload_weight(client, token, pid, "b")

    # First, mark A as default.
    r = client.post(f"/weights/{wid_a}/default", headers=_hdr(token))
    assert r.status_code == 200, r.text
    assert r.json()["is_default"] is True

    # Now switch default to B — A must flip back to is_default=false.
    r = client.post(f"/weights/{wid_b}/default", headers=_hdr(token))
    assert r.status_code == 200, r.text
    assert r.json()["is_default"] is True

    # Confirm A is no longer default via the listing.
    rows = client.get(f"/projects/{pid}/weights", headers=_hdr(token)).json()
    flags = {row["id"]: row["is_default"] for row in rows}
    assert flags[wid_a] is False
    assert flags[wid_b] is True


def test_two_kinds_can_each_have_a_default(db_session, monkeypatch) -> None:
    """Partial unique index keys on (project_id, task_kind) — different kinds
    coexist as defaults in the same project."""
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    wid_det = _upload_weight(client, token, pid, "det", task_kind="detect")
    wid_seg = _upload_weight(client, token, pid, "seg", task_kind="segment")

    r1 = client.post(f"/weights/{wid_det}/default", headers=_hdr(token))
    assert r1.status_code == 200
    r2 = client.post(f"/weights/{wid_seg}/default", headers=_hdr(token))
    assert r2.status_code == 200

    rows = client.get(f"/projects/{pid}/weights", headers=_hdr(token)).json()
    flags = {row["id"]: row["is_default"] for row in rows}
    assert flags[wid_det] is True
    assert flags[wid_seg] is True


def _make_mock_transport(predict_response: dict[str, Any]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/yolo/load":
            return httpx.Response(200, json={"loaded": "ok"})
        if request.url.path == "/yolo/predict":
            return httpx.Response(200, json=predict_response)
        if request.url.path == "/yolo/inspect":
            # Best-effort inspect during upload — return empty so the service
            # falls back to the user-supplied class_names without failing.
            return httpx.Response(200, json={"class_names": [], "task_kind": None})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def test_auto_annotate_without_weight_id_uses_default(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)

    # Project: 1 task, 1 asset, 1 class, 1 default weight.
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
    wid = _upload_weight(client, token, pid, "yolo")
    r = client.post(f"/weights/{wid}/default", headers=_hdr(token))
    assert r.status_code == 200, r.text

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
        # No weight_id query param — service should fall back to the default.
        r = client.post(f"/assets/{aid}/auto-annotate", headers=_hdr(token))
        assert r.status_code == 200, r.text
        # v3.3 Issue 3c — response shape is now {annotations, annotations_created,
        # skipped_count, skipped_by_class}; older list-shaped tests get migrated
        # piecewise as fixtures land.
        body = r.json()
        assert body["annotations_created"] == 1
        assert len(body["annotations"]) == 1
    finally:
        model_client_mod.set_test_transport(None)


def test_auto_annotate_without_weight_id_no_default_returns_400(
    db_session, monkeypatch
) -> None:
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
    # Upload a weight but DON'T mark it as default.
    _upload_weight(client, token, pid, "yolo")

    r = client.post(f"/assets/{aid}/auto-annotate", headers=_hdr(token))
    assert r.status_code == 400
    body = r.json()
    # Error envelope: carve_api wraps HTTPException detail in `error` key,
    # but plain HTTPException(detail=...) surfaces as `detail`. Accept either
    # so this stays robust against the envelope choice.
    assert body.get("error") == "no_default_weight" or body.get("detail") == "no_default_weight"
