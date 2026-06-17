import io

from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.main import create_app


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
    def get_object(self, key): return io.BytesIO(_tiny_png())
    def remove_object(self, key): pass
    def presigned_get(self, key, **k): return f"https://fake/{key}"


def _setup(client, monkeypatch):
    from carve_api.assets import service as assets_svc
    from carve_api.exports import router as router_mod
    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(router_mod, "MinioClient", _FakeStorage)

    client.post("/auth/register", json={"email": "ex@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "ex@x.com", "password": "hunter22"}).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(token)).json()["id"]
    car = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "car", "color": "#ff0000"},
        headers=_hdr(token),
    ).json()
    return token, pid, tid, car["id"]


def test_create_export_returns_id_and_pending(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, car_id = _setup(client, monkeypatch)
    r = client.post(
        f"/tasks/{tid}/exports",
        json={
            "format": "yolo",
            "class_remap": {car_id: {"export_id": 0, "name": "vehicle"}},
            "splits": {"train": 0.8, "val": 0.1, "test": 0.1},
            "include_images": False,
        },
        headers=_hdr(token),
    )
    assert r.status_code == 202, r.text
    body = r.json()
    assert "export_id" in body

    # GET should report pending status (no Redis worker actually ran)
    r2 = client.get(f"/tasks/{tid}/exports/{body['export_id']}", headers=_hdr(token))
    assert r2.status_code == 200
    snap = r2.json()
    assert snap["status"] == "pending"
    assert snap["download_url"] is None


def test_export_enqueues_through_enqueue_with_defaults(db_session, monkeypatch) -> None:
    """Regression: the export job MUST be enqueued via enqueue_with_defaults so
    the per-callable job_timeout (run_export_job -> 2h) is applied. A raw
    q.enqueue() leaves RQ's 180s default, which SIGKILLs large segmentation
    exports mid-build and leaves the Export row stuck at 'pending' forever.
    """
    from carve_api.exports import router as router_mod
    from carve_api.exports.job import run_export_job

    client = _client(db_session)
    token, pid, tid, car_id = _setup(client, monkeypatch)

    # Force the enqueue branch to run (no real Redis in tests).
    monkeypatch.setattr(router_mod, "_redis_client_or_none", lambda: object())

    calls = {}

    def _recording_enqueue(queue, fn, *args, **kwargs):
        calls["fn"] = fn
        calls["args"] = args
        return None

    # The router lazy-imports enqueue_with_defaults from carve_api.jobs.queue
    # inside the handler, so patch it at the source module — the function-local
    # ``from ... import`` then resolves to this recorder.
    monkeypatch.setattr(
        "carve_api.jobs.queue.enqueue_with_defaults", _recording_enqueue
    )
    # Neutralise the real Queue ctor (we only care that the defaults path is used).
    monkeypatch.setattr("rq.Queue", lambda *a, **k: object())

    r = client.post(
        f"/tasks/{tid}/exports",
        json={
            "format": "yolo",
            "class_remap": {car_id: {"export_id": 0, "name": "vehicle"}},
            "splits": {"train": 1.0, "val": 0.0, "test": 0.0},
            "include_images": True,
        },
        headers=_hdr(token),
    )
    assert r.status_code == 202, r.text
    assert calls.get("fn") is run_export_job


def test_export_unknown_id_returns_404(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, _ = _setup(client, monkeypatch)
    import uuid
    r = client.get(f"/tasks/{tid}/exports/{uuid.uuid4()}", headers=_hdr(token))
    assert r.status_code == 404


def test_unknown_task_returns_404(db_session, monkeypatch) -> None:
    client = _client(db_session)
    from carve_api.assets import service as assets_svc
    from carve_api.exports import router as router_mod
    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(router_mod, "MinioClient", _FakeStorage)
    client.post("/auth/register", json={"email": "u@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "u@x.com", "password": "hunter22"}).json()["access_token"]
    import uuid
    r = client.post(
        f"/tasks/{uuid.uuid4()}/exports",
        json={"format": "yolo", "class_remap": {}, "splits": {"train": 0.8, "val": 0.1, "test": 0.1}, "include_images": False},
        headers=_hdr(token),
    )
    assert r.status_code == 404


def test_invalid_format_rejected_by_validation(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, _ = _setup(client, monkeypatch)
    r = client.post(
        f"/tasks/{tid}/exports",
        json={"format": "bogus", "class_remap": {}, "splits": {"train": 0.8, "val": 0.1, "test": 0.1}, "include_images": False},
        headers=_hdr(token),
    )
    assert r.status_code == 422


def test_splits_sum_not_one_rejected(db_session, monkeypatch) -> None:
    """Splits whose train+val+test does not sum to 1.0 must be rejected (422)."""
    client = _client(db_session)
    token, pid, tid, _ = _setup(client, monkeypatch)
    r = client.post(
        f"/tasks/{tid}/exports",
        json={
            "format": "yolo",
            "class_remap": {},
            "splits": {"train": 0.6, "val": 0.6, "test": 0.0},
            "include_images": False,
        },
        headers=_hdr(token),
    )
    assert r.status_code == 422
