from vaa_api.assets.models import Asset, AssetKind, Frame
from vaa_api.auth.models import User, UserRole
from vaa_api.projects.models import Project, Task, TaskKind


def _setup(db):
    u = User(email="a@x.com", password_hash="x", role=UserRole.admin)
    db.add(u); db.flush()
    p = Project(name="P", owner_id=u.id); db.add(p); db.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image); db.add(t); db.flush()
    return t


def test_create_image_asset(db_session) -> None:
    t = _setup(db_session)
    a = Asset(
        task_id=t.id, kind=AssetKind.image, xxh3_128="aabb",
        mime="image/png", size_bytes=1234, width=640, height=480,
        frames=1, original_name="x.png",
    )
    db_session.add(a); db_session.flush()
    assert a.id is not None


def test_create_video_asset_with_frames(db_session) -> None:
    t = _setup(db_session)
    a = Asset(
        task_id=t.id, kind=AssetKind.video, xxh3_128="ccdd",
        mime="video/mp4", size_bytes=99999, width=1280, height=720,
        frames=120, original_name="v.mp4",
    )
    db_session.add(a); db_session.flush()
    f = Frame(asset_id=a.id, idx=0, pts_ms=0)
    db_session.add(f); db_session.flush()
    assert f.id is not None
