"""Tests for the active-learning retrain pipeline (plan-09 task-05).

We exercise:
  * the RQ job entry point (``retrain_job``) directly against a real test DB,
    with mocks for ``model_client.yolo_train`` and the MinIO/Redis layers.
  * the REST enqueue endpoint's input validation (epochs=0 → 422).
  * the GET endpoint's permission gate (unauthenticated → 401, missing Redis
    hash → 404).
"""

from __future__ import annotations

import io
import uuid
from typing import Any

from fastapi.testclient import TestClient

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.models import User, UserRole
from carve_api.deps import get_db
from carve_api.inference import model_client as model_client_mod
from carve_api.jobs import retrain as retrain_mod
from carve_api.jobs.retrain import RetrainJobPayload, retrain_job
from carve_api.main import create_app
from carve_api.projects.models import Class, Project, Task, TaskKind
from carve_api.weights.models import Weight


_PNG_BYTES = bytes.fromhex(
    "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA"
    "63000000000200015C8B59FA0000000049454E44AE426082"
)


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakeStorage:
    """Records put_object/presign calls and serves a tiny PNG for any asset."""

    def __init__(self) -> None:
        self.put_calls: list[tuple[str, int, str]] = []
        self.presign_calls: list[tuple[str, int]] = []
        self.removed: list[str] = []

    @classmethod
    def from_settings(cls):
        return cls()

    def ensure_bucket(self) -> None:
        pass

    def put_object(self, key, body, length, content_type):
        self.put_calls.append((key, length, content_type))

    def get_object(self, key):
        return io.BytesIO(_PNG_BYTES)

    def remove_object(self, key):
        self.removed.append(key)

    def presigned_get(self, key, expires_seconds: int = 600):
        self.presign_calls.append((key, expires_seconds))
        return f"https://fake/{key}?exp={expires_seconds}"

    def presigned_get_internal(self, key, expires_seconds: int = 600):
        self.presign_calls.append((key, expires_seconds))
        return f"https://fake-internal/{key}?exp={expires_seconds}"


class _FakeRedis:
    """In-memory Redis stand-in that records hset/expire/hgetall."""

    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, str]] = {}
        self.phase_history: list[str] = []

    def hset(self, key, *args, mapping=None, **_kw):
        if mapping is not None:
            self.hashes.setdefault(key, {}).update(
                {str(k): str(v) for k, v in mapping.items()}
            )
            if "phase" in mapping:
                self.phase_history.append(str(mapping["phase"]))
            return len(mapping)
        return 0

    def expire(self, key, ttl):
        return True

    def hgetall(self, key):
        return {k.encode(): v.encode() for k, v in self.hashes.get(key, {}).items()}


# ---------------------------------------------------------------------------
# Pipeline test
# ---------------------------------------------------------------------------


def _seed_task_with_one_accepted(db_session) -> tuple[User, Task, Project]:
    u = User(
        email=f"u-{uuid.uuid4()}@x.com",
        password_hash="x",
        role=UserRole.admin,
    )
    db_session.add(u)
    db_session.flush()
    p = Project(name="P", owner_id=u.id)
    db_session.add(p)
    db_session.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image)
    db_session.add(t)
    db_session.flush()
    car = Class(project_id=p.id, idx=0, name="car", color="#ff0000")
    db_session.add(car)
    db_session.flush()

    a = Asset(
        task_id=t.id,
        kind=AssetKind.image,
        xxh3_128="seedhash",
        mime="image/png",
        size_bytes=1,
        width=100,
        height=80,
        frames=1,
        original_name="seed.png",
    )
    db_session.add(a)
    db_session.flush()
    f = Frame(asset_id=a.id, idx=0, pts_ms=0)
    db_session.add(f)
    db_session.flush()

    # Accepted bbox (kept) + rejected bbox (filtered out by status filter).
    ann_accepted = Annotation(
        task_id=t.id,
        frame_id=f.id,
        class_id=car.id,
        kind=AnnotationKind.bbox,
        geometry={"x": 10, "y": 10, "w": 20, "h": 20},
        status="accepted",
    )
    ann_rejected = Annotation(
        task_id=t.id,
        frame_id=f.id,
        class_id=car.id,
        kind=AnnotationKind.bbox,
        geometry={"x": 0, "y": 0, "w": 5, "h": 5},
        status="rejected",
    )
    db_session.add_all([ann_accepted, ann_rejected])
    db_session.flush()
    return u, t, p


def test_retrain_job_pipeline_happy_path(db_session, monkeypatch) -> None:
    u, t, p = _seed_task_with_one_accepted(db_session)

    storage = _FakeStorage()
    redis = _FakeRedis()

    captured: dict[str, Any] = {}

    def fake_yolo_train(*, weight_id_base, dataset_zip_url, epochs, imgsz, device="auto"):
        captured["weight_id_base"] = weight_id_base
        captured["dataset_zip_url"] = dataset_zip_url
        captured["epochs"] = epochs
        captured["imgsz"] = imgsz
        return {
            "weight_id": "abcdef0123456789abcdef0123456789",
            "weights_url": "https://fake-internal/weights/x/y.pt",
            "xxh3_128": "ff" * 16,
            "size_bytes": 1234,
            "metrics": {"metrics/mAP50": 0.5},
        }

    monkeypatch.setattr(model_client_mod, "yolo_train", fake_yolo_train)

    payload = RetrainJobPayload(
        job_id=str(uuid.uuid4()),
        actor_id=str(u.id),
        task_id=str(t.id),
        base_weight_id=None,
        epochs=10,
        imgsz=640,
        include_proposed=False,
        weight_name="my-retrain",
    )

    result = retrain_job(
        payload,
        session=db_session,
        storage=storage,
        redis_client=redis,
    )

    # Result + side-effects.
    assert result["ok"] is True
    assert result["metrics"] == {"metrics/mAP50": 0.5}

    # Dataset zip uploaded to the expected key.
    dataset_keys = [
        k for (k, _len, ctype) in storage.put_calls if ctype == "application/zip"
    ]
    assert dataset_keys == [f"retrain/{t.id}/{payload.job_id}/dataset.zip"]

    # Presigned-internal URL was generated for the dataset (with 4h TTL).
    assert any(
        k == f"retrain/{t.id}/{payload.job_id}/dataset.zip" and exp == 4 * 3600
        for (k, exp) in storage.presign_calls
    )

    # The presigned URL ended up on the model_client call.
    assert captured["dataset_zip_url"].startswith("https://fake-internal/retrain/")
    assert captured["epochs"] == 10
    assert captured["imgsz"] == 640

    # New Weight row created with the right project + class scope.
    new_w = (
        db_session.query(Weight)
        .filter(Weight.id == uuid.UUID(result["weight_id"]))
        .one()
    )
    assert new_w.project_id == p.id
    assert new_w.minio_key == f"weights/{'ff' * 16}/abcdef0123456789abcdef0123456789.pt"
    assert new_w.size_bytes == 1234
    assert new_w.class_names == ["car"]
    assert new_w.name == "my-retrain"

    # Phase progression went through all expected states ending in "done".
    assert redis.phase_history == [
        "exporting",
        "uploading_dataset",
        "training",
        "registering",
        "done",
    ]
    snap = retrain_mod.read_progress(redis, payload.job_id)
    assert snap is not None
    assert snap["phase"] == "done"
    assert snap["progress_pct"] == 100
    assert snap["weight_id"] == result["weight_id"]
    assert snap["error"] is None


# ---------------------------------------------------------------------------
# REST endpoint tests
# ---------------------------------------------------------------------------


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_post_retrain_with_zero_epochs_returns_422(db_session, monkeypatch) -> None:
    """``epochs=0`` is rejected by Pydantic before any work is queued."""
    from carve_api.assets import service as asset_svc_mod

    monkeypatch.setattr(asset_svc_mod, "MinioClient", _FakeStorage)

    client = _client(db_session)
    client.post(
        "/auth/register",
        json={"email": "rt_admin@x.com", "password": "hunter22"},
    )
    token = client.post(
        "/auth/login", json={"email": "rt_admin@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post(
        "/projects", json={"name": "P"}, headers=_hdr(token)
    ).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]

    r = client.post(
        f"/tasks/{tid}/retrain-yolo",
        json={"epochs": 0, "imgsz": 640},
        headers=_hdr(token),
    )
    assert r.status_code == 422


def test_get_retrain_progress_requires_auth(db_session) -> None:
    """Unauthenticated GET is 401 — covers the permission-gate path.

    v1 simplification: every authenticated user can see every project, so
    "non-member 403" effectively reduces to "no auth → 401". The
    require_visible_task helper is still exercised via the 404-when-missing
    test below.
    """
    client = _client(db_session)
    r = client.get(f"/tasks/{uuid.uuid4()}/retrain-yolo/some-job-id")
    assert r.status_code == 401


def test_get_retrain_progress_404_when_unknown(db_session, monkeypatch) -> None:
    """When the Redis hash is absent the endpoint returns 404."""
    from carve_api.assets import service as asset_svc_mod
    from carve_api.inference import retrain_router as rr_mod

    monkeypatch.setattr(asset_svc_mod, "MinioClient", _FakeStorage)
    # Force the redis helper to return None so the endpoint takes the
    # absent-job branch deterministically.
    monkeypatch.setattr(rr_mod, "_redis_client_or_none", lambda: None)

    client = _client(db_session)
    client.post(
        "/auth/register",
        json={"email": "rt_admin2@x.com", "password": "hunter22"},
    )
    token = client.post(
        "/auth/login", json={"email": "rt_admin2@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post(
        "/projects", json={"name": "P"}, headers=_hdr(token)
    ).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]

    r = client.get(
        f"/tasks/{tid}/retrain-yolo/some-job-id",
        headers=_hdr(token),
    )
    assert r.status_code == 404
