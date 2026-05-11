"""Unit + integration tests for run_export_inline (the testable core)."""
import io
import json
import uuid
import zipfile

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.models import User, UserRole
from carve_api.exports.job import ExportJobPayload, run_export_inline
from carve_api.exports.models import Export
from carve_api.projects.models import Class, Project, Task, TaskKind


class _FakeStorage:
    def __init__(self):
        self.uploaded: list[tuple[str, bytes]] = []
        self.objects: dict[str, bytes] = {}

    @classmethod
    def from_settings(cls):
        return cls()

    def ensure_bucket(self):
        pass

    def put_object(self, key, body, length, content_type):
        data = body.read() if hasattr(body, "read") else bytes(body)
        self.uploaded.append((key, data))
        self.objects[key] = data

    def get_object(self, key):
        return io.BytesIO(self.objects.get(key, b""))

    def remove_object(self, key):
        self.objects.pop(key, None)

    def presigned_get(self, key, **k):
        return f"https://fake/{key}"


def _seed(db) -> tuple[User, Task, Asset, Class, Export]:
    u = User(email=f"e-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.admin)
    db.add(u); db.flush()
    p = Project(name="P", owner_id=u.id); db.add(p); db.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image); db.add(t); db.flush()
    a = Asset(
        task_id=t.id, kind=AssetKind.image, xxh3_128=str(uuid.uuid4().hex)[:16],
        mime="image/png", size_bytes=10, width=640, height=480, frames=1,
        original_name="a.png",
    )
    db.add(a); db.flush()
    f = Frame(asset_id=a.id, idx=0, pts_ms=0); db.add(f); db.flush()
    car = Class(project_id=p.id, idx=0, name="car", color="#ff0000"); db.add(car); db.flush()
    db.add(Annotation(
        task_id=t.id, frame_id=f.id, class_id=car.id,
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 50, "y": 50, "w": 100, "h": 80},
        created_by=u.id,
    ))
    db.flush()
    e = Export(
        task_id=t.id, format="yolo",
        class_remap={str(car.id): {"export_id": 0, "name": "vehicle"}},
        created_by=u.id,
    )
    db.add(e); db.flush()
    return u, t, a, car, e


def test_yolo_export_writes_data_yaml_and_label(db_session) -> None:
    u, t, a, car, e = _seed(db_session)
    storage = _FakeStorage()
    payload = ExportJobPayload(
        export_id=str(e.id),
        actor_id=str(u.id),
        task_id=str(t.id),
        fmt="yolo",
        class_remap={str(car.id): {"export_id": 0, "name": "vehicle"}},
        include_images=False,
        splits={"train": 0.8, "val": 0.1, "test": 0.1},
    )
    result = run_export_inline(session=db_session, storage=storage, payload=payload)
    assert result["status"] == "completed"
    assert len(storage.uploaded) == 1
    key, body = storage.uploaded[0]
    # Plan-20.4 — MinIO key embeds the friendly root name.
    assert key.startswith(f"exports/{t.id}/{e.id}/")
    assert key.endswith(".zip")
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        names = set(zf.namelist())
        # Single asset with default 0.8/0.1/0.1 splits collapses to one
        # populated bucket → single_set flatten under training_data/.
        root = next(n.split("/", 1)[0] for n in names if n.endswith("/data.yaml"))
        assert f"{root}/data.yaml" in names
        assert f"{root}/training_data/a.txt" in names
        yaml = zf.read(f"{root}/data.yaml").decode()
        assert "vehicle" in yaml
        assert "nc: 1" in yaml
        label = zf.read(f"{root}/training_data/a.txt").decode()
        # bbox at (50,50,100,80) on 640x480 → cx=0.156250 cy=0.187500 w=0.156250 h=0.166667
        assert label.strip().startswith("0 0.156250 0.187500")


def test_coco_export_writes_coco_json(db_session) -> None:
    u, t, a, car, e = _seed(db_session)
    storage = _FakeStorage()
    e.format = "coco"
    db_session.flush()
    payload = ExportJobPayload(
        export_id=str(e.id),
        actor_id=str(u.id),
        task_id=str(t.id),
        fmt="coco",
        class_remap={str(car.id): {"export_id": 0, "name": "vehicle"}},
        include_images=False,
        splits={"train": 0.8, "val": 0.1, "test": 0.1},
    )
    result = run_export_inline(session=db_session, storage=storage, payload=payload)
    assert result["status"] == "completed"
    _, body = storage.uploaded[0]
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        coco = json.loads(zf.read("coco.json"))
    assert len(coco["images"]) == 1
    assert len(coco["annotations"]) == 1
    assert coco["categories"] == [{"id": 0, "name": "vehicle"}]
    assert coco["annotations"][0]["bbox"] == [50.0, 50.0, 100.0, 80.0]


def test_export_with_include_images_includes_image_bytes(db_session) -> None:
    u, t, a, car, e = _seed(db_session)
    storage = _FakeStorage()
    storage.objects[f"assets/{a.xxh3_128}/original.png"] = b"PNG-IMAGE-BYTES"
    payload = ExportJobPayload(
        export_id=str(e.id),
        actor_id=str(u.id),
        task_id=str(t.id),
        fmt="yolo",
        class_remap={str(car.id): {"export_id": 0, "name": "vehicle"}},
        include_images=True,
        splits={"train": 0.8, "val": 0.1, "test": 0.1},
    )
    run_export_inline(session=db_session, storage=storage, payload=payload)
    _, body = storage.uploaded[0]
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        names = set(zf.namelist())
        # Single asset → single_set flatten: image lives directly under
        # training_data/, not training_data/<split>/.
        root = next(n.split("/", 1)[0] for n in names if n.endswith("/data.yaml"))
        assert f"{root}/training_data/a.png" in names
        assert zf.read(f"{root}/training_data/a.png") == b"PNG-IMAGE-BYTES"


def _seed_two_assets(db) -> tuple[User, Task, list[Asset], Class, Export]:
    """Seed two assets in the same task to exercise split partitioning."""
    u = User(email=f"e-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.admin)
    db.add(u); db.flush()
    p = Project(name="P", owner_id=u.id); db.add(p); db.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image); db.add(t); db.flush()
    car = Class(project_id=p.id, idx=0, name="car", color="#ff0000"); db.add(car); db.flush()
    assets: list[Asset] = []
    for i, name in enumerate(("a.png", "b.png")):
        a = Asset(
            task_id=t.id, kind=AssetKind.image,
            xxh3_128=str(uuid.uuid4().hex)[:16],
            mime="image/png", size_bytes=10, width=640, height=480, frames=1,
            original_name=name,
        )
        db.add(a); db.flush()
        f = Frame(asset_id=a.id, idx=0, pts_ms=0); db.add(f); db.flush()
        db.add(Annotation(
            task_id=t.id, frame_id=f.id, class_id=car.id,
            kind=AnnotationKind.bbox,
            geometry={"kind": "bbox", "x": 10 * (i + 1), "y": 10, "w": 30, "h": 30},
            created_by=u.id,
        ))
        assets.append(a)
    db.flush()
    e = Export(
        task_id=t.id, format="yolo",
        class_remap={str(car.id): {"export_id": 0, "name": "vehicle"}},
        created_by=u.id,
    )
    db.add(e); db.flush()
    return u, t, assets, car, e


def test_yolo_export_partitions_by_splits(db_session) -> None:
    """Splits 0.5/0.5/0 with two assets must produce one train + one val label."""
    u, t, assets, car, e = _seed_two_assets(db_session)
    storage = _FakeStorage()
    payload = ExportJobPayload(
        export_id=str(e.id),
        actor_id=str(u.id),
        task_id=str(t.id),
        fmt="yolo",
        class_remap={str(car.id): {"export_id": 0, "name": "vehicle"}},
        include_images=False,
        splits={"train": 0.5, "val": 0.5, "test": 0.0},
    )
    result = run_export_inline(session=db_session, storage=storage, payload=payload)
    assert result["status"] == "completed"
    _, body = storage.uploaded[0]
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        names = set(zf.namelist())
        root = next(n.split("/", 1)[0] for n in names if n.endswith("/data.yaml"))
        prefix = f"{root}/training_data"
        train_labels = [n for n in names if n.startswith(f"{prefix}/train/") and n.endswith(".txt")]
        val_labels = [n for n in names if n.startswith(f"{prefix}/val/") and n.endswith(".txt")]
        test_labels = [n for n in names if n.startswith(f"{prefix}/test/") and n.endswith(".txt")]
        assert len(train_labels) >= 1, names
        assert len(val_labels) >= 1, names
        assert len(test_labels) == 0, names


def test_export_marks_failed_on_unknown_task(db_session) -> None:
    u, t, _, car, e = _seed(db_session)
    storage = _FakeStorage()
    payload = ExportJobPayload(
        export_id=str(e.id),
        actor_id=str(u.id),
        task_id=str(uuid.uuid4()),  # unknown
        fmt="yolo",
        class_remap={},
        include_images=False,
        splits={"train": 0.8, "val": 0.1, "test": 0.1},
    )
    result = run_export_inline(session=db_session, storage=storage, payload=payload)
    assert result["status"] == "failed"
    refreshed = db_session.get(Export, e.id)
    assert refreshed.status == "failed"
    assert refreshed.error == "task_not_found"


def test_unknown_format_marks_failed(db_session) -> None:
    u, t, _, car, e = _seed(db_session)
    storage = _FakeStorage()
    payload = ExportJobPayload(
        export_id=str(e.id),
        actor_id=str(u.id),
        task_id=str(t.id),
        fmt="bogus",
        class_remap={},
        include_images=False,
        splits={"train": 1.0, "val": 0.0, "test": 0.0},
    )
    result = run_export_inline(session=db_session, storage=storage, payload=payload)
    assert result["status"] == "failed"
    refreshed = db_session.get(Export, e.id)
    assert refreshed.status == "failed"
    # Static error code, not the raw exception message.
    assert refreshed.error == "archive_build_failed"


def test_archive_build_exception_returns_static_code(db_session, monkeypatch) -> None:
    """If the archive builder raises, the persisted Export.error must NOT leak details."""
    from carve_api.exports import job as export_job

    u, t, _, car, e = _seed(db_session)
    storage = _FakeStorage()

    def _boom(**_kwargs):
        raise RuntimeError("internal-detail-with-secrets")

    monkeypatch.setattr(export_job, "_yolo_archive", _boom)

    payload = ExportJobPayload(
        export_id=str(e.id),
        actor_id=str(u.id),
        task_id=str(t.id),
        fmt="yolo",
        class_remap={str(car.id): {"export_id": 0, "name": "vehicle"}},
        include_images=False,
        splits={"train": 0.8, "val": 0.1, "test": 0.1},
    )
    result = run_export_inline(session=db_session, storage=storage, payload=payload)
    assert result["status"] == "failed"
    refreshed = db_session.get(Export, e.id)
    assert refreshed.status == "failed"
    assert refreshed.error == "archive_build_failed"
    assert "internal-detail-with-secrets" not in (refreshed.error or "")
    assert "RuntimeError" not in (refreshed.error or "")
