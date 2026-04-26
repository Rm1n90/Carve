"""Tests for batch auto-annotate.

We test build_job_payload (pure) directly. For run_batch_auto_annotate we
exercise the RQ entry point with a real DB but mock the model service via
the existing model_client.set_test_transport pattern, plus a fake redis
client recording calls. No RQ worker is actually started.
"""
import io
import uuid

import httpx

from vaa_api.assets.models import Asset, AssetKind, Frame
from vaa_api.auth.models import User, UserRole
from vaa_api.inference import batch as batch_mod
from vaa_api.inference import model_client as model_client_mod
from vaa_api.projects.models import Class, Project, Task, TaskKind
from vaa_api.weights.models import Weight, WeightTaskKind


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


def _tiny_png() -> bytes:
    return bytes.fromhex(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA63000000000200015C8B59FA0000000049454E44AE426082"
    )


class _FakeRedis:
    """In-memory Redis stand-in. Records hset/expire/hgetall."""

    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, str]] = {}

    def hset(self, key, field=None, value=None, *, mapping=None, **_kw) -> int:
        # Support both `hset(key, mapping={...})` and `hset(key, field, value)`.
        if mapping is not None:
            self.hashes.setdefault(key, {}).update(
                {str(k): str(v) for k, v in mapping.items()}
            )
            return len(mapping)
        if field is not None and value is not None:
            self.hashes.setdefault(key, {})[str(field)] = str(value)
            return 1
        return 0

    def expire(self, key, ttl) -> bool:
        return True

    def hgetall(self, key) -> dict[bytes, bytes]:
        return {
            k.encode(): str(v).encode() for k, v in self.hashes.get(key, {}).items()
        }


def test_progress_key_format() -> None:
    assert batch_mod.progress_key("abc-123") == "aa:job:abc-123"


def test_build_job_payload(db_session) -> None:
    u = User(email=f"u-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.admin)
    db_session.add(u)
    db_session.flush()
    p = Project(name="P", owner_id=u.id)
    db_session.add(p)
    db_session.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image)
    db_session.add(t)
    db_session.flush()
    w = Weight(
        project_id=p.id,
        name="y",
        task_kind=WeightTaskKind.detect,
        minio_key="weights/abc/x.pt",
        size_bytes=1,
        class_names=["car"],
    )
    db_session.add(w)
    db_session.flush()

    payload = batch_mod.build_job_payload(actor=u, task=t, weight=w, overwrite=True)
    assert payload.actor_id == str(u.id)
    assert payload.task_id == str(t.id)
    assert payload.weight_id == str(w.id)
    assert payload.overwrite is True
    # job_id is a fresh uuid
    uuid.UUID(payload.job_id)


def test_init_and_read_progress_with_fake_redis() -> None:
    r = _FakeRedis()
    batch_mod.init_progress(r, "j1", total=5)
    batch_mod.update_progress(r, "j1", done=2, failed=1, errors=["x:err"])
    snap = batch_mod.read_progress(r, "j1")
    assert snap["total"] == 5
    assert snap["done"] == 2
    assert snap["failed"] == 1
    assert snap["errors"] == ["x:err"]
    assert snap["status"] == "running"

    batch_mod.finalize_progress(r, "j1", status="completed")
    final = batch_mod.read_progress(r, "j1")
    assert final["status"] == "completed"


def test_read_progress_without_redis_returns_pending() -> None:
    snap = batch_mod.read_progress(None, "missing")
    assert snap == {"status": "pending", "done": 0, "total": 0, "failed": 0, "errors": []}


def _patch_redis_to_raise(monkeypatch) -> None:
    """Make `from redis import Redis` import a stub that raises when Redis() is called."""
    import builtins

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "redis":
            class StubModule:
                class Redis:
                    def __init__(self, *a, **k):
                        raise OSError("no redis")

            return StubModule
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)


def _bind_session_factory_to_test_db(db_session, monkeypatch):
    """Make `get_session_factory()` return a factory bound to the same connection
    as db_session, so the RQ job sees the rows we just seeded.
    """
    bind = db_session.get_bind()
    from sqlalchemy.orm import sessionmaker

    SessionLocal = sessionmaker(
        bind=bind,
        autoflush=False,
        expire_on_commit=False,
        future=True,
        join_transaction_mode="create_savepoint",
    )
    from vaa_api import db as db_mod

    monkeypatch.setattr(db_mod, "get_session_factory", lambda: SessionLocal)


def test_run_batch_auto_annotate_processes_all_assets(db_session, monkeypatch) -> None:
    """Run the RQ entry point inline against the test DB.

    Mocks: storage (FakeStorage), model service HTTP (httpx MockTransport),
    Redis (None — no progress writes), and get_session_factory so that
    SessionLocal returns the test session.
    """
    # Set up project/task/weight/classes/assets
    u = User(email=f"u-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.admin)
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
    w = Weight(
        project_id=p.id,
        name="y",
        task_kind=WeightTaskKind.detect,
        minio_key="weights/abc/x.pt",
        size_bytes=1,
        class_names=["car"],
    )
    db_session.add(w)
    db_session.flush()

    # Two assets so the loop runs twice
    for h in ["aa", "bb"]:
        a = Asset(
            task_id=t.id,
            kind=AssetKind.image,
            xxh3_128=h,
            mime="image/png",
            size_bytes=1,
            width=10,
            height=10,
            frames=1,
            original_name=f"{h}.png",
        )
        db_session.add(a)
        db_session.flush()
        f = Frame(asset_id=a.id, idx=0, pts_ms=0)
        db_session.add(f)
        db_session.flush()
    db_session.flush()
    # Release the savepoint so a new session bound to the same connection
    # sees the seeded rows.
    db_session.commit()

    # Mock storage on autoannotate
    from vaa_api.inference import autoannotate as aa_mod

    monkeypatch.setattr(aa_mod, "MinioClient", _FakeStorage)

    # Mock model service
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/yolo/load":
            return httpx.Response(200, json={"loaded": "ok"})
        if request.url.path == "/yolo/predict":
            return httpx.Response(
                200,
                json={
                    "detections": [
                        {
                            "class_name": "car",
                            "confidence": 0.9,
                            "bbox": {"x": 1, "y": 2, "w": 3, "h": 4},
                        },
                    ],
                    "polygons": [],
                },
            )
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    model_client_mod.set_test_transport(transport)

    _bind_session_factory_to_test_db(db_session, monkeypatch)
    _patch_redis_to_raise(monkeypatch)

    payload = batch_mod.build_job_payload(actor=u, task=t, weight=w, overwrite=False)
    try:
        result = batch_mod.run_batch_auto_annotate(payload)
        assert result["status"] == "completed"
        assert result["done"] == 2
        assert result["failed"] == 0
        assert result["total"] == 2
    finally:
        model_client_mod.set_test_transport(None)


def test_run_batch_with_missing_actor_returns_failed(db_session, monkeypatch) -> None:
    _bind_session_factory_to_test_db(db_session, monkeypatch)
    _patch_redis_to_raise(monkeypatch)

    payload = batch_mod.BatchJobPayload(
        job_id="j-missing",
        actor_id=str(uuid.uuid4()),
        task_id=str(uuid.uuid4()),
        weight_id=str(uuid.uuid4()),
        overwrite=False,
    )
    result = batch_mod.run_batch_auto_annotate(payload)
    assert result["status"] == "failed"
