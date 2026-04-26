import io
from typing import Any

import httpx
from fastapi.testclient import TestClient

from vaa_api.deps import get_db
from vaa_api.inference import model_client as model_client_mod
from vaa_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()
    def _override():
        try: yield db_session
        finally: db_session.rollback()
    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(t): return {"Authorization": f"Bearer {t}"}


def _tiny_png() -> bytes:
    return bytes.fromhex(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA63000000000200015C8B59FA0000000049454E44AE426082"
    )


class _FakeStorage:
    @classmethod
    def from_settings(cls): return cls()
    def ensure_bucket(self): pass
    def put_object(self, *a, **k): pass
    def get_object(self, key):
        # Return a real PNG so PIL can decode it on upload validation
        return io.BytesIO(_tiny_png())
    def remove_object(self, key): pass
    def presigned_get(self, key, **k): return f"https://fake/{key}"


def _install_fake_storage(monkeypatch) -> None:
    from vaa_api.assets import service as assets_svc
    from vaa_api.weights import service as weights_svc
    from vaa_api.inference import autoannotate as aa_mod
    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(weights_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(aa_mod, "MinioClient", _FakeStorage)


def _setup_full_world(client, monkeypatch):
    """Register user -> project -> image task -> asset -> 2 classes (car, truck) -> weight."""
    _install_fake_storage(monkeypatch)
    client.post("/auth/register", json={"email": "aa@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "aa@x.com", "password": "hunter22"}).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(token)).json()["id"]

    aid = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(_tiny_png()), "image/png")},
        headers=_hdr(token),
    ).json()["id"]

    cars = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "car", "color": "#ff0000"},
        headers=_hdr(token),
    ).json()
    trucks = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 1, "name": "truck", "color": "#00ff00"},
        headers=_hdr(token),
    ).json()

    fake_pt = b"PK\x03\x04" + b"x" * 1024
    wid = client.post(
        f"/projects/{pid}/weights",
        data={
            "name": "yolo11n-detect",
            "task_kind": "detect",
            "class_names": '["car","truck"]',
        },
        files={"file": ("y.pt", io.BytesIO(fake_pt), "application/octet-stream")},
        headers=_hdr(token),
    ).json()["id"]

    return token, pid, tid, aid, wid, cars["id"], trucks["id"]


def _make_mock_transport(predict_response: dict[str, Any]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/yolo/load":
            return httpx.Response(200, json={"loaded": "ok"})
        if request.url.path == "/yolo/predict":
            return httpx.Response(200, json=predict_response)
        return httpx.Response(404)
    return httpx.MockTransport(handler)


def test_auto_annotate_creates_bbox_annotations(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, aid, wid, car_id, truck_id = _setup_full_world(client, monkeypatch)

    transport = _make_mock_transport({
        "detections": [
            {"class_name": "car", "confidence": 0.9, "bbox": {"x": 10, "y": 20, "w": 30, "h": 40}},
            {"class_name": "TRUCK", "confidence": 0.8, "bbox": {"x": 50, "y": 60, "w": 20, "h": 30}},
            {"class_name": "unknown", "confidence": 0.7, "bbox": {"x": 1, "y": 1, "w": 5, "h": 5}},
        ],
        "polygons": [],
    })
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/assets/{aid}/auto-annotate?weight_id={wid}",
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        # 'unknown' class is skipped; case-insensitive 'TRUCK' matches 'truck'
        assert len(body) == 2
        kinds = {a["kind"] for a in body}
        assert kinds == {"bbox"}
        cls_ids = {a["class_id"] for a in body}
        assert cls_ids == {car_id, truck_id}
    finally:
        model_client_mod.set_test_transport(None)


def test_auto_annotate_creates_polygon_annotations(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, aid, wid, car_id, truck_id = _setup_full_world(client, monkeypatch)

    transport = _make_mock_transport({
        "detections": [],
        "polygons": [
            {"class_name": "car", "confidence": 0.9, "points": [[0, 0], [10, 0], [10, 10]]},
            # 2-point polygon should be skipped (need >= 3)
            {"class_name": "car", "confidence": 0.7, "points": [[0, 0], [1, 1]]},
        ],
    })
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/assets/{aid}/auto-annotate?weight_id={wid}",
            headers=_hdr(token),
        )
        assert r.status_code == 200
        body = r.json()
        assert len(body) == 1
        assert body[0]["kind"] == "polygon"
        assert body[0]["geometry"]["points"] == [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]]
    finally:
        model_client_mod.set_test_transport(None)


def test_auto_annotate_overwrite_replaces_existing(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, aid, wid, car_id, _ = _setup_full_world(client, monkeypatch)

    # The auto-annotate path attaches new rows to the asset's idx=0 Frame.
    # Mirror that placement on the seeded annotation so overwrite=true can find it.
    from sqlalchemy import select
    from vaa_api.assets.models import Frame
    frame_id = str(db_session.execute(
        select(Frame.id).where(Frame.asset_id == aid).order_by(Frame.idx).limit(1)
    ).scalar_one())

    # Pre-create one annotation manually via the public POST endpoint
    client.post(
        f"/tasks/{tid}/annotations",
        json={"class_id": car_id, "kind": "bbox", "frame_id": frame_id,
              "geometry": {"kind": "bbox", "x": 99, "y": 99, "w": 9, "h": 9}},
        headers=_hdr(token),
    )

    transport = _make_mock_transport({
        "detections": [
            {"class_name": "car", "confidence": 0.9, "bbox": {"x": 1, "y": 2, "w": 3, "h": 4}},
        ],
        "polygons": [],
    })
    model_client_mod.set_test_transport(transport)
    try:
        # Without overwrite: existing annotation stays
        r = client.post(
            f"/assets/{aid}/auto-annotate?weight_id={wid}&overwrite=false",
            headers=_hdr(token),
        )
        assert r.status_code == 200
        listed = client.get(f"/tasks/{tid}/annotations", headers=_hdr(token)).json()
        assert len(listed) == 2  # original + new

        # With overwrite=true: only the auto-annotated row remains
        r2 = client.post(
            f"/assets/{aid}/auto-annotate?weight_id={wid}&overwrite=true",
            headers=_hdr(token),
        )
        assert r2.status_code == 200
        listed2 = client.get(f"/tasks/{tid}/annotations", headers=_hdr(token)).json()
        # The overwrite removes existing annotations on the asset's frame, so we should
        # see only the freshly created bbox.
        assert len(listed2) == 1
        assert listed2[0]["geometry"]["w"] == 3
    finally:
        model_client_mod.set_test_transport(None)


def test_weight_project_mismatch_returns_400(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, aid, wid, _, _ = _setup_full_world(client, monkeypatch)

    # Create a second project + a weight there
    pid2 = client.post("/projects", json={"name": "Other"}, headers=_hdr(token)).json()["id"]
    fake_pt = b"PK\x03\x04" + b"x" * 1024
    other_wid = client.post(
        f"/projects/{pid2}/weights",
        data={
            "name": "y2",
            "task_kind": "detect",
            "class_names": '["car"]',
        },
        files={"file": ("y2.pt", io.BytesIO(fake_pt), "application/octet-stream")},
        headers=_hdr(token),
    ).json()["id"]

    transport = _make_mock_transport({"detections": [], "polygons": []})
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/assets/{aid}/auto-annotate?weight_id={other_wid}",
            headers=_hdr(token),
        )
        assert r.status_code == 400
        assert r.json()["error"] == "weight_project_mismatch"
    finally:
        model_client_mod.set_test_transport(None)


def test_model_service_failure_returns_502(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, aid, wid, _, _ = _setup_full_world(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"detail": "boom"})

    transport = httpx.MockTransport(handler)
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/assets/{aid}/auto-annotate?weight_id={wid}",
            headers=_hdr(token),
        )
        assert r.status_code == 502
    finally:
        model_client_mod.set_test_transport(None)


def test_unknown_asset_returns_404(db_session, monkeypatch) -> None:
    client = _client(db_session)
    _install_fake_storage(monkeypatch)
    client.post("/auth/register", json={"email": "u@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "u@x.com", "password": "hunter22"}).json()["access_token"]
    import uuid
    r = client.post(
        f"/assets/{uuid.uuid4()}/auto-annotate?weight_id={uuid.uuid4()}",
        headers=_hdr(token),
    )
    assert r.status_code == 404
