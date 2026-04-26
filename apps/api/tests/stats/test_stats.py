"""Tests for per-task analytics endpoints."""
import uuid

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


def _setup_project_and_task(client, email: str = "stats@x.com") -> tuple[str, str, str]:
    """Returns (token, project_id, task_id)."""
    token = _register_login(client, email)
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    return token, pid, tid


def _make_class(client, token: str, pid: str, idx: int, name: str) -> str:
    return client.post(
        f"/projects/{pid}/classes",
        json={"idx": idx, "name": name, "color": "#ff0000"},
        headers=_hdr(token),
    ).json()["id"]


def _seed_asset_with_frames(db_session, task_id: str, frame_count: int) -> list[uuid.UUID]:
    """Seed one Asset with `frame_count` frames; return list of frame IDs."""
    from vaa_api.assets.models import Asset, AssetKind, Frame

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
    db_session, task_id: str, frame_id: uuid.UUID, class_id: str
) -> None:
    from vaa_api.annotations.models import Annotation, AnnotationKind

    a = Annotation(
        task_id=uuid.UUID(task_id),
        frame_id=frame_id,
        class_id=uuid.UUID(class_id),
        kind=AnnotationKind.bbox,
        geometry={"x": 0, "y": 0, "w": 10, "h": 10},
    )
    db_session.add(a)
    db_session.flush()


def test_class_frequency_returns_per_class_counts(db_session) -> None:
    client = _client(db_session)
    token, pid, tid = _setup_project_and_task(client, email="freq@x.com")
    car_id = _make_class(client, token, pid, idx=0, name="car")
    truck_id = _make_class(client, token, pid, idx=1, name="truck")

    frame_ids = _seed_asset_with_frames(db_session, tid, frame_count=3)
    # 3 cars across the 3 frames
    for f in frame_ids:
        _seed_annotation(db_session, tid, f, car_id)
    # 2 trucks on the first two frames
    for f in frame_ids[:2]:
        _seed_annotation(db_session, tid, f, truck_id)

    r = client.get(f"/tasks/{tid}/stats/class-frequency", headers=_hdr(token))
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 2
    # Ordered by class.idx
    assert rows[0]["class_name"] == "car"
    assert rows[0]["count"] == 3
    assert rows[1]["class_name"] == "truck"
    assert rows[1]["count"] == 2


def test_class_frequency_returns_zero_for_unused_class(db_session) -> None:
    client = _client(db_session)
    token, pid, tid = _setup_project_and_task(client, email="freqzero@x.com")
    car_id = _make_class(client, token, pid, idx=0, name="car")
    _make_class(client, token, pid, idx=1, name="truck")
    bus_id = _make_class(client, token, pid, idx=2, name="bus")

    frame_ids = _seed_asset_with_frames(db_session, tid, frame_count=1)
    _seed_annotation(db_session, tid, frame_ids[0], car_id)

    r = client.get(f"/tasks/{tid}/stats/class-frequency", headers=_hdr(token))
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 3
    by_name = {row["class_name"]: row for row in rows}
    assert by_name["car"]["count"] == 1
    assert by_name["truck"]["count"] == 0
    assert by_name["bus"]["count"] == 0
    assert by_name["bus"]["class_id"] == bus_id


def test_density_per_frame(db_session) -> None:
    client = _client(db_session)
    token, pid, tid = _setup_project_and_task(client, email="density@x.com")
    car_id = _make_class(client, token, pid, idx=0, name="car")

    frame_ids = _seed_asset_with_frames(db_session, tid, frame_count=3)
    frame_a, frame_b, _frame_c = frame_ids
    # 2 annotations on frame_a, 1 on frame_b, 0 on frame_c
    _seed_annotation(db_session, tid, frame_a, car_id)
    _seed_annotation(db_session, tid, frame_a, car_id)
    _seed_annotation(db_session, tid, frame_b, car_id)

    r = client.get(f"/tasks/{tid}/stats/density", headers=_hdr(token))
    assert r.status_code == 200, r.text
    rows = r.json()
    # GROUP BY only emits frames that actually have annotations -> 2 rows
    assert len(rows) == 2
    by_frame = {row["frame_id"]: row["count"] for row in rows}
    assert by_frame[str(frame_a)] == 2
    assert by_frame[str(frame_b)] == 1


def test_progress_when_some_frames_labeled(db_session) -> None:
    client = _client(db_session)
    token, pid, tid = _setup_project_and_task(client, email="progress@x.com")
    car_id = _make_class(client, token, pid, idx=0, name="car")

    # Seed 4 frames total (one video-style asset with 4 frames)
    frame_ids = _seed_asset_with_frames(db_session, tid, frame_count=4)
    # Annotate two of them
    _seed_annotation(db_session, tid, frame_ids[0], car_id)
    _seed_annotation(db_session, tid, frame_ids[1], car_id)

    r = client.get(f"/tasks/{tid}/stats/progress", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_frames"] == 4
    assert body["labeled_frames"] == 2
    assert body["progress_pct"] == 0.5


def test_progress_zero_total_frames_returns_zero_pct(db_session) -> None:
    client = _client(db_session)
    token, _pid, tid = _setup_project_and_task(client, email="zero@x.com")

    r = client.get(f"/tasks/{tid}/stats/progress", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_frames"] == 0
    assert body["labeled_frames"] == 0
    assert body["progress_pct"] == 0.0


def test_class_frequency_unknown_task_returns_404(db_session) -> None:
    """`_require_visible_task` rejects callers asking for a task that doesn't exist.

    (In v1 all authenticated users can read any project, per
    `ProjectService.list_visible`; the only path through `_require_visible_task`
    that 404s is a missing task. This guards against future regressions
    where a route might forget to invoke that helper at all.)
    """
    client = _client(db_session)
    token = _register_login(client, "auth@x.com")
    bogus_task_id = uuid.uuid4()
    r = client.get(
        f"/tasks/{bogus_task_id}/stats/class-frequency", headers=_hdr(token)
    )
    assert r.status_code == 404
