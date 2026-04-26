"""Unit tests for import_drafts (the pure DB part) and progress helpers."""
import io
import json
import uuid

from vaa_api.annotations.models import AnnotationKind
from vaa_api.assets.models import Asset, AssetKind, Frame
from vaa_api.auth.models import User, UserRole
from vaa_api.io.import_job import (
    _build_asset_map, _build_class_map, _build_dim_map,
    finalize_progress, import_drafts, init_progress, progress_key,
    read_progress, update_progress,
)
from vaa_api.io.yolo_in import AnnotationDraft
from vaa_api.projects.models import Class, Project, Task, TaskKind


class _FakeRedis:
    def __init__(self):
        self.hashes: dict[str, dict] = {}

    def hset(self, key, field=None, value=None, *, mapping=None, **kw):
        # Support both `hset(key, mapping={...})` and `hset(key, field, value)`.
        if mapping is not None:
            self.hashes.setdefault(key, {}).update(
                {str(k): str(v) for k, v in mapping.items()}
            )
            return len(mapping)
        if field is not None and value is not None:
            self.hashes.setdefault(key, {})[str(field)] = str(value)
            return 1
        if kw:
            self.hashes.setdefault(key, {}).update(
                {str(k): str(v) for k, v in kw.items()}
            )
            return len(kw)
        return 0

    def expire(self, key, ttl):
        pass

    def hgetall(self, key):
        return {k.encode(): str(v).encode() for k, v in self.hashes.get(key, {}).items()}


def test_progress_key_format() -> None:
    assert progress_key("abc-123") == "imp:job:abc-123"


def test_progress_lifecycle_with_fake_redis() -> None:
    r = _FakeRedis()
    init_progress(r, "j1", total=5)
    update_progress(r, "j1", done=3, warnings=["x: missing"])
    snap = read_progress(r, "j1")
    assert snap["status"] == "running"
    assert snap["total"] == 5
    assert snap["done"] == 3
    assert snap["warnings"] == ["x: missing"]
    finalize_progress(r, "j1", status="completed")
    final = read_progress(r, "j1")
    assert final["status"] == "completed"


def test_progress_no_redis_returns_pending() -> None:
    snap = read_progress(None, "missing")
    assert snap == {"status": "pending", "done": 0, "total": 0, "warnings": []}


def _setup(db):
    u = User(email=f"u-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.admin)
    db.add(u); db.flush()
    p = Project(name="P", owner_id=u.id); db.add(p); db.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image); db.add(t); db.flush()
    a = Asset(
        task_id=t.id, kind=AssetKind.image, xxh3_128=str(uuid.uuid4().hex)[:16],
        mime="image/png", size_bytes=1, width=640, height=480, frames=1,
        original_name="a.png",
    )
    db.add(a); db.flush()
    f = Frame(asset_id=a.id, idx=0, pts_ms=0); db.add(f); db.flush()
    car = Class(project_id=p.id, idx=0, name="car", color="#ff0000")
    db.add(car); db.flush()
    return u, t, a, car


def test_import_drafts_inserts_matched_rows(db_session) -> None:
    u, t, a, car = _setup(db_session)
    drafts = [
        AnnotationDraft(
            image_filename="a",
            class_name="CAR",  # case-insensitive match
            kind=AnnotationKind.bbox,
            geometry={"kind": "bbox", "x": 10, "y": 10, "w": 5, "h": 5},
        ),
    ]
    classes_by_name = _build_class_map([car])
    assets_by_filename = _build_asset_map([a])
    created, warnings = import_drafts(
        session=db_session,
        actor_id=u.id,
        task=t,
        drafts=drafts,
        classes_by_lower_name=classes_by_name,
        assets_by_filename=assets_by_filename,
    )
    assert created == 1
    assert warnings == []


def test_import_drafts_warns_on_unknown_class(db_session) -> None:
    u, t, a, car = _setup(db_session)
    drafts = [
        AnnotationDraft(
            image_filename="a",
            class_name="bicycle",  # not in project
            kind=AnnotationKind.bbox,
            geometry={"kind": "bbox", "x": 1, "y": 1, "w": 5, "h": 5},
        ),
    ]
    created, warnings = import_drafts(
        session=db_session,
        actor_id=u.id,
        task=t,
        drafts=drafts,
        classes_by_lower_name=_build_class_map([car]),
        assets_by_filename=_build_asset_map([a]),
    )
    assert created == 0
    assert any("bicycle" in w for w in warnings)


def test_import_drafts_warns_on_unknown_asset(db_session) -> None:
    u, t, a, car = _setup(db_session)
    drafts = [
        AnnotationDraft(
            image_filename="missing",
            class_name="car",
            kind=AnnotationKind.bbox,
            geometry={"kind": "bbox", "x": 1, "y": 1, "w": 5, "h": 5},
        ),
    ]
    created, warnings = import_drafts(
        session=db_session,
        actor_id=u.id,
        task=t,
        drafts=drafts,
        classes_by_lower_name=_build_class_map([car]),
        assets_by_filename=_build_asset_map([a]),
    )
    assert created == 0
    assert any("missing" in w for w in warnings)


def test_build_asset_map_handles_extension_and_stem() -> None:
    a = Asset(
        task_id=uuid.uuid4(), kind=AssetKind.image, xxh3_128="x" * 16,
        mime="image/png", size_bytes=1, width=10, height=10, frames=1,
        original_name="Photo.PNG",
    )
    m = _build_asset_map([a])
    assert "photo.png" in m
    assert "photo" in m


def test_build_dim_map_skips_assets_without_dims() -> None:
    no_dims = Asset(
        task_id=uuid.uuid4(), kind=AssetKind.video, xxh3_128="y" * 16,
        mime="video/mp4", size_bytes=1, width=None, height=None, frames=0,
        original_name="v.mp4",
    )
    m = _build_dim_map([no_dims])
    assert m == {}
