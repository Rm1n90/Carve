"""Tests for size distribution + aspect ratio histogram analytics.

Reuses helpers from `test_stats.py` for project/task/class seeding.
"""
import uuid

from fastapi.testclient import TestClient

from vaa_api.deps import get_db
from vaa_api.main import create_app


# --- Helpers (mirror test_stats.py to keep this file standalone) -----------


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
    token = _register_login(client, email)
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    return token, pid, tid


def _make_class(client, token: str, pid: str, idx: int = 0, name: str = "obj") -> str:
    return client.post(
        f"/projects/{pid}/classes",
        json={"idx": idx, "name": name, "color": "#ff0000"},
        headers=_hdr(token),
    ).json()["id"]


def _seed_frame(db_session, task_id: str) -> uuid.UUID:
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


def _seed_geom(
    db_session,
    task_id: str,
    frame_id: uuid.UUID,
    class_id: str,
    *,
    kind: str,
    geometry: dict,
) -> None:
    from vaa_api.annotations.models import Annotation, AnnotationKind

    a = Annotation(
        task_id=uuid.UUID(task_id),
        frame_id=frame_id,
        class_id=uuid.UUID(class_id),
        kind=AnnotationKind(kind),
        geometry=geometry,
    )
    db_session.add(a)
    db_session.flush()


# --- Size distribution tests -----------------------------------------------


def test_size_distribution_bbox_only(db_session) -> None:
    """Six bboxes spanning all three COCO size buckets."""
    client = _client(db_session)
    token, pid, tid = _setup_project_and_task(client, email="size_bbox@x.com")
    cid = _make_class(client, token, pid)
    fid = _seed_frame(db_session, tid)

    # small: 100, 900   medium: 2500, 6400   large: 10000, 40000
    sizes = [
        (10, 10),  # 100 -> small
        (30, 30),  # 900 -> small
        (50, 50),  # 2500 -> medium
        (80, 80),  # 6400 -> medium
        (100, 100),  # 10000 -> large
        (200, 200),  # 40000 -> large
    ]
    for w, h in sizes:
        _seed_geom(
            db_session,
            tid,
            fid,
            cid,
            kind="bbox",
            geometry={"x": 0, "y": 0, "w": w, "h": h},
        )

    r = client.get(f"/tasks/{tid}/stats/size-distribution", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {"small": 2, "medium": 2, "large": 2}


def test_size_distribution_polygons(db_session) -> None:
    """Polygons computed via shoelace area in Python."""
    client = _client(db_session)
    token, pid, tid = _setup_project_and_task(client, email="size_poly@x.com")
    cid = _make_class(client, token, pid)
    fid = _seed_frame(db_session, tid)

    # Triangle area = 0.5 * base * height = 0.5 * 10 * 10 = 50 -> small
    small_poly = {"points": [[0, 0], [10, 0], [0, 10]]}
    # Square 200x200 polygon -> 40000 -> large
    large_poly = {
        "points": [[0, 0], [200, 0], [200, 200], [0, 200]]
    }

    _seed_geom(db_session, tid, fid, cid, kind="polygon", geometry=small_poly)
    _seed_geom(db_session, tid, fid, cid, kind="polygon", geometry=large_poly)

    r = client.get(f"/tasks/{tid}/stats/size-distribution", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {"small": 1, "medium": 0, "large": 1}


def test_size_distribution_masks(db_session) -> None:
    """Masks: foreground pixel count from RLE counts string."""
    client = _client(db_session)
    token, pid, tid = _setup_project_and_task(client, email="size_mask@x.com")
    cid = _make_class(client, token, pid)
    fid = _seed_frame(db_session, tid)

    # Per Plan 04 codec: comma-separated runs, alternating starting with bg (0).
    # So odd-indexed runs are foreground.
    # counts = "10,5000,10": 10 bg, 5000 fg, 10 bg -> 5000 fg pixels -> medium
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="mask",
        geometry={"counts": "10,5000,10", "size": [80, 80]},
    )

    r = client.get(f"/tasks/{tid}/stats/size-distribution", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {"small": 0, "medium": 1, "large": 0}


def test_size_distribution_excludes_tags(db_session) -> None:
    """Tags have no spatial dims and must not affect any bucket."""
    client = _client(db_session)
    token, pid, tid = _setup_project_and_task(client, email="size_tag@x.com")
    cid = _make_class(client, token, pid)
    fid = _seed_frame(db_session, tid)

    _seed_geom(db_session, tid, fid, cid, kind="tag", geometry={})

    r = client.get(f"/tasks/{tid}/stats/size-distribution", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {"small": 0, "medium": 0, "large": 0}


def test_size_distribution_combines_kinds(db_session) -> None:
    """One bbox-small + one polygon-medium + one mask-large summed across kinds."""
    client = _client(db_session)
    token, pid, tid = _setup_project_and_task(client, email="size_combo@x.com")
    cid = _make_class(client, token, pid)
    fid = _seed_frame(db_session, tid)

    # bbox: 20x20 = 400 -> small
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="bbox",
        geometry={"x": 0, "y": 0, "w": 20, "h": 20},
    )
    # polygon: 70x70 square = 4900 -> medium
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="polygon",
        geometry={"points": [[0, 0], [70, 0], [70, 70], [0, 70]]},
    )
    # mask: 0 bg, 12000 fg -> large
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="mask",
        geometry={"counts": "0,12000", "size": [120, 100]},
    )

    r = client.get(f"/tasks/{tid}/stats/size-distribution", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {"small": 1, "medium": 1, "large": 1}


def test_size_distribution_empty_task(db_session) -> None:
    client = _client(db_session)
    token, _pid, tid = _setup_project_and_task(client, email="size_empty@x.com")

    r = client.get(f"/tasks/{tid}/stats/size-distribution", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {"small": 0, "medium": 0, "large": 0}


# --- Aspect-ratio histogram tests ------------------------------------------


def test_aspect_ratio_histogram_bbox_only(db_session) -> None:
    """One bbox per bucket — five buckets, all equal to 1."""
    client = _client(db_session)
    token, pid, tid = _setup_project_and_task(client, email="ar_bbox@x.com")
    cid = _make_class(client, token, pid)
    fid = _seed_frame(db_session, tid)

    # w/h ratios: 0.2, 0.5, 1.0, 2.0, 5.0
    ratios = [
        (10, 50),  # 0.2 -> <0.33
        (10, 20),  # 0.5 -> 0.33-0.67
        (10, 10),  # 1.0 -> 0.67-1.5
        (20, 10),  # 2.0 -> 1.5-3
        (50, 10),  # 5.0 -> >=3
    ]
    for w, h in ratios:
        _seed_geom(
            db_session,
            tid,
            fid,
            cid,
            kind="bbox",
            geometry={"x": 0, "y": 0, "w": w, "h": h},
        )

    r = client.get(f"/tasks/{tid}/stats/aspect-ratio", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {
        "<0.33": 1,
        "0.33-0.67": 1,
        "0.67-1.5": 1,
        "1.5-3": 1,
        ">=3": 1,
    }


def test_aspect_ratio_histogram_zero_height_skipped(db_session) -> None:
    """h=0 must not crash the endpoint and must not be counted."""
    client = _client(db_session)
    token, pid, tid = _setup_project_and_task(client, email="ar_zero@x.com")
    cid = _make_class(client, token, pid)
    fid = _seed_frame(db_session, tid)

    # One zero-height bbox plus one normal square
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="bbox",
        geometry={"x": 0, "y": 0, "w": 10, "h": 0},
    )
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="bbox",
        geometry={"x": 0, "y": 0, "w": 10, "h": 10},
    )

    r = client.get(f"/tasks/{tid}/stats/aspect-ratio", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    # Only the square (0.67-1.5) counted; degenerate bbox skipped silently.
    assert body == {
        "<0.33": 0,
        "0.33-0.67": 0,
        "0.67-1.5": 1,
        "1.5-3": 0,
        ">=3": 0,
    }


def test_aspect_ratio_empty_task(db_session) -> None:
    client = _client(db_session)
    token, _pid, tid = _setup_project_and_task(client, email="ar_empty@x.com")

    r = client.get(f"/tasks/{tid}/stats/aspect-ratio", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {
        "<0.33": 0,
        "0.33-0.67": 0,
        "0.67-1.5": 0,
        "1.5-3": 0,
        ">=3": 0,
    }
