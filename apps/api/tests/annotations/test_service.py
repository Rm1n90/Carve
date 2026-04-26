import uuid

import pytest

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.annotations.service import (
    AnnotationInvalid,
    AnnotationNotFound,
    AnnotationService,
)
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.models import User, UserRole
from carve_api.projects.models import Class, Project, Task, TaskKind


def _setup(db):
    u = User(email=f"u-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.admin)
    db.add(u); db.flush()
    p = Project(name="P", owner_id=u.id); db.add(p); db.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image); db.add(t); db.flush()
    a = Asset(task_id=t.id, kind=AssetKind.image, xxh3_128=str(uuid.uuid4().hex)[:16],
              mime="image/png", size_bytes=1, width=100, height=100, frames=1, original_name="a.png")
    db.add(a); db.flush()
    f = Frame(asset_id=a.id, idx=0, pts_ms=0); db.add(f); db.flush()
    c = Class(project_id=p.id, idx=0, name="car", color="#ff0000"); db.add(c); db.flush()
    c2 = Class(project_id=p.id, idx=1, name="truck", color="#00ff00"); db.add(c2); db.flush()
    return t, f, c, c2, u


def test_create_bbox(db_session) -> None:
    t, f, c, _, u = _setup(db_session)
    svc = AnnotationService(db_session)
    a = svc.create(
        task=t, actor_id=u.id, frame_id=f.id, class_id=c.id,
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0},
        track_id=None,
    )
    assert a.id is not None


def test_create_polygon(db_session) -> None:
    t, f, c, _, u = _setup(db_session)
    svc = AnnotationService(db_session)
    a = svc.create(
        task=t, actor_id=u.id, frame_id=f.id, class_id=c.id,
        kind=AnnotationKind.polygon,
        geometry={"kind": "polygon", "points": [[0, 0], [10, 0], [10, 10]]},
        track_id=None,
    )
    assert a.id is not None


def test_create_mask(db_session) -> None:
    t, f, c, _, u = _setup(db_session)
    svc = AnnotationService(db_session)
    a = svc.create(
        task=t, actor_id=u.id, frame_id=f.id, class_id=c.id,
        kind=AnnotationKind.mask,
        geometry={"kind": "mask_rle", "size": [100, 100], "counts": "abc"},
        track_id=None,
    )
    assert a.id is not None


def test_create_tag(db_session) -> None:
    t, f, c, _, u = _setup(db_session)
    svc = AnnotationService(db_session)
    a = svc.create(
        task=t, actor_id=u.id, frame_id=f.id, class_id=c.id,
        kind=AnnotationKind.tag, geometry={}, track_id=None,
    )
    assert a.id is not None


def test_bbox_zero_width_rejected(db_session) -> None:
    t, f, c, _, u = _setup(db_session)
    svc = AnnotationService(db_session)
    with pytest.raises(AnnotationInvalid):
        svc.create(
            task=t, actor_id=u.id, frame_id=f.id, class_id=c.id,
            kind=AnnotationKind.bbox,
            geometry={"kind": "bbox", "x": 0, "y": 0, "w": 0, "h": 5},
            track_id=None,
        )


def test_polygon_too_few_points_rejected(db_session) -> None:
    t, f, c, _, u = _setup(db_session)
    svc = AnnotationService(db_session)
    with pytest.raises(AnnotationInvalid):
        svc.create(
            task=t, actor_id=u.id, frame_id=f.id, class_id=c.id,
            kind=AnnotationKind.polygon,
            geometry={"kind": "polygon", "points": [[0, 0], [1, 1]]},
            track_id=None,
        )


def test_cross_project_class_rejected(db_session) -> None:
    t, f, _, _, u = _setup(db_session)
    other = Project(name="Other", owner_id=u.id); db_session.add(other); db_session.flush()
    other_c = Class(project_id=other.id, idx=0, name="x", color="#000000"); db_session.add(other_c); db_session.flush()
    svc = AnnotationService(db_session)
    with pytest.raises(AnnotationInvalid):
        svc.create(
            task=t, actor_id=u.id, frame_id=f.id, class_id=other_c.id,
            kind=AnnotationKind.bbox,
            geometry={"kind": "bbox", "x": 0, "y": 0, "w": 5, "h": 5},
            track_id=None,
        )


def test_list_filters_by_frame(db_session) -> None:
    t, f, c, _, u = _setup(db_session)
    a2 = Asset(task_id=t.id, kind=AssetKind.image, xxh3_128=str(uuid.uuid4().hex)[:16],
               mime="image/png", size_bytes=1, width=10, height=10, frames=1, original_name="b.png")
    db_session.add(a2); db_session.flush()
    f2 = Frame(asset_id=a2.id, idx=0, pts_ms=0); db_session.add(f2); db_session.flush()

    svc = AnnotationService(db_session)
    svc.create(task=t, actor_id=u.id, frame_id=f.id, class_id=c.id,
               kind=AnnotationKind.bbox,
               geometry={"kind": "bbox", "x": 0, "y": 0, "w": 5, "h": 5}, track_id=None)
    svc.create(task=t, actor_id=u.id, frame_id=f2.id, class_id=c.id,
               kind=AnnotationKind.bbox,
               geometry={"kind": "bbox", "x": 0, "y": 0, "w": 6, "h": 6}, track_id=None)
    rows_f = svc.list_for_task(task=t, frame_id=f.id)
    assert len(rows_f) == 1
    assert rows_f[0].geometry["w"] == 5


def test_update_geometry_revalidates(db_session) -> None:
    t, f, c, _, u = _setup(db_session)
    svc = AnnotationService(db_session)
    a = svc.create(task=t, actor_id=u.id, frame_id=f.id, class_id=c.id,
                   kind=AnnotationKind.bbox,
                   geometry={"kind": "bbox", "x": 0, "y": 0, "w": 5, "h": 5}, track_id=None)
    with pytest.raises(AnnotationInvalid):
        svc.update(task=t, annotation_id=a.id,
                   geometry={"kind": "bbox", "x": 0, "y": 0, "w": 0, "h": 5})


def test_delete_annotation(db_session) -> None:
    t, f, c, _, u = _setup(db_session)
    svc = AnnotationService(db_session)
    a = svc.create(task=t, actor_id=u.id, frame_id=f.id, class_id=c.id,
                   kind=AnnotationKind.bbox,
                   geometry={"kind": "bbox", "x": 0, "y": 0, "w": 5, "h": 5}, track_id=None)
    svc.delete(task=t, annotation_id=a.id)
    assert db_session.get(Annotation, a.id) is None
