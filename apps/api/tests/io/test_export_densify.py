"""Unit + integration tests for v3.2 Issue 5 — class index densification.

When a project has sparse class indices (e.g. 0, 2, 4 because the user
deleted some classes), the frontend currently seeds the export's
``class_remap`` with those sparse indices verbatim. Without densification
the YOLO label files reference indices like ``2`` and ``4`` while
``data.yaml`` ``names`` is a length-3 array — IndexError or garbage labels.

These tests pin the post-fix wire format:
- YOLO label lines reference dense 0..N-1 indices.
- ``data.yaml`` ``nc`` matches the dense count and ``names`` has exactly
  that many entries.
- ``classes.json`` includes both ``idx`` (original project class.idx) and
  ``export_idx`` (the dense index actually used in this export).
"""

import io
import json
import uuid
import zipfile

import pytest

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.models import User, UserRole
from carve_api.exports.job import (
    ExportJobPayload,
    _densify_remap,
    build_classes_manifest,
    run_export_inline,
)
from carve_api.exports.models import Export
from carve_api.projects.models import Class, Project, Task, TaskKind


class _FakeStorage:
    def __init__(self):
        self.uploaded: list[tuple[str, bytes]] = []
        self.objects: dict[str, bytes] = {}

    def ensure_bucket(self):
        pass

    def put_object(self, key, body, length, content_type):
        data = body.read() if hasattr(body, "read") else bytes(body)
        self.uploaded.append((key, data))
        self.objects[key] = data

    def get_object(self, key):
        return io.BytesIO(self.objects.get(key, b""))


# ---------------------------------------------------------------------------
# _densify_remap — pure unit tests (no DB)
# ---------------------------------------------------------------------------


def test_densify_remap_compresses_sparse_ids_to_dense() -> None:
    # Arrange — three project classes at sparse export ids 0, 2, 4 (matches
    # the user's idx values from a project where idx=1 and idx=3 were deleted).
    cid_a = "11111111-1111-1111-1111-111111111111"
    cid_b = "22222222-2222-2222-2222-222222222222"
    cid_c = "33333333-3333-3333-3333-333333333333"
    remap = {
        cid_a: {"export_id": 0, "name": "person"},
        cid_b: {"export_id": 2, "name": "car"},
        cid_c: {"export_id": 4, "name": "bicycle"},
    }

    # Act
    dense = _densify_remap(remap)

    # Assert — dense ids are 0, 1, 2 in user-supplied order.
    assert dense[cid_a] == {"export_id": 0, "name": "person"}
    assert dense[cid_b] == {"export_id": 1, "name": "car"}
    assert dense[cid_c] == {"export_id": 2, "name": "bicycle"}


def test_densify_remap_drops_skipped_and_none_entries() -> None:
    # Arrange
    cid_a = "11111111-1111-1111-1111-111111111111"
    cid_b = "22222222-2222-2222-2222-222222222222"
    cid_c = "33333333-3333-3333-3333-333333333333"
    cid_d = "44444444-4444-4444-4444-444444444444"
    remap = {
        cid_a: {"export_id": 0, "name": "person"},
        cid_b: None,  # explicitly skipped (legacy shape)
        cid_c: {"export_id": 2, "name": "car"},
        cid_d: {"export_id": 99, "name": "dropped", "skip": True},
    }

    # Act
    dense = _densify_remap(remap)

    # Assert — only kept classes appear; ids are 0..N-1.
    assert set(dense.keys()) == {cid_a, cid_c}
    assert dense[cid_a]["export_id"] == 0
    assert dense[cid_c]["export_id"] == 1


def test_densify_remap_preserves_user_intended_ordering() -> None:
    # Arrange — user wants car first (export_id=5), person second (export_id=10).
    cid_person = "11111111-1111-1111-1111-111111111111"
    cid_car = "22222222-2222-2222-2222-222222222222"
    remap = {
        cid_person: {"export_id": 10, "name": "person"},
        cid_car: {"export_id": 5, "name": "car"},
    }

    # Act
    dense = _densify_remap(remap)

    # Assert — car gets dense 0 (lower user-supplied export_id), person 1.
    assert dense[cid_car]["export_id"] == 0
    assert dense[cid_person]["export_id"] == 1


def test_densify_remap_rejects_malformed_entry() -> None:
    # Arrange
    remap = {"x": {"export_id": 0}}  # missing "name"
    # Act / Assert
    with pytest.raises(ValueError, match="invalid remap entry"):
        _densify_remap(remap)


# ---------------------------------------------------------------------------
# build_classes_manifest — densified_remap surface
# ---------------------------------------------------------------------------


def _fake_class(idx: int, name: str, color: str = "#000000"):
    """Build a duck-typed object exposing the attrs build_classes_manifest reads."""

    class _C:
        pass

    c = _C()
    c.id = uuid.uuid4()
    c.idx = idx
    c.name = name
    c.color = color
    return c


def test_classes_manifest_with_densified_remap_carries_export_idx() -> None:
    # Arrange — three classes with sparse idx; only two participate in export.
    c0 = _fake_class(0, "person")
    c2 = _fake_class(2, "car")
    c4 = _fake_class(4, "bicycle")
    classes = [c0, c2, c4]
    densified = {
        str(c0.id): {"export_id": 0, "name": "person"},
        str(c4.id): {"export_id": 1, "name": "bicycle"},
    }

    # Act
    manifest = build_classes_manifest(classes, densified_remap=densified)

    # Assert — every entry carries idx and export_idx; included entries first.
    assert all("idx" in e and "export_idx" in e for e in manifest)
    included = [e for e in manifest if e["export_idx"] is not None]
    excluded = [e for e in manifest if e["export_idx"] is None]
    assert [e["name"] for e in included] == ["person", "bicycle"]
    assert [e["export_idx"] for e in included] == [0, 1]
    assert len(excluded) == 1
    assert excluded[0]["name"] == "car"
    assert excluded[0]["idx"] == 2


def test_classes_manifest_without_densified_remap_omits_export_idx() -> None:
    # Arrange
    classes = [_fake_class(0, "a"), _fake_class(1, "b")]

    # Act
    manifest = build_classes_manifest(classes)

    # Assert — backward compatible: no export_idx field.
    assert all("export_idx" not in e for e in manifest)


# ---------------------------------------------------------------------------
# Integration — sparse project class indices, end-to-end YOLO archive
# ---------------------------------------------------------------------------


def _seed_sparse_classes(db) -> tuple[User, Task, Asset, list[Class], Export]:
    """Seed three classes at sparse idx (0, 2, 4) plus one annotation per class."""
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

    classes: list[Class] = []
    # Sparse idx values: 0, 2, 4 (simulates a project where idx=1 and idx=3
    # got deleted at some point).
    for idx, name, color in [
        (0, "person", "#EF4444"),
        (2, "car", "#3B82F6"),
        (4, "bicycle", "#10B981"),
    ]:
        c = Class(project_id=p.id, idx=idx, name=name, color=color)
        db.add(c); db.flush()
        classes.append(c)
        db.add(Annotation(
            task_id=t.id, frame_id=f.id, class_id=c.id,
            kind=AnnotationKind.bbox,
            geometry={
                "kind": "bbox",
                "x": 10 + idx * 10, "y": 10, "w": 30, "h": 30,
            },
            created_by=u.id,
        ))
    db.flush()

    # The frontend builds class_remap with export_id seeded from c.idx — so
    # the WIRE payload contains sparse export_ids 0/2/4. The densifier must
    # collapse these to 0/1/2 server-side.
    remap = {
        str(c.id): {"export_id": int(c.idx), "name": c.name}
        for c in classes
    }
    e = Export(
        task_id=t.id, format="yolo", class_remap=remap, created_by=u.id,
    )
    db.add(e); db.flush()
    return u, t, a, classes, e


def test_yolo_export_densifies_label_indices(db_session) -> None:
    # Arrange
    u, t, _a, classes, e = _seed_sparse_classes(db_session)
    storage = _FakeStorage()
    payload = ExportJobPayload(
        export_id=str(e.id),
        actor_id=str(u.id),
        task_id=str(t.id),
        fmt="yolo",
        class_remap={
            str(c.id): {"export_id": int(c.idx), "name": c.name}
            for c in classes
        },
        include_images=False,
        splits={"train": 1.0, "val": 0.0, "test": 0.0},
    )

    # Act
    result = run_export_inline(session=db_session, storage=storage, payload=payload)

    # Assert
    assert result["status"] == "completed"
    _, body = storage.uploaded[0]
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        names = set(zf.namelist())
        # Single asset → split 1.0/0/0 → train bucket.
        label_files = [n for n in names if n.startswith("labels/train/")]
        assert label_files, names
        label = zf.read(label_files[0]).decode().strip().splitlines()
        # Three annotations, one per class. Each line starts with the dense
        # class index. With sparse remap (0,2,4) the OLD code would write
        # 0/2/4; the densified code MUST write 0/1/2.
        line_indices = sorted(int(line.split()[0]) for line in label)
        assert line_indices == [0, 1, 2], (
            f"label indices not densified: {line_indices}"
        )
        # No line should reference index >= 3 (the sparse maximum was 4).
        assert all(int(line.split()[0]) <= 2 for line in label)

        # data.yaml: nc=3 and names has exactly 3 entries.
        yaml_text = zf.read("data.yaml").decode()
        assert "nc: 3" in yaml_text
        # Crude but sufficient: every class name appears once.
        for cname in ("person", "car", "bicycle"):
            assert f'"{cname}"' in yaml_text

        # classes.json: every entry has export_idx field; included classes
        # have integer values 0..2.
        manifest = json.loads(zf.read("classes.json"))
        assert len(manifest) == 3
        for entry in manifest:
            assert "idx" in entry
            assert "export_idx" in entry
        export_idxs = sorted(entry["export_idx"] for entry in manifest)
        assert export_idxs == [0, 1, 2]


def test_yolo_export_densifies_when_some_classes_skipped(db_session) -> None:
    """Skipping a class must shrink the dense range to N-1."""
    # Arrange
    u, t, _a, classes, e = _seed_sparse_classes(db_session)
    storage = _FakeStorage()

    # User skips the middle class ("car", idx=2). Two classes remain.
    car = next(c for c in classes if c.name == "car")
    payload_remap: dict = {}
    for c in classes:
        if c.id == car.id:
            payload_remap[str(c.id)] = None  # skipped
        else:
            payload_remap[str(c.id)] = {"export_id": int(c.idx), "name": c.name}

    payload = ExportJobPayload(
        export_id=str(e.id),
        actor_id=str(u.id),
        task_id=str(t.id),
        fmt="yolo",
        class_remap=payload_remap,
        include_images=False,
        splits={"train": 1.0, "val": 0.0, "test": 0.0},
    )

    # Act
    result = run_export_inline(session=db_session, storage=storage, payload=payload)

    # Assert
    assert result["status"] == "completed"
    _, body = storage.uploaded[0]
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        yaml_text = zf.read("data.yaml").decode()
        assert "nc: 2" in yaml_text
        manifest = json.loads(zf.read("classes.json"))
        included = [m for m in manifest if m["export_idx"] is not None]
        excluded = [m for m in manifest if m["export_idx"] is None]
        assert len(included) == 2
        assert sorted(m["export_idx"] for m in included) == [0, 1]
        assert len(excluded) == 1
        assert excluded[0]["name"] == "car"


def test_coco_export_densifies_category_ids(db_session) -> None:
    # Arrange
    u, t, _a, classes, e = _seed_sparse_classes(db_session)
    storage = _FakeStorage()
    e.format = "coco"
    db_session.flush()
    payload = ExportJobPayload(
        export_id=str(e.id),
        actor_id=str(u.id),
        task_id=str(t.id),
        fmt="coco",
        class_remap={
            str(c.id): {"export_id": int(c.idx), "name": c.name}
            for c in classes
        },
        include_images=False,
        splits={"train": 1.0, "val": 0.0, "test": 0.0},
    )

    # Act
    result = run_export_inline(session=db_session, storage=storage, payload=payload)

    # Assert — COCO categories must be 0..N-1, matching annotation
    # category_ids — same correctness rule, different file format.
    assert result["status"] == "completed"
    _, body = storage.uploaded[0]
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        coco = json.loads(zf.read("coco.json"))
    cat_ids = sorted(c["id"] for c in coco["categories"])
    assert cat_ids == [0, 1, 2]
    ann_cat_ids = sorted({a["category_id"] for a in coco["annotations"]})
    assert ann_cat_ids == [0, 1, 2]
