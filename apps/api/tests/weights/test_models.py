from carve_api.auth.models import User, UserRole
from carve_api.projects.models import Project
from carve_api.weights.models import Weight, WeightTaskKind


def test_create_weight(db_session) -> None:
    u = User(email="w@x.com", password_hash="x", role=UserRole.admin)
    db_session.add(u); db_session.flush()
    p = Project(name="P", owner_id=u.id); db_session.add(p); db_session.flush()
    w = Weight(
        project_id=p.id,
        name="yolo11n-detect",
        task_kind=WeightTaskKind.detect,
        minio_key="weights/abc/x.pt",
        size_bytes=12345,
        class_names=["car", "truck"],
        created_by=u.id,
    )
    db_session.add(w); db_session.flush()
    assert w.id is not None
    assert w.created_at is not None


def test_task_kind_enum() -> None:
    assert {k.value for k in WeightTaskKind} == {"detect", "segment", "classify", "pose"}
