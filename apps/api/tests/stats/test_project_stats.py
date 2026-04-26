"""Tests for project-level analytics summary endpoint."""
import uuid

from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.main import create_app


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


def _make_project(client, token: str) -> str:
    return client.post(
        "/projects", json={"name": "P"}, headers=_hdr(token)
    ).json()["id"]


def _make_task(client, token: str, pid: str, name: str = "T") -> str:
    return client.post(
        f"/projects/{pid}/tasks",
        json={"name": name, "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]


def _make_class(client, token: str, pid: str, idx: int, name: str) -> str:
    return client.post(
        f"/projects/{pid}/classes",
        json={"idx": idx, "name": name, "color": "#ff0000"},
        headers=_hdr(token),
    ).json()["id"]


def _seed_asset_with_frames(db_session, task_id: str, frame_count: int) -> list[uuid.UUID]:
    """Seed one Asset with `frame_count` frames; return list of frame IDs."""
    from carve_api.assets.models import Asset, AssetKind, Frame

    asset = Asset(
        task_id=uuid.UUID(task_id),
        kind=AssetKind.image if frame_count == 1 else AssetKind.video,
        xxh3_128=uuid.uuid4().hex,
        mime="image/png",
        size_bytes=10,
        frames=frame_count,
        original_name=f"a{uuid.uuid4()}.png",
    )
    db_session.add(asset)
    db_session.flush()
    frame_ids: list[uuid.UUID] = []
    for i in range(frame_count):
        f = Frame(asset_id=asset.id, idx=i, pts_ms=i * 33)
        db_session.add(f)
        db_session.flush()
        frame_ids.append(f.id)
    return frame_ids


def _seed_annotation(
    db_session, task_id: str, frame_id: uuid.UUID | None, class_id: str
) -> None:
    from carve_api.annotations.models import Annotation, AnnotationKind

    a = Annotation(
        task_id=uuid.UUID(task_id),
        frame_id=frame_id,
        class_id=uuid.UUID(class_id),
        kind=AnnotationKind.bbox,
        geometry={"x": 0, "y": 0, "w": 10, "h": 10},
    )
    db_session.add(a)
    db_session.flush()


def test_project_stats_totals(db_session) -> None:
    """totals counts: 2 tasks, 3 assets across them, 5 annotations across them."""
    client = _client(db_session)
    token = _register_login(client, "ptot@x.com")
    pid = _make_project(client, token)
    t1 = _make_task(client, token, pid, "T1")
    t2 = _make_task(client, token, pid, "T2")
    car = _make_class(client, token, pid, idx=0, name="car")

    # T1: 2 assets (one with 2 frames, one with 1 frame); T2: 1 asset (1 frame)
    t1_frames_a = _seed_asset_with_frames(db_session, t1, frame_count=2)
    t1_frames_b = _seed_asset_with_frames(db_session, t1, frame_count=1)
    t2_frames = _seed_asset_with_frames(db_session, t2, frame_count=1)

    # 5 annotations total: 3 in T1 (2 on first asset's frames, 1 on second asset frame),
    # 2 in T2 on the same frame.
    _seed_annotation(db_session, t1, t1_frames_a[0], car)
    _seed_annotation(db_session, t1, t1_frames_a[1], car)
    _seed_annotation(db_session, t1, t1_frames_b[0], car)
    _seed_annotation(db_session, t2, t2_frames[0], car)
    _seed_annotation(db_session, t2, t2_frames[0], car)

    r = client.get(f"/projects/{pid}/stats", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["totals"] == {"tasks": 2, "assets": 3, "annotations": 5}


def test_project_stats_by_class_top_5(db_session) -> None:
    """6 classes with descending counts; only top 5 returned, zero excluded."""
    client = _client(db_session)
    token = _register_login(client, "pclass5@x.com")
    pid = _make_project(client, token)
    tid = _make_task(client, token, pid)

    # Seed 6 classes; counts will be 10/8/5/2/1/0 respectively
    counts = [10, 8, 5, 2, 1, 0]
    names = ["c0", "c1", "c2", "c3", "c4", "c5"]
    cids = [_make_class(client, token, pid, idx=i, name=names[i]) for i in range(6)]

    # Need a frame to attach annotations
    frames = _seed_asset_with_frames(db_session, tid, frame_count=1)
    fid = frames[0]
    for cid, n in zip(cids, counts):
        for _ in range(n):
            _seed_annotation(db_session, tid, fid, cid)

    r = client.get(f"/projects/{pid}/stats", headers=_hdr(token))
    assert r.status_code == 200, r.text
    rows = r.json()["by_class"]
    assert len(rows) == 5
    # Descending by count
    assert [row["count"] for row in rows] == [10, 8, 5, 2, 1]
    # Names present in expected order
    assert [row["name"] for row in rows] == ["c0", "c1", "c2", "c3", "c4"]
    # The zero-count class did not make it into the top 5
    assert all(row["name"] != "c5" for row in rows)


def test_project_stats_by_class_keeps_zero_when_top_5(db_session) -> None:
    """3 classes with counts 5/2/0; all 3 returned (top 5 means 'up to 5')."""
    client = _client(db_session)
    token = _register_login(client, "pclasszero@x.com")
    pid = _make_project(client, token)
    tid = _make_task(client, token, pid)

    cid_a = _make_class(client, token, pid, idx=0, name="a")
    cid_b = _make_class(client, token, pid, idx=1, name="b")
    _make_class(client, token, pid, idx=2, name="c")  # 0 annotations

    frames = _seed_asset_with_frames(db_session, tid, frame_count=1)
    fid = frames[0]
    for _ in range(5):
        _seed_annotation(db_session, tid, fid, cid_a)
    for _ in range(2):
        _seed_annotation(db_session, tid, fid, cid_b)

    r = client.get(f"/projects/{pid}/stats", headers=_hdr(token))
    assert r.status_code == 200, r.text
    rows = r.json()["by_class"]
    assert len(rows) == 3
    assert [row["name"] for row in rows] == ["a", "b", "c"]
    assert [row["count"] for row in rows] == [5, 2, 0]


def test_project_stats_tasks_progress_pct(db_session) -> None:
    """One task: 4 frames, 2 labeled -> 0.5; another task: 0 frames -> 0.0."""
    client = _client(db_session)
    token = _register_login(client, "pprog@x.com")
    pid = _make_project(client, token)
    t1 = _make_task(client, token, pid, "Half")
    t2 = _make_task(client, token, pid, "Empty")
    car = _make_class(client, token, pid, idx=0, name="car")

    # T1: one video asset with 4 frames; annotate frames 0 and 1.
    frames = _seed_asset_with_frames(db_session, t1, frame_count=4)
    _seed_annotation(db_session, t1, frames[0], car)
    _seed_annotation(db_session, t1, frames[1], car)
    # T2: no assets/frames at all.

    r = client.get(f"/projects/{pid}/stats", headers=_hdr(token))
    assert r.status_code == 200, r.text
    tasks = r.json()["tasks"]
    by_name = {t["name"]: t for t in tasks}
    assert by_name["Half"]["progress_pct"] == 0.5
    assert by_name["Empty"]["progress_pct"] == 0.0


def test_project_stats_unknown_project_returns_404(db_session) -> None:
    client = _client(db_session)
    token = _register_login(client, "pmissing@x.com")
    bogus = uuid.uuid4()
    r = client.get(f"/projects/{bogus}/stats", headers=_hdr(token))
    assert r.status_code == 404


def test_project_stats_empty_project(db_session) -> None:
    """Project with no tasks/assets/annotations: zeros, empty arrays."""
    client = _client(db_session)
    token = _register_login(client, "pempty@x.com")
    pid = _make_project(client, token)

    r = client.get(f"/projects/{pid}/stats", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["totals"] == {"tasks": 0, "assets": 0, "annotations": 0}
    assert body["by_class"] == []
    assert body["tasks"] == []
