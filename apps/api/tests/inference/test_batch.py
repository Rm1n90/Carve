"""Tests for batch auto-annotate.

We test build_job_payload (pure) directly. For run_batch_auto_annotate we
exercise the RQ entry point with a real DB but mock the model service via
the existing model_client.set_test_transport pattern, plus a fake redis
client recording calls. No RQ worker is actually started.
"""
import io
import uuid

import httpx

from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.models import User, UserRole
from carve_api.inference import batch as batch_mod
from carve_api.inference import model_client as model_client_mod
from carve_api.projects.models import Class, Project, Task, TaskKind
from carve_api.weights.models import Weight, WeightTaskKind


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
    batch_mod.update_progress(
        r,
        "j1",
        done=2,
        failed=1,
        errors=["x:err"],
        total_annotations_created=7,
        total_skipped_detections=3,
    )
    snap = batch_mod.read_progress(r, "j1")
    assert snap["total"] == 5
    assert snap["done"] == 2
    assert snap["failed"] == 1
    assert snap["errors"] == ["x:err"]
    assert snap["status"] == "running"
    # v3.7.2 — aggregate counts surfaced
    assert snap["total_annotations_created"] == 7
    assert snap["total_skipped_detections"] == 3

    batch_mod.finalize_progress(r, "j1", status="completed")
    final = batch_mod.read_progress(r, "j1")
    assert final["status"] == "completed"


def test_read_progress_without_redis_returns_pending() -> None:
    snap = batch_mod.read_progress(None, "missing")
    # v3.7.2 — default snapshot now includes aggregate-count fields.
    assert snap == {
        "status": "pending",
        "done": 0,
        "total": 0,
        "failed": 0,
        "errors": [],
        "total_annotations_created": 0,
        "total_skipped_detections": 0,
    }


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
    from carve_api import db as db_mod

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
    from carve_api.inference import autoannotate as aa_mod

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


# ---------------------------------------------------------------------------
# v3.7 Phase 2 Issue 1 — batch worker forwards min_confidence + class_overrides
# ---------------------------------------------------------------------------


def test_build_job_payload_threads_confidence_and_overrides(db_session) -> None:
    """``build_job_payload`` must round-trip the new fields onto the
    BatchJobPayload so the RQ worker sees them. v3.7 Phase 2 Issue 1.
    """
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

    overrides = {0: str(uuid.uuid4()), 1: None}
    payload = batch_mod.build_job_payload(
        actor=u,
        task=t,
        weight=w,
        overwrite=False,
        min_confidence=0.42,
        class_overrides=overrides,
    )
    assert payload.min_confidence == 0.42
    assert payload.class_overrides == overrides
    # Defaults still hold when the caller omits the new args.
    payload2 = batch_mod.build_job_payload(actor=u, task=t, weight=w, overwrite=False)
    assert payload2.min_confidence is None
    assert payload2.class_overrides is None


def test_run_batch_forwards_min_confidence_and_class_overrides(
    db_session, monkeypatch
) -> None:
    """The RQ worker must forward both new fields into
    ``auto_annotate_asset(...)`` so the batch path matches the
    single-asset path. v3.7 Phase 2 Issue 1.
    """
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

    a = Asset(
        task_id=t.id,
        kind=AssetKind.image,
        xxh3_128="aa",
        mime="image/png",
        size_bytes=1,
        width=10,
        height=10,
        frames=1,
        original_name="aa.png",
    )
    db_session.add(a)
    db_session.flush()
    f = Frame(asset_id=a.id, idx=0, pts_ms=0)
    db_session.add(f)
    db_session.flush()
    db_session.commit()

    # Capture the kwargs the worker passes to ``auto_annotate_asset``.
    captured: list[dict] = []

    def fake_auto_annotate_asset(**kwargs):
        captured.append(kwargs)

        class _Result:
            annotations: list = []
            annotations_created = 0
            skipped_count = 0
            skipped_by_class: dict = {}

        return _Result()

    monkeypatch.setattr(batch_mod, "auto_annotate_asset", fake_auto_annotate_asset)

    # Stub fetch_asset_bytes so we don't hit MinIO from the test path.
    monkeypatch.setattr(batch_mod, "fetch_asset_bytes", lambda _a: b"x")
    monkeypatch.setattr(batch_mod, "presigned_url_for_weight", lambda _w: "https://fake")

    _bind_session_factory_to_test_db(db_session, monkeypatch)
    _patch_redis_to_raise(monkeypatch)

    project_class_id = str(uuid.uuid4())
    payload = batch_mod.build_job_payload(
        actor=u,
        task=t,
        weight=w,
        overwrite=False,
        min_confidence=0.65,
        class_overrides={0: project_class_id, 1: None},
    )
    result = batch_mod.run_batch_auto_annotate(payload)
    assert result["status"] == "completed"
    assert len(captured) == 1
    kw = captured[0]
    # The worker must thread both fields through.
    assert kw["min_confidence"] == 0.65
    assert kw["class_overrides"] == {
        0: uuid.UUID(project_class_id),
        1: None,
    }


def test_run_batch_omits_new_fields_when_payload_has_defaults(
    db_session, monkeypatch
) -> None:
    """Legacy payloads (no min_confidence / class_overrides) must not
    pass spurious kwargs to ``auto_annotate_asset`` — that would force
    the single-asset code path to receive ``min_confidence=None`` /
    ``class_overrides=None`` even when the caller never specified them.
    """
    u = User(email=f"u-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.admin)
    db_session.add(u)
    db_session.flush()
    p = Project(name="P", owner_id=u.id)
    db_session.add(p)
    db_session.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image)
    db_session.add(t)
    db_session.flush()
    db_session.add(Class(project_id=p.id, idx=0, name="car", color="#ff0000"))
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
    a = Asset(
        task_id=t.id,
        kind=AssetKind.image,
        xxh3_128="bb",
        mime="image/png",
        size_bytes=1,
        width=10,
        height=10,
        frames=1,
        original_name="bb.png",
    )
    db_session.add(a)
    db_session.flush()
    db_session.add(Frame(asset_id=a.id, idx=0, pts_ms=0))
    db_session.flush()
    db_session.commit()

    captured: list[dict] = []

    def fake_auto_annotate_asset(**kwargs):
        captured.append(kwargs)

        class _Result:
            annotations: list = []
            annotations_created = 0
            skipped_count = 0
            skipped_by_class: dict = {}

        return _Result()

    monkeypatch.setattr(batch_mod, "auto_annotate_asset", fake_auto_annotate_asset)
    monkeypatch.setattr(batch_mod, "fetch_asset_bytes", lambda _a: b"x")
    monkeypatch.setattr(batch_mod, "presigned_url_for_weight", lambda _w: "https://fake")
    _bind_session_factory_to_test_db(db_session, monkeypatch)
    _patch_redis_to_raise(monkeypatch)

    payload = batch_mod.build_job_payload(actor=u, task=t, weight=w, overwrite=False)
    batch_mod.run_batch_auto_annotate(payload)
    assert len(captured) == 1
    assert "min_confidence" not in captured[0]
    assert "class_overrides" not in captured[0]


# ---------------------------------------------------------------------------
# v3.7.1 — batch worker commits per asset so partial progress is durable
# ---------------------------------------------------------------------------


def test_run_batch_commits_per_asset(db_session, monkeypatch) -> None:
    """v3.7.1 regression — the batch worker must commit each asset's
    annotations as it goes, not buffer them all until the end. The v3.7
    implementation wrapped the whole loop in ``SessionLocal.begin()``,
    so a worker kill mid-batch (or any later failure) lost every prior
    asset's annotations and only asset 1 ever appeared persisted.

    Strategy: stub ``auto_annotate_asset`` to write a real Annotation row
    via the session it receives, count session.commit() calls, and at
    the end verify all 5 annotations are in the DB.
    """
    from carve_api.annotations.models import Annotation, AnnotationKind

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

    # 5 assets, each with one frame.
    asset_to_frame: dict = {}
    for i in range(5):
        a = Asset(
            task_id=t.id,
            kind=AssetKind.image,
            xxh3_128=f"hash{i}",
            mime="image/png",
            size_bytes=1,
            width=10,
            height=10,
            frames=1,
            original_name=f"img{i}.png",
        )
        db_session.add(a)
        db_session.flush()
        f = Frame(asset_id=a.id, idx=0, pts_ms=0)
        db_session.add(f)
        db_session.flush()
        asset_to_frame[a.id] = f.id
    db_session.commit()

    captured_task_id = t.id  # capture before session changes

    def fake_auto_annotate_asset(*, session, asset, actor, task, weight, **_kwargs):
        # Write a real Annotation row for this asset via the worker's
        # session. If the worker buffers commits to the end, all 5 rows
        # would still appear at the end — but if the v3.7 transaction
        # rolled back due to a later failure, none would. We test the
        # commit semantics by counting per-iteration commits below.
        ann = Annotation(
            task_id=task.id,
            frame_id=asset_to_frame[asset.id],
            class_id=car.id,
            kind=AnnotationKind.bbox,
            geometry={"x": 0, "y": 0, "w": 1, "h": 1},
            created_by=actor.id,
        )
        session.add(ann)
        session.flush()

        class _Result:
            annotations: list = []
            annotations_created = 1
            skipped_count = 0
            skipped_by_class: dict = {}

        return _Result()

    # Wrap Session.commit so we can count how many times the worker committed.
    from sqlalchemy.orm import Session as _Session, sessionmaker

    commit_count = {"n": 0}
    real_commit = _Session.commit

    def counting_commit(self, *a, **kw):
        commit_count["n"] += 1
        return real_commit(self, *a, **kw)

    monkeypatch.setattr(_Session, "commit", counting_commit)

    bind = db_session.get_bind()
    SessionLocal = sessionmaker(
        bind=bind,
        autoflush=False,
        expire_on_commit=False,
        future=True,
        join_transaction_mode="create_savepoint",
    )
    from carve_api import db as db_mod

    monkeypatch.setattr(db_mod, "get_session_factory", lambda: SessionLocal)
    monkeypatch.setattr(batch_mod, "auto_annotate_asset", fake_auto_annotate_asset)
    monkeypatch.setattr(batch_mod, "fetch_asset_bytes", lambda _a: b"x")
    monkeypatch.setattr(batch_mod, "presigned_url_for_weight", lambda _w: "https://fake")
    _patch_redis_to_raise(monkeypatch)

    pre_commits = commit_count["n"]
    payload = batch_mod.build_job_payload(actor=u, task=t, weight=w, overwrite=False)
    result = batch_mod.run_batch_auto_annotate(payload)

    assert result["status"] == "completed"
    assert result["done"] == 5
    assert result["failed"] == 0
    assert result["total"] == 5

    # The worker should have called commit() once per asset (≥5 commits).
    # The v3.7 implementation called .commit() exactly once at end-of-with.
    delta = commit_count["n"] - pre_commits
    assert delta >= 5, (
        f"expected ≥5 per-asset commits, got {delta} — batch is still "
        "buffering all rows in a single transaction"
    )

    # All 5 annotations must be persisted in the DB.
    rows = (
        db_session.query(Annotation)
        .filter(Annotation.task_id == captured_task_id)
        .all()
    )
    assert len(rows) == 5, (
        f"expected 5 annotations persisted, got {len(rows)} — earlier "
        "asset annotations were lost"
    )


# ---------------------------------------------------------------------------
# v3.7.2 — batch worker aggregates created/skipped counts across assets
# ---------------------------------------------------------------------------


def test_run_batch_aggregates_created_and_skipped_counts(
    db_session, monkeypatch
) -> None:
    """v3.7.2 — the batch worker must sum per-asset created + skipped
    counts and surface them on the final return dict (and in the
    Redis-progress hash) so the frontend can render a clear post-batch
    toast like "Created 0 annotations across 3 of 3 assets — skipped 9
    detections (unmapped)".
    """
    u = User(email=f"u-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.admin)
    db_session.add(u)
    db_session.flush()
    p = Project(name="P", owner_id=u.id)
    db_session.add(p)
    db_session.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image)
    db_session.add(t)
    db_session.flush()
    db_session.add(Class(project_id=p.id, idx=0, name="car", color="#ff0000"))
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

    # 3 assets — per-asset stub returns: (2 created, 1 skipped) each, so
    # the aggregates should be (6 created, 3 skipped).
    for i in range(3):
        a = Asset(
            task_id=t.id,
            kind=AssetKind.image,
            xxh3_128=f"agg{i}",
            mime="image/png",
            size_bytes=1,
            width=10,
            height=10,
            frames=1,
            original_name=f"agg{i}.png",
        )
        db_session.add(a)
        db_session.flush()
        db_session.add(Frame(asset_id=a.id, idx=0, pts_ms=0))
        db_session.flush()
    db_session.commit()

    def fake_auto_annotate_asset(**_kwargs):
        class _Result:
            annotations: list = []
            annotations_created = 2
            skipped_count = 1
            skipped_by_class: dict = {"unknown": 1}
            overwrite_skipped = False

        return _Result()

    monkeypatch.setattr(batch_mod, "auto_annotate_asset", fake_auto_annotate_asset)
    monkeypatch.setattr(batch_mod, "fetch_asset_bytes", lambda _a: b"x")
    monkeypatch.setattr(batch_mod, "presigned_url_for_weight", lambda _w: "https://fake")
    _bind_session_factory_to_test_db(db_session, monkeypatch)
    _patch_redis_to_raise(monkeypatch)

    payload = batch_mod.build_job_payload(actor=u, task=t, weight=w, overwrite=False)
    result = batch_mod.run_batch_auto_annotate(payload)

    assert result["status"] == "completed"
    assert result["done"] == 3
    assert result["failed"] == 0
    assert result["total"] == 3
    # v3.7.2 — aggregate counts surfaced on the final return dict.
    assert result["total_annotations_created"] == 6
    assert result["total_skipped_detections"] == 3


def test_run_batch_aggregates_persist_to_progress_hash(db_session, monkeypatch) -> None:
    """v3.7.2 — the worker writes the aggregate counts to the Redis
    progress hash on every iteration so a polling client (the frontend
    overlay) sees them grow as the batch runs.
    """
    u = User(email=f"u-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.admin)
    db_session.add(u)
    db_session.flush()
    p = Project(name="P", owner_id=u.id)
    db_session.add(p)
    db_session.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image)
    db_session.add(t)
    db_session.flush()
    db_session.add(Class(project_id=p.id, idx=0, name="car", color="#ff0000"))
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
    a = Asset(
        task_id=t.id,
        kind=AssetKind.image,
        xxh3_128="agg_p",
        mime="image/png",
        size_bytes=1,
        width=10,
        height=10,
        frames=1,
        original_name="agg_p.png",
    )
    db_session.add(a)
    db_session.flush()
    db_session.add(Frame(asset_id=a.id, idx=0, pts_ms=0))
    db_session.flush()
    db_session.commit()

    fake = _FakeRedis()

    # Stub out the inner Redis() so the worker uses our fake.
    import builtins

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "redis":
            class StubModule:
                class Redis:
                    def __init__(self, *_a, **_k):
                        pass

                    def hset(self, *a, **k):
                        return fake.hset(*a, **k)

                    def expire(self, *a, **k):
                        return fake.expire(*a, **k)

                    def hgetall(self, *a, **k):
                        return fake.hgetall(*a, **k)

            return StubModule
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    def fake_auto_annotate_asset(**_kwargs):
        class _Result:
            annotations: list = []
            annotations_created = 4
            skipped_count = 2
            skipped_by_class: dict = {"unknown": 2}
            overwrite_skipped = False

        return _Result()

    monkeypatch.setattr(batch_mod, "auto_annotate_asset", fake_auto_annotate_asset)
    monkeypatch.setattr(batch_mod, "fetch_asset_bytes", lambda _a: b"x")
    monkeypatch.setattr(batch_mod, "presigned_url_for_weight", lambda _w: "https://fake")
    _bind_session_factory_to_test_db(db_session, monkeypatch)

    payload = batch_mod.build_job_payload(actor=u, task=t, weight=w, overwrite=False)
    batch_mod.run_batch_auto_annotate(payload)

    snap = batch_mod.read_progress(
        # Use the same fake redis to read what the worker wrote.
        type("R", (), {
            "hgetall": lambda self, key: fake.hgetall(key),
        })(),
        payload.job_id,
    )
    assert snap["total_annotations_created"] == 4
    assert snap["total_skipped_detections"] == 2
