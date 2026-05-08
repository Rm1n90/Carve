"""Tests for run_auto_visual_batch."""
import uuid
from unittest.mock import patch

from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.models import User, UserRole
from carve_api.inference import batch as batch_mod
from carve_api.projects.models import Class, Project, Task, TaskKind


def _bind_session_factory_to_test_db(db_session, monkeypatch):
    """Make get_session_factory() return a factory bound to the test session."""
    bind = db_session.get_bind()
    from sqlalchemy.orm import sessionmaker

    factory = sessionmaker(bind=bind)
    from carve_api import db as db_mod

    monkeypatch.setattr(db_mod, "get_session_factory", lambda: factory)


def _patch_redis_to_raise(monkeypatch):
    """Make redis.Redis() raise so the worker runs without progress tracking."""
    import builtins

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "redis":

            class StubModule:
                class Redis:
                    def __init__(self, *a, **k):
                        raise ConnectionError("no redis in this test")

            return StubModule
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)


def _seed(db_session):
    """Seed a test project with a task, class, reference asset, and target assets."""
    u = User(email=f"u-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.admin)
    db_session.add(u)
    db_session.flush()
    p = Project(name="P", owner_id=u.id)
    db_session.add(p)
    db_session.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image)
    db_session.add(t)
    db_session.flush()
    cls = Class(project_id=p.id, idx=0, name="cat", color="#ff0000")
    db_session.add(cls)
    db_session.flush()

    # Reference asset (used in sources)
    refer = Asset(
        task_id=t.id,
        kind=AssetKind.image,
        xxh3_128="bb",
        mime="image/png",
        size_bytes=1,
        width=10,
        height=10,
        frames=1,
        original_name="r.png",
    )
    db_session.add(refer)
    db_session.flush()
    db_session.add(Frame(asset_id=refer.id, idx=0, pts_ms=0))

    # Target assets (will have annotations created on them)
    targets = []
    for i, h in enumerate(["aa", "cc"]):
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
        db_session.add(Frame(asset_id=a.id, idx=0, pts_ms=0))
        targets.append(a)
    db_session.flush()
    db_session.commit()
    return u, t, cls, refer, targets


def test_run_auto_visual_batch_completes(db_session, monkeypatch):
    """Run the RQ entry point inline against the test DB.

    The worker calls auto_visual_for_asset, which is mocked to return
    a fake result. The worker should iterate over all assets in the task,
    commit per-asset, and return a summary.
    """
    u, t, cls, refer, targets = _seed(db_session)

    # Mock result from auto_visual_for_asset
    fake_result = {"annotations_created": 1, "per_class": {str(cls.id): 1}}

    _bind_session_factory_to_test_db(db_session, monkeypatch)
    _patch_redis_to_raise(monkeypatch)

    # Build a payload pointing to the reference asset for visual prompts
    payload = batch_mod.AutoVisualBatchPayload(
        job_id=str(uuid.uuid4()),
        actor_id=str(u.id),
        task_id=str(t.id),
        sources=[
            {
                "asset_id": str(refer.id),
                "groups": [
                    {
                        "class_id": str(cls.id),
                        "refs": [{"kind": "bbox", "xyxy": [0, 0, 10, 10]}],
                    }
                ],
            }
        ],
        ref_kind="bbox",
        threshold=0.4,
        find_all=True,
        overwrite=False,
    )

    with patch(
        "carve_api.inference.auto_visual.auto_visual_for_asset",
        return_value=fake_result,
    ):
        result = batch_mod.run_auto_visual_batch(payload)

    assert result["ok"] is True
    # At least 2 target assets will be processed (the refer asset is also in the task)
    # Each sees the mocked auto_visual_for_asset return 1 annotation
    assert result["annotations_created"] >= 2
    assert result["failed"] == 0


def test_run_auto_visual_batch_failed_task(db_session, monkeypatch):
    """Batch fails gracefully when task_id does not exist."""
    _bind_session_factory_to_test_db(db_session, monkeypatch)
    _patch_redis_to_raise(monkeypatch)

    payload = batch_mod.AutoVisualBatchPayload(
        job_id=str(uuid.uuid4()),
        actor_id=str(uuid.uuid4()),
        task_id=str(uuid.uuid4()),  # nonexistent
        sources=[
            {
                "asset_id": str(uuid.uuid4()),
                "groups": [
                    {
                        "class_id": str(uuid.uuid4()),
                        "refs": [{"kind": "bbox", "xyxy": [0, 0, 10, 10]}],
                    }
                ],
            }
        ],
        ref_kind="bbox",
        threshold=0.4,
        find_all=True,
        overwrite=False,
    )

    result = batch_mod.run_auto_visual_batch(payload)
    assert result["ok"] is False
    assert result["error"] == "task_not_found"


def test_build_auto_visual_payload(db_session) -> None:
    """Test that build_auto_visual_payload constructs a valid payload."""
    u = User(email=f"u-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.admin)
    db_session.add(u)
    db_session.flush()
    p = Project(name="P", owner_id=u.id)
    db_session.add(p)
    db_session.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image)
    db_session.add(t)
    db_session.flush()

    sources = [
        {
            "asset_id": str(uuid.uuid4()),
            "groups": [
                {
                    "class_id": str(uuid.uuid4()),
                    "refs": [{"kind": "bbox", "xyxy": [0, 0, 10, 10]}],
                }
            ],
        }
    ]

    payload = batch_mod.build_auto_visual_payload(
        actor=u,
        task=t,
        sources=sources,
        ref_kind="bbox",
        threshold=0.5,
        find_all=True,
        overwrite=False,
    )

    assert isinstance(payload, batch_mod.AutoVisualBatchPayload)
    assert payload.actor_id == str(u.id)
    assert payload.task_id == str(t.id)
    assert payload.ref_kind == "bbox"
    assert payload.threshold == 0.5
    assert payload.find_all is True
    assert payload.overwrite is False
    assert payload.sources == sources
