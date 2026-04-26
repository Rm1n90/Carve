"""Tests for time-on-task per annotator endpoint."""
import uuid
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from vaa_api.deps import get_db
from vaa_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def _register_login(client, email: str) -> str:
    client.post("/auth/register", json={"email": email, "password": "hunter22"})
    return client.post(
        "/auth/login", json={"email": email, "password": "hunter22"}
    ).json()["access_token"]


def _setup_project_and_task(client, email: str) -> tuple[str, str, str]:
    """Returns (token, project_id, task_id)."""
    token = _register_login(client, email)
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    return token, pid, tid


def _make_class(client, token: str, pid: str) -> str:
    return client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "car", "color": "#ff0000"},
        headers=_hdr(token),
    ).json()["id"]


def _seed_frame(db_session, task_id: str) -> uuid.UUID:
    """Seed one Asset with a single frame; return the frame ID."""
    from vaa_api.assets.models import Asset, AssetKind, Frame

    asset = Asset(
        task_id=uuid.UUID(task_id),
        kind=AssetKind.image,
        xxh3_128=uuid.uuid4().hex,
        mime="image/png",
        size_bytes=10,
        frames=1,
        original_name=f"a{uuid.uuid4()}.png",
    )
    db_session.add(asset)
    db_session.flush()
    f = Frame(asset_id=asset.id, idx=0, pts_ms=0)
    db_session.add(f)
    db_session.flush()
    return f.id


def _user_id_for(db_session, email: str) -> uuid.UUID:
    from vaa_api.auth.models import User

    return db_session.query(User).filter_by(email=email).one().id


def _seed_annotation_at(
    db_session,
    *,
    task_id: str,
    frame_id: uuid.UUID,
    class_id: str,
    created_by: uuid.UUID | None,
    created_at: datetime,
) -> None:
    from vaa_api.annotations.models import Annotation, AnnotationKind

    a = Annotation(
        task_id=uuid.UUID(task_id),
        frame_id=frame_id,
        class_id=uuid.UUID(class_id),
        kind=AnnotationKind.bbox,
        geometry={"x": 0, "y": 0, "w": 10, "h": 10},
        created_by=created_by,
        created_at=created_at,
    )
    db_session.add(a)
    db_session.flush()


def test_time_on_task_simple_session(db_session) -> None:
    """One user, three annotations 30s and 60s apart -> 90s total."""
    client = _client(db_session)
    email = "tot-simple@x.com"
    token, pid, tid = _setup_project_and_task(client, email=email)
    cid = _make_class(client, token, pid)
    frame = _seed_frame(db_session, tid)
    uid = _user_id_for(db_session, email)

    base = datetime.now(timezone.utc)
    for offset in (0, 30, 90):
        _seed_annotation_at(
            db_session,
            task_id=tid,
            frame_id=frame,
            class_id=cid,
            created_by=uid,
            created_at=base + timedelta(seconds=offset),
        )

    r = client.get(f"/tasks/{tid}/stats/time-on-task", headers=_hdr(token))
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["seconds"] == 90.0
    assert rows[0]["user_id"] == str(uid)


def test_time_on_task_excludes_long_gaps(db_session) -> None:
    """7-minute gap between annotations is excluded; only the first 30s counts."""
    client = _client(db_session)
    email = "tot-gaps@x.com"
    token, pid, tid = _setup_project_and_task(client, email=email)
    cid = _make_class(client, token, pid)
    frame = _seed_frame(db_session, tid)
    uid = _user_id_for(db_session, email)

    base = datetime.now(timezone.utc)
    # t=0, t=30s (gap=30s, counted), t=420s (gap=390s > 300s, excluded)
    for offset in (0, 30, 420):
        _seed_annotation_at(
            db_session,
            task_id=tid,
            frame_id=frame,
            class_id=cid,
            created_by=uid,
            created_at=base + timedelta(seconds=offset),
        )

    r = client.get(f"/tasks/{tid}/stats/time-on-task", headers=_hdr(token))
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["seconds"] == 30.0


def test_time_on_task_per_user(db_session) -> None:
    """Two users get separate aggregates."""
    client = _client(db_session)
    email_a = "tot-a@x.com"
    email_b = "tot-b@x.com"
    token, pid, tid = _setup_project_and_task(client, email=email_a)
    # Register the second user via auth so they're in the users table.
    _register_login(client, email_b)
    cid = _make_class(client, token, pid)
    frame = _seed_frame(db_session, tid)
    uid_a = _user_id_for(db_session, email_a)
    uid_b = _user_id_for(db_session, email_b)

    base = datetime.now(timezone.utc)
    # User A: 0, 30s, 90s -> 30 + 60 = 90
    for offset in (0, 30, 90):
        _seed_annotation_at(
            db_session,
            task_id=tid,
            frame_id=frame,
            class_id=cid,
            created_by=uid_a,
            created_at=base + timedelta(seconds=offset),
        )
    # User B: 0, 120s -> 120
    for offset in (0, 120):
        _seed_annotation_at(
            db_session,
            task_id=tid,
            frame_id=frame,
            class_id=cid,
            created_by=uid_b,
            created_at=base + timedelta(seconds=offset),
        )

    r = client.get(f"/tasks/{tid}/stats/time-on-task", headers=_hdr(token))
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 2
    by_user = {row["user_id"]: row["seconds"] for row in rows}
    assert by_user[str(uid_a)] == 90.0
    assert by_user[str(uid_b)] == 120.0


def test_time_on_task_excludes_anonymous(db_session) -> None:
    """Annotations with created_by IS NULL are filtered out."""
    client = _client(db_session)
    email = "tot-anon@x.com"
    token, pid, tid = _setup_project_and_task(client, email=email)
    cid = _make_class(client, token, pid)
    frame = _seed_frame(db_session, tid)

    base = datetime.now(timezone.utc)
    for offset in (0, 30):
        _seed_annotation_at(
            db_session,
            task_id=tid,
            frame_id=frame,
            class_id=cid,
            created_by=None,
            created_at=base + timedelta(seconds=offset),
        )

    r = client.get(f"/tasks/{tid}/stats/time-on-task", headers=_hdr(token))
    assert r.status_code == 200, r.text
    assert r.json() == []


def test_time_on_task_email_present(db_session) -> None:
    """Each row carries the seeded user's email."""
    client = _client(db_session)
    email = "tot-email@x.com"
    token, pid, tid = _setup_project_and_task(client, email=email)
    cid = _make_class(client, token, pid)
    frame = _seed_frame(db_session, tid)
    uid = _user_id_for(db_session, email)

    base = datetime.now(timezone.utc)
    for offset in (0, 60):
        _seed_annotation_at(
            db_session,
            task_id=tid,
            frame_id=frame,
            class_id=cid,
            created_by=uid,
            created_at=base + timedelta(seconds=offset),
        )

    r = client.get(f"/tasks/{tid}/stats/time-on-task", headers=_hdr(token))
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["email"] == email


def test_time_on_task_empty_task(db_session) -> None:
    """A task with zero annotations returns an empty list."""
    client = _client(db_session)
    token, _pid, tid = _setup_project_and_task(client, email="tot-empty@x.com")

    r = client.get(f"/tasks/{tid}/stats/time-on-task", headers=_hdr(token))
    assert r.status_code == 200, r.text
    assert r.json() == []


def test_time_on_task_single_annotation_zero_seconds(db_session) -> None:
    """A single annotation has no LAG predecessor -> SUM is NULL -> service normalizes to 0.0."""
    client = _client(db_session)
    email = "tot-single@x.com"
    token, pid, tid = _setup_project_and_task(client, email=email)
    cid = _make_class(client, token, pid)
    frame = _seed_frame(db_session, tid)
    uid = _user_id_for(db_session, email)

    _seed_annotation_at(
        db_session,
        task_id=tid,
        frame_id=frame,
        class_id=cid,
        created_by=uid,
        created_at=datetime.now(timezone.utc),
    )

    r = client.get(f"/tasks/{tid}/stats/time-on-task", headers=_hdr(token))
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["seconds"] == 0.0
    assert rows[0]["user_id"] == str(uid)
