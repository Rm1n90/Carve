"""Tests for spatial heatmap aggregation per task.

Reuses helpers from `test_stats.py` / `test_size_aspect.py` for project, task,
class, and frame seeding. The heatmap endpoint counts bbox centers into a
binned grid (row-major: ``grid[by * bins + bx]``).
"""
import uuid

from fastapi.testclient import TestClient

from vaa_api.deps import get_db
from vaa_api.main import create_app


# --- Helpers ---------------------------------------------------------------


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


def _seed_frame(
    db_session,
    task_id: str,
    *,
    width: int | None = 100,
    height: int | None = 100,
) -> uuid.UUID:
    """Create one Asset (with optional width/height) and one Frame on it."""
    from vaa_api.assets.models import Asset, AssetKind, Frame

    asset = Asset(
        task_id=uuid.UUID(task_id),
        kind=AssetKind.image,
        xxh3_128=uuid.uuid4().hex,
        mime="image/png",
        size_bytes=10,
        frames=1,
        original_name=f"a{uuid.uuid4()}.png",
        width=width,
        height=height,
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


# --- Tests -----------------------------------------------------------------


def test_heatmap_default_bins_is_32(db_session) -> None:
    """Empty task: response is {bins: 32, grid: [0]*1024}."""
    client = _client(db_session)
    token, _pid, tid = _setup_project_and_task(client, email="hm_empty@x.com")

    r = client.get(f"/tasks/{tid}/stats/heatmap", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["bins"] == 32
    assert body["grid"] == [0] * 1024


def test_heatmap_centers_in_correct_cells(db_session) -> None:
    """Four bboxes on a 100x100 image; verify exact cell placement."""
    client = _client(db_session)
    token, pid, tid = _setup_project_and_task(client, email="hm_cells@x.com")
    cid = _make_class(client, token, pid)
    fid = _seed_frame(db_session, tid, width=100, height=100)

    # bbox at (50,50) size 10x10 -> center (55, 55) -> cell (17, 17)
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="bbox",
        geometry={"x": 50, "y": 50, "w": 10, "h": 10},
    )
    # bbox at (0,0) size 10x10 -> center (5, 5) -> cell (1, 1)
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="bbox",
        geometry={"x": 0, "y": 0, "w": 10, "h": 10},
    )
    # bbox at (90,0) size 10x10 -> center (95, 5) -> cell (30, 1)
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="bbox",
        geometry={"x": 90, "y": 0, "w": 10, "h": 10},
    )
    # bbox at (90,90) size 10x10 -> center (95, 95) -> cell (30, 30)
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="bbox",
        geometry={"x": 90, "y": 90, "w": 10, "h": 10},
    )

    r = client.get(f"/tasks/{tid}/stats/heatmap", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    grid = body["grid"]
    assert len(grid) == 32 * 32
    assert sum(grid) == 4

    expected = {
        (17, 17): 1,
        (1, 1): 1,
        (30, 1): 1,
        (30, 30): 1,
    }
    for (bx, by), count in expected.items():
        assert grid[by * 32 + bx] == count, (
            f"cell ({bx},{by}) expected {count} got {grid[by * 32 + bx]}"
        )


def test_heatmap_clamps_oob_centers(db_session) -> None:
    """Bbox center exactly at (img_w, img_h) clamps to (bins-1, bins-1)."""
    client = _client(db_session)
    token, pid, tid = _setup_project_and_task(client, email="hm_clamp@x.com")
    cid = _make_class(client, token, pid)
    fid = _seed_frame(db_session, tid, width=100, height=100)

    # 100x100 bbox at (50, 50): center = (100, 100) -> clamp to (31, 31).
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="bbox",
        geometry={"x": 50, "y": 50, "w": 100, "h": 100},
    )

    r = client.get(f"/tasks/{tid}/stats/heatmap", headers=_hdr(token))
    assert r.status_code == 200, r.text
    grid = r.json()["grid"]
    assert grid[31 * 32 + 31] == 1
    assert sum(grid) == 1


def test_heatmap_custom_bins(db_session) -> None:
    """?bins=4 returns a 16-cell grid with correct counts."""
    client = _client(db_session)
    token, pid, tid = _setup_project_and_task(client, email="hm_bins@x.com")
    cid = _make_class(client, token, pid)
    fid = _seed_frame(db_session, tid, width=100, height=100)

    # On a 4x4 grid each cell spans 25px.
    # bbox at (0,0,10,10) -> center (5,5) -> cx_norm=0.05, cy_norm=0.05 -> (0,0)
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="bbox",
        geometry={"x": 0, "y": 0, "w": 10, "h": 10},
    )
    # bbox at (60,60,10,10) -> center (65,65) -> cx_norm=0.65, cy_norm=0.65 -> (2,2)
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="bbox",
        geometry={"x": 60, "y": 60, "w": 10, "h": 10},
    )
    # second bbox in same (2,2) cell to verify counts add
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="bbox",
        geometry={"x": 65, "y": 65, "w": 10, "h": 10},
    )

    r = client.get(f"/tasks/{tid}/stats/heatmap?bins=4", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["bins"] == 4
    grid = body["grid"]
    assert len(grid) == 16
    assert grid[0 * 4 + 0] == 1
    assert grid[2 * 4 + 2] == 2
    assert sum(grid) == 3


def test_heatmap_skips_assets_without_dimensions(db_session) -> None:
    """An asset with width=None has its annotations excluded from the grid."""
    client = _client(db_session)
    token, pid, tid = _setup_project_and_task(client, email="hm_nodims@x.com")
    cid = _make_class(client, token, pid)

    # Asset with dims contributes one bbox.
    fid_ok = _seed_frame(db_session, tid, width=100, height=100)
    _seed_geom(
        db_session,
        tid,
        fid_ok,
        cid,
        kind="bbox",
        geometry={"x": 0, "y": 0, "w": 10, "h": 10},
    )
    # Asset without dims must be ignored.
    fid_nd = _seed_frame(db_session, tid, width=None, height=None)
    _seed_geom(
        db_session,
        tid,
        fid_nd,
        cid,
        kind="bbox",
        geometry={"x": 50, "y": 50, "w": 10, "h": 10},
    )

    r = client.get(f"/tasks/{tid}/stats/heatmap", headers=_hdr(token))
    assert r.status_code == 200, r.text
    grid = r.json()["grid"]
    # Only the dimensioned-asset bbox at (5,5) -> cell (1,1) is counted.
    assert sum(grid) == 1
    assert grid[1 * 32 + 1] == 1


def test_heatmap_endpoint_rejects_invalid_bins(db_session) -> None:
    """bins must be in [1, 128]; out-of-range values return 422."""
    client = _client(db_session)
    token, _pid, tid = _setup_project_and_task(client, email="hm_invalid@x.com")

    for bad in (0, 200, -1):
        r = client.get(
            f"/tasks/{tid}/stats/heatmap?bins={bad}", headers=_hdr(token)
        )
        assert r.status_code == 422, f"bins={bad} got {r.status_code}: {r.text}"


def test_heatmap_only_counts_bbox_kind(db_session) -> None:
    """Polygons and masks must not appear in the bbox-only grid."""
    client = _client(db_session)
    token, pid, tid = _setup_project_and_task(client, email="hm_kinds@x.com")
    cid = _make_class(client, token, pid)
    fid = _seed_frame(db_session, tid, width=100, height=100)

    # One bbox: contributes.
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="bbox",
        geometry={"x": 0, "y": 0, "w": 10, "h": 10},
    )
    # Polygon: ignored.
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="polygon",
        geometry={"points": [[0, 0], [50, 0], [50, 50], [0, 50]]},
    )
    # Mask: ignored.
    _seed_geom(
        db_session,
        tid,
        fid,
        cid,
        kind="mask",
        geometry={"counts": "0,1000", "size": [50, 50]},
    )

    r = client.get(f"/tasks/{tid}/stats/heatmap", headers=_hdr(token))
    assert r.status_code == 200, r.text
    grid = r.json()["grid"]
    assert sum(grid) == 1
    assert grid[1 * 32 + 1] == 1
