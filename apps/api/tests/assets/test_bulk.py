"""Bulk delete and bulk move of selected images, with their preview."""

import io
import uuid

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import func, select

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets import router as assets_router
from carve_api.assets.models import Asset
from carve_api.deps import get_db
from carve_api.logo_ai.models import LogoAiJob
from carve_api.main import create_app
from carve_api.projects.models import Task


class _FakeStorage:
    removed: list[str] = []

    @classmethod
    def from_settings(cls):
        return cls()

    def ensure_bucket(self):
        pass

    def put_object(self, *a, **k):
        pass

    def get_object(self, key):
        return io.BytesIO(b"")

    def remove_object(self, key):
        _FakeStorage.removed.append(key)

    def presigned_get(self, key, **k):
        return f"https://fake/{key}"


def _client(db_session, monkeypatch):
    from carve_api.assets import service as svc_mod

    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    monkeypatch.setattr(assets_router, "MinioClient", _FakeStorage)
    _FakeStorage.removed = []
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(t):
    return {"Authorization": f"Bearer {t}"}


def _png(shade: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (shade, 1, 2)).save(buf, format="PNG")
    return buf.getvalue()


def _upload(client, token, tid, name, shade):
    r = client.post(
        f"/tasks/{tid}/assets",
        files={"file": (name, io.BytesIO(_png(shade)), "image/png")},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    aid = r.json()["id"]
    return aid, client.get(f"/assets/{aid}", headers=_hdr(token)).json()["frame_id"]


def _setup(client):
    client.post("/auth/register", json={"email": "bulk@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "bulk@x.com", "password": "hunter22"}).json()[
        "access_token"
    ]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    cls = {}
    for i, name in enumerate(("person", "crowd", "backdrop")):
        cls[name] = client.post(
            f"/projects/{pid}/classes",
            json={"idx": i, "name": name, "color": "#ff0000"},
            headers=_hdr(token),
        ).json()["id"]
    a = client.post(
        f"/projects/{pid}/tasks", json={"name": "A", "kind": "image"}, headers=_hdr(token)
    ).json()["id"]
    b = client.post(
        f"/projects/{pid}/tasks", json={"name": "B", "kind": "image"}, headers=_hdr(token)
    ).json()["id"]
    return token, pid, cls, a, b


def _box(db, tid, fid, cid):
    db.add(
        Annotation(
            task_id=uuid.UUID(tid),
            frame_id=uuid.UUID(fid),
            class_id=uuid.UUID(cid),
            kind=AnnotationKind.bbox,
            geometry={"kind": "bbox", "x": 0, "y": 0, "w": 2, "h": 2},
        )
    )
    # Committed: each request ends with a rollback of the shared session.
    db.commit()


def _scene(db_session, monkeypatch):
    """Task A: img1 (person + crowd), img2 (backdrop), img3 (none)."""
    client = _client(db_session, monkeypatch)
    token, pid, cls, a, b = _setup(client)
    img1, f1 = _upload(client, token, a, "img1.png", 10)
    img2, f2 = _upload(client, token, a, "img2.png", 20)
    img3, _ = _upload(client, token, a, "img3.png", 30)
    _box(db_session, a, f1, cls["person"])
    _box(db_session, a, f1, cls["crowd"])
    _box(db_session, a, f2, cls["backdrop"])
    return client, token, cls, a, b, (img1, img2, img3)


def _count(db, model, **where):
    q = select(func.count()).select_from(model)
    for k, v in where.items():
        q = q.where(getattr(model, k) == uuid.UUID(v))
    return db.execute(q).scalar_one()


def test_preview_counts_images_and_annotations(db_session, monkeypatch):
    client, token, _cls, a, _b, imgs = _scene(db_session, monkeypatch)
    r = client.post(
        f"/tasks/{a}/assets:bulk-preview", json={"asset_ids": list(imgs)}, headers=_hdr(token)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["images"], body["annotated_images"], body["annotations"]) == (3, 2, 3)
    assert {c["name"]: c["count"] for c in body["by_class"]} == {
        "person": 1,
        "crowd": 1,
        "backdrop": 1,
    }
    assert body["busy"] is None and body["target"] is None


def test_delete_takes_the_annotations_and_files(db_session, monkeypatch):
    client, token, _cls, a, _b, (img1, img2, img3) = _scene(db_session, monkeypatch)
    r = client.post(
        f"/tasks/{a}/assets:bulk-delete",
        json={"asset_ids": [img1, img3], "annotations_expected": 2},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"deleted": 2, "annotations_deleted": 2}
    assert _count(db_session, Asset, task_id=a) == 1
    assert _count(db_session, Annotation, task_id=a) == 1  # img2's backdrop
    assert any(k.endswith("original.png") for k in _FakeStorage.removed)


def test_delete_refuses_when_the_preview_is_out_of_date(db_session, monkeypatch):
    client, token, _cls, a, _b, (img1, _img2, _img3) = _scene(db_session, monkeypatch)
    r = client.post(
        f"/tasks/{a}/assets:bulk-delete",
        json={"asset_ids": [img1], "annotations_expected": 0},
        headers=_hdr(token),
    )
    assert r.status_code == 409
    assert r.json()["error"] == "selection_changed"
    assert _count(db_session, Asset, task_id=a) == 3


def test_move_carries_annotations_and_enables_missing_classes(db_session, monkeypatch):
    client, token, cls, a, b, (img1, img2, _img3) = _scene(db_session, monkeypatch)
    target = db_session.get(Task, uuid.UUID(b))
    target.allowed_class_ids = [uuid.UUID(cls["person"])]
    db_session.commit()
    pre = client.post(
        f"/tasks/{a}/assets:bulk-preview",
        json={"asset_ids": [img1, img2], "target_task_id": b},
        headers=_hdr(token),
    ).json()["target"]
    assert pre["to_move"] == 2 and pre["annotations_to_move"] == 3
    assert {c["name"] for c in pre["missing_classes"]} == {"crowd", "backdrop"}
    r = client.post(
        f"/tasks/{a}/assets:move",
        json={"asset_ids": [img1, img2], "target_task_id": b, "annotations_expected": 3},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["moved"] == 2 and r.json()["annotations_moved"] == 3
    assert r.json()["classes_enabled"] == 2
    assert _count(db_session, Asset, task_id=b) == 2
    assert _count(db_session, Annotation, task_id=b) == 3
    assert _count(db_session, Annotation, task_id=a) == 0
    db_session.refresh(target)
    assert {str(c) for c in target.allowed_class_ids} == {
        cls["person"],
        cls["crowd"],
        cls["backdrop"],
    }


def test_move_can_drop_annotations_of_classes_the_target_does_not_use(db_session, monkeypatch):
    client, token, cls, a, b, (img1, _img2, _img3) = _scene(db_session, monkeypatch)
    target = db_session.get(Task, uuid.UUID(b))
    target.allowed_class_ids = [uuid.UUID(cls["person"])]
    db_session.commit()
    r = client.post(
        f"/tasks/{a}/assets:move",
        json={
            "asset_ids": [img1],
            "target_task_id": b,
            "annotations_expected": 2,
            "missing_classes": "drop",
        },
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    assert (r.json()["annotations_moved"], r.json()["annotations_dropped"]) == (1, 1)
    assert _count(db_session, Annotation, task_id=b) == 1


def test_move_skips_images_the_target_has_and_renames_clashing_names(db_session, monkeypatch):
    client, token, _cls, a, b, (img1, img2, img3) = _scene(db_session, monkeypatch)
    _upload(client, token, b, "other.png", 20)  # the same file as img2
    _upload(client, token, b, "img3.png", 99)  # img3's name, another file
    pre = client.post(
        f"/tasks/{a}/assets:bulk-preview",
        json={"asset_ids": [img2, img3], "target_task_id": b},
        headers=_hdr(token),
    ).json()["target"]
    assert (pre["already_in_target"], pre["renamed"], pre["to_move"]) == (1, 1, 1)
    r = client.post(
        f"/tasks/{a}/assets:move",
        json={"asset_ids": [img2, img3], "target_task_id": b, "annotations_expected": 1},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    assert (r.json()["moved"], r.json()["skipped_duplicates"], r.json()["renamed"]) == (1, 1, 1)
    names = set(
        db_session.execute(
            select(Asset.original_name).where(Asset.task_id == uuid.UUID(b))
        ).scalars()
    )
    assert f"img3_{img3[:8]}.png" in names
    assert db_session.get(Asset, uuid.UUID(img2)).task_id == uuid.UUID(a)


def test_nothing_moves_while_a_logo_ai_run_works_on_either_task(db_session, monkeypatch):
    client, token, _cls, a, b, (img1, _img2, _img3) = _scene(db_session, monkeypatch)
    db_session.add(
        LogoAiJob(
            task_id=uuid.UUID(b),
            delivery="realtime",
            provider="openai",
            model="m",
            params={},
            status="running",
        )
    )
    db_session.commit()
    r = client.post(
        f"/tasks/{a}/assets:move",
        json={"asset_ids": [img1], "target_task_id": b, "annotations_expected": 2},
        headers=_hdr(token),
    )
    assert r.status_code == 409
    assert r.json() == {"error": "task_busy", "reason": "logo_ai_running"}
    pre = client.post(
        f"/tasks/{a}/assets:bulk-preview",
        json={"asset_ids": [img1], "target_task_id": b},
        headers=_hdr(token),
    ).json()
    assert pre["busy"] is None and pre["target"]["busy"] == "logo_ai_running"


def test_a_task_of_another_project_is_refused(db_session, monkeypatch):
    client, token, _cls, a, _b, (img1, _img2, _img3) = _scene(db_session, monkeypatch)
    pid2 = client.post("/projects", json={"name": "Q"}, headers=_hdr(token)).json()["id"]
    other = client.post(
        f"/projects/{pid2}/tasks", json={"name": "X", "kind": "image"}, headers=_hdr(token)
    ).json()["id"]
    r = client.post(
        f"/tasks/{a}/assets:move",
        json={"asset_ids": [img1], "target_task_id": other, "annotations_expected": 2},
        headers=_hdr(token),
    )
    assert r.status_code == 409
    assert r.json()["error"] == "bad_target"
