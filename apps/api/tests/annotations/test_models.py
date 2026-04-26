from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.models import User, UserRole
from carve_api.projects.models import Class, Project, Task, TaskKind


def _setup(db):
    u = User(email="x@y.com", password_hash="x", role=UserRole.admin)
    db.add(u); db.flush()
    p = Project(name="P", owner_id=u.id); db.add(p); db.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image); db.add(t); db.flush()
    a = Asset(task_id=t.id, kind=AssetKind.image, xxh3_128="aa", mime="image/png",
              size_bytes=10, width=100, height=100, frames=1, original_name="a.png")
    db.add(a); db.flush()
    f = Frame(asset_id=a.id, idx=0, pts_ms=0); db.add(f); db.flush()
    c = Class(project_id=p.id, idx=0, name="car", color="#ff0000"); db.add(c); db.flush()
    return t, f, c, u


def test_create_bbox_annotation(db_session) -> None:
    t, f, c, u = _setup(db_session)
    ann = Annotation(
        task_id=t.id, frame_id=f.id, class_id=c.id,
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 10.0, "y": 12.0, "w": 30.0, "h": 40.0},
        created_by=u.id,
    )
    db_session.add(ann); db_session.flush()
    assert ann.id is not None
    assert ann.created_at is not None


def test_kinds_enum() -> None:
    assert {k.value for k in AnnotationKind} == {"bbox", "polygon", "mask", "tag"}
