from carve_api.auth.models import User, UserRole
from carve_api.exports.models import Export
from carve_api.projects.models import Project, Task, TaskKind


def test_create_export(db_session) -> None:
    u = User(email="ex@x.com", password_hash="x", role=UserRole.admin)
    db_session.add(u); db_session.flush()
    p = Project(name="P", owner_id=u.id); db_session.add(p); db_session.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image); db_session.add(t); db_session.flush()
    e = Export(
        task_id=t.id,
        format="yolo",
        class_remap={"car": {"export_id": 0, "name": "vehicle"}},
        created_by=u.id,
    )
    db_session.add(e); db_session.flush()
    assert e.id is not None
    assert e.status == "pending"
    assert e.created_at is not None
    assert e.completed_at is None


def test_export_format_choices_are_string_no_enum() -> None:
    """We use a String column rather than an enum so adding new formats
    in v2 (VOC, KITTI, MOT, Datumaro) is a code change only — no migration.
    """
    from carve_api.exports.models import Export
    assert Export.__table__.c.format.type.length == 20
