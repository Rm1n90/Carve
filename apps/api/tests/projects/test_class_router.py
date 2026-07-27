import uuid

from fastapi.testclient import TestClient

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.deps import get_db
from carve_api.main import create_app
from carve_api.projects.models import Task, TaskKind


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


def _setup(client) -> tuple[str, str]:
    client.post("/auth/register", json={"email": "cl@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "cl@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post("/projects", json={"name": "C"}, headers=_hdr(token)).json()["id"]
    return pid, token


def test_create_class(db_session) -> None:
    client = _client(db_session)
    pid, token = _setup(client)
    r = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "car", "color": "#ff0000"},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["idx"] == 0
    assert body["name"] == "car"


def test_list_classes_in_idx_order(db_session) -> None:
    client = _client(db_session)
    pid, token = _setup(client)
    client.post(
        f"/projects/{pid}/classes",
        json={"idx": 1, "name": "b", "color": "#000000"},
        headers=_hdr(token),
    )
    client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "a", "color": "#111111"},
        headers=_hdr(token),
    )
    r = client.get(f"/projects/{pid}/classes", headers=_hdr(token))
    rows = r.json()
    assert [c["idx"] for c in rows] == [0, 1]


def test_class_idx_uniqueness_returns_409(db_session) -> None:
    client = _client(db_session)
    pid, token = _setup(client)
    client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "a", "color": "#111111"},
        headers=_hdr(token),
    )
    r = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "z", "color": "#222222"},
        headers=_hdr(token),
    )
    assert r.status_code == 409


def test_color_validated(db_session) -> None:
    client = _client(db_session)
    pid, token = _setup(client)
    r = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "x", "color": "not-a-hex"},
        headers=_hdr(token),
    )
    assert r.status_code == 422


def test_patch_and_delete_class(db_session) -> None:
    client = _client(db_session)
    pid, token = _setup(client)
    r = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "old", "color": "#000000"},
        headers=_hdr(token),
    )
    cid = r.json()["id"]
    r = client.patch(
        f"/projects/{pid}/classes/{cid}",
        json={"name": "new", "color": "#abcdef"},
        headers=_hdr(token),
    )
    assert r.status_code == 200
    assert r.json()["name"] == "new"
    r = client.delete(f"/projects/{pid}/classes/{cid}", headers=_hdr(token))
    assert r.status_code == 204


def _seed_annotation(db, pid: str, cid: str) -> Annotation:
    """Attach one annotation to ``cid`` via a task/asset/frame, committed
    so it survives the per-request rollback in the get_db override."""
    t = Task(project_id=uuid.UUID(pid), name="T", kind=TaskKind.image)
    db.add(t)
    db.flush()
    a = Asset(
        task_id=t.id,
        kind=AssetKind.image,
        xxh3_128=uuid.uuid4().hex[:16],
        mime="image/png",
        size_bytes=1,
        width=10,
        height=10,
        frames=1,
        original_name="a.png",
    )
    db.add(a)
    db.flush()
    f = Frame(asset_id=a.id, idx=0, pts_ms=0)
    db.add(f)
    db.flush()
    ann = Annotation(
        task_id=t.id,
        frame_id=f.id,
        class_id=uuid.UUID(cid),
        kind=AnnotationKind.bbox,
        geometry={"x": 0, "y": 0, "w": 1, "h": 1},
    )
    db.add(ann)
    db.flush()
    db.commit()
    return ann


def test_delete_class_with_annotations_requires_force(db_session) -> None:
    # Post-incident guard: deleting a class that still has annotations is
    # refused with 409 + the count, and only proceeds with ?force=true.
    client = _client(db_session)
    pid, token = _setup(client)
    cid = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "logo", "color": "#123456"},
        headers=_hdr(token),
    ).json()["id"]
    ann = _seed_annotation(db_session, pid, cid)

    # Unforced delete is refused; the class + annotation survive.
    r = client.delete(f"/projects/{pid}/classes/{cid}", headers=_hdr(token))
    assert r.status_code == 409, r.text
    body = r.json()
    assert body["error"] == "class_has_annotations"
    assert body["annotation_count"] == 1
    db_session.expire_all()
    assert db_session.get(Annotation, ann.id) is not None

    # Forced delete removes the class and its annotations.
    r = client.delete(
        f"/projects/{pid}/classes/{cid}?force=true", headers=_hdr(token)
    )
    assert r.status_code == 204, r.text
    db_session.expire_all()
    assert db_session.get(Annotation, ann.id) is None


def test_delete_empty_class_needs_no_force(db_session) -> None:
    # An empty class deletes on the first call — the guard only trips when
    # data is actually at stake.
    client = _client(db_session)
    pid, token = _setup(client)
    cid = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "empty", "color": "#654321"},
        headers=_hdr(token),
    ).json()["id"]
    r = client.delete(f"/projects/{pid}/classes/{cid}", headers=_hdr(token))
    assert r.status_code == 204, r.text
