"""Tests for the DatasetVersion package (Plan-13 Phase 7 Task 6).

Covers:
  1. Retrain pipeline registers a DatasetVersion(kind='retrain') and links
     the new Weight to it via metadata_['retrain']['dataset_version_id'].
  2. Export pipeline registers a DatasetVersion(kind='export').
  3. Service list/filter (kind, task_id, before).
  4. Differ on two trivial bundles -- added/removed counts line up.
  5. Rollback round-trip: 5 -> snapshot -> mutate to 3 -> rollback -> 5,
     plus rollback_pre/rollback_post versions and an audit row.
  6. ACL: viewer can list+diff; member cannot rollback (admin-only).
"""

from __future__ import annotations

import io
import uuid
import zipfile
from datetime import datetime, timezone
from typing import Any

from fastapi.testclient import TestClient

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.audit.models import AuditEvent
from carve_api.auth.models import User, UserRole
from carve_api.datasets.differ import diff_bundles
from carve_api.datasets.models import DatasetVersion
from carve_api.datasets.service import DatasetService
from carve_api.deps import get_db
from carve_api.exports.job import ExportJobPayload, run_export_inline
from carve_api.exports.models import Export
from carve_api.inference import model_client as model_client_mod
from carve_api.jobs.retrain import RetrainJobPayload, retrain_job
from carve_api.main import create_app
from carve_api.projects.models import Class, Project, ProjectMember, Task, TaskKind
from carve_api.weights.models import Weight


# ---------------------------------------------------------------------------
# Fakes / helpers
# ---------------------------------------------------------------------------


_PNG_BYTES = bytes.fromhex(
    "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA"
    "63000000000200015C8B59FA0000000049454E44AE426082"
)


class _FakeStorage:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    @classmethod
    def from_settings(cls):
        return cls()

    def ensure_bucket(self) -> None:
        pass

    def put_object(self, key, body, length, content_type):
        data = body.read() if hasattr(body, "read") else bytes(body)
        self.objects[key] = data

    def get_object(self, key):
        return io.BytesIO(self.objects.get(key, _PNG_BYTES))

    def remove_object(self, key):
        self.objects.pop(key, None)

    def presigned_get(self, key, expires_seconds: int = 600):
        return f"https://fake/{key}?exp={expires_seconds}"

    def presigned_get_internal(self, key, expires_seconds: int = 600):
        return f"https://fake-internal/{key}?exp={expires_seconds}"


class _FakeRedis:
    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, str]] = {}

    def hset(self, key, *args, mapping=None, **_kw):
        if mapping is not None:
            self.hashes.setdefault(key, {}).update(
                {str(k): str(v) for k, v in mapping.items()}
            )
        return 1

    def expire(self, key, ttl):
        return True

    def hgetall(self, key):
        return dict(self.hashes.get(key, {}))


def _seed_task(db_session) -> tuple[User, Task, Project, Class, Frame, Asset]:
    u = User(
        email=f"u-{uuid.uuid4()}@x.com",
        password_hash="x",
        role=UserRole.admin,
    )
    db_session.add(u)
    db_session.flush()
    p = Project(name="DS-P", owner_id=u.id)
    db_session.add(p)
    db_session.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image)
    db_session.add(t)
    db_session.flush()
    car = Class(project_id=p.id, idx=0, name="car", color="#ff0000")
    db_session.add(car)
    db_session.flush()
    a = Asset(
        task_id=t.id,
        kind=AssetKind.image,
        xxh3_128="seedhash",
        mime="image/png",
        size_bytes=1,
        width=100,
        height=80,
        frames=1,
        original_name="seed.png",
    )
    db_session.add(a)
    db_session.flush()
    f = Frame(asset_id=a.id, idx=0, pts_ms=0)
    db_session.add(f)
    db_session.flush()
    return u, t, p, car, f, a


def _bundle_with_labels(stem: str, lines: list[str]) -> bytes:
    """Build a minimal YOLO bundle with one labels file + data.yaml."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        body = ("\n".join(lines) + "\n") if lines else ""
        zf.writestr(f"labels/train/{stem}.txt", body)
        zf.writestr(
            "data.yaml",
            'path: .\ntrain: ./images/train\nval: ./images/val\nnc: 2\nnames: ["car", "bike"]\n',
        )
    return buf.getvalue()


# ---------------------------------------------------------------------------
# 1. Retrain integration
# ---------------------------------------------------------------------------


def test_retrain_registers_dataset_version(db_session, monkeypatch) -> None:
    u, t, p, car, f, _a = _seed_task(db_session)
    db_session.add(
        Annotation(
            task_id=t.id,
            frame_id=f.id,
            class_id=car.id,
            kind=AnnotationKind.bbox,
            geometry={"x": 10, "y": 10, "w": 20, "h": 20},
            status="accepted",
        )
    )
    db_session.flush()

    storage = _FakeStorage()
    redis = _FakeRedis()

    def fake_yolo_train(*, weight_id_base, dataset_zip_url, epochs, imgsz, device="auto"):
        return {
            "weight_id": "abcdef0123456789abcdef0123456789",
            "weights_url": "https://fake-internal/x.pt",
            "xxh3_128": "ff" * 16,
            "size_bytes": 1234,
            "metrics": {"metrics/mAP50": 0.5},
        }

    monkeypatch.setattr(model_client_mod, "yolo_train", fake_yolo_train)

    payload = RetrainJobPayload(
        job_id=str(uuid.uuid4()),
        actor_id=str(u.id),
        task_id=str(t.id),
        base_weight_id=None,
        epochs=1,
        imgsz=640,
        include_proposed=False,
        weight_name=None,
    )
    result = retrain_job(
        payload, session=db_session, storage=storage, redis_client=redis
    )
    assert result["ok"] is True

    rows = DatasetService.list_for_project(db_session, p.id)
    assert any(r.kind == "retrain" for r in rows)
    retrain_row = next(r for r in rows if r.kind == "retrain")
    assert retrain_row.task_id == t.id
    assert retrain_row.source == payload.job_id
    assert retrain_row.blob_key == f"retrain/{t.id}/{payload.job_id}/dataset.zip"
    # Linked from Weight.metadata_.
    new_w = db_session.get(Weight, uuid.UUID(result["weight_id"]))
    assert new_w is not None
    assert new_w.metadata_ is not None
    assert (
        new_w.metadata_["retrain"]["dataset_version_id"]
        == str(retrain_row.id)
    )


# ---------------------------------------------------------------------------
# 2. Export integration
# ---------------------------------------------------------------------------


def test_export_registers_dataset_version(db_session) -> None:
    u, t, p, car, f, _a = _seed_task(db_session)
    db_session.add(
        Annotation(
            task_id=t.id,
            frame_id=f.id,
            class_id=car.id,
            kind=AnnotationKind.bbox,
            geometry={"x": 10, "y": 10, "w": 20, "h": 20},
            status="accepted",
        )
    )
    db_session.flush()
    e = Export(
        task_id=t.id,
        format="yolo",
        class_remap={str(car.id): {"export_id": 0, "name": "car"}},
        created_by=u.id,
    )
    db_session.add(e)
    db_session.flush()

    storage = _FakeStorage()
    payload = ExportJobPayload(
        export_id=str(e.id),
        actor_id=str(u.id),
        task_id=str(t.id),
        fmt="yolo",
        class_remap={str(car.id): {"export_id": 0, "name": "car"}},
        include_images=False,
        splits={"train": 1.0, "val": 0.0, "test": 0.0},
    )
    res = run_export_inline(session=db_session, storage=storage, payload=payload)
    assert res["status"] == "completed"

    rows = DatasetService.list_for_project(db_session, p.id, kind="export")
    assert len(rows) == 1
    assert rows[0].source == str(e.id)
    assert rows[0].blob_key == res["minio_key"]


# ---------------------------------------------------------------------------
# 3. Service list/filter
# ---------------------------------------------------------------------------


def test_list_for_project_filters(db_session) -> None:
    u, t, p, _car, _f, _a = _seed_task(db_session)
    other_task = Task(project_id=p.id, name="T2", kind=TaskKind.image)
    db_session.add(other_task)
    db_session.flush()

    DatasetService.register(
        db_session, project_id=p.id, task_id=t.id, kind="manual",
        source=None, created_by=u.id, label="manual-1",
        summary={"a": 1}, blob_key=None,
    )
    DatasetService.register(
        db_session, project_id=p.id, task_id=t.id, kind="export",
        source="x", created_by=u.id, label="export-1",
        summary={}, blob_key="k1",
    )
    DatasetService.register(
        db_session, project_id=p.id, task_id=other_task.id, kind="manual",
        source=None, created_by=u.id, label="manual-other",
        summary={}, blob_key=None,
    )

    by_kind = DatasetService.list_for_project(db_session, p.id, kind="manual")
    assert {r.label for r in by_kind} == {"manual-1", "manual-other"}

    by_task = DatasetService.list_for_project(
        db_session, p.id, task_id=other_task.id
    )
    assert [r.label for r in by_task] == ["manual-other"]

    # Before filter: rows have created_at = now(); using a future cutoff
    # returns all, a past cutoff returns nothing.
    future = datetime.now(timezone.utc).replace(year=2099)
    past = datetime.now(timezone.utc).replace(year=1999)
    assert len(DatasetService.list_for_project(db_session, p.id, before=future)) >= 3
    assert DatasetService.list_for_project(db_session, p.id, before=past) == []


# ---------------------------------------------------------------------------
# 4. Differ
# ---------------------------------------------------------------------------


def test_differ_added_removed_changed_counts() -> None:
    # Side A: 2 cars on stem "img1".
    a = _bundle_with_labels(
        "img1",
        [
            "0 0.10 0.10 0.05 0.05",
            "0 0.50 0.50 0.10 0.10",
        ],
    )
    # Side B: 1 car (moved center >>5%) + 1 bike (added).
    b = _bundle_with_labels(
        "img1",
        [
            "0 0.30 0.30 0.05 0.05",  # changed (center moved ~20%)
            "1 0.70 0.70 0.05 0.05",  # added (new class)
        ],
    )
    diff = diff_bundles(a, b)
    # One car was removed (A had 2, B has 1 in class 0 -- common is 1, the
    # one common pair counts as changed because center moved >5%).
    assert diff.removed.get("car") == 1
    assert diff.added.get("bike") == 1
    assert diff.changed.get("car") == 1


def test_differ_coco_unsupported_v1() -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("coco.json", '{"images": []}')
    coco_bundle = buf.getvalue()
    yolo_bundle = _bundle_with_labels("img1", ["0 0.1 0.1 0.05 0.05"])
    diff = diff_bundles(yolo_bundle, coco_bundle)
    assert diff.note == "coco_unsupported_v1"


# ---------------------------------------------------------------------------
# 5. Rollback round-trip via HTTP
# ---------------------------------------------------------------------------


def _client_with_overrides(db_session, storage):
    app = create_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db

    # Patch MinioClient.from_settings used by the router.
    from carve_api.datasets import router as ds_router

    ds_router.MinioClient = type(  # type: ignore[assignment]
        "_MC", (), {"from_settings": staticmethod(lambda: storage)}
    )
    return TestClient(app)


def _hdr(tok: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {tok}"}


def _mint_token(user: User) -> str:
    """Mint an access token for an already-seeded user, bypassing the
    first-user-only ``/auth/register`` and admin-gated ``/auth/members``
    paths so tests can drive the API as any seeded user.
    """
    from carve_api.auth.jwt import create_access_token

    return create_access_token(subject=str(user.id), role=user.role.value)


def test_rollback_roundtrip_and_audit(db_session) -> None:
    u, t, p, car, f, a = _seed_task(db_session)
    # 5 accepted annotations.
    for i in range(5):
        db_session.add(
            Annotation(
                task_id=t.id,
                frame_id=f.id,
                class_id=car.id,
                kind=AnnotationKind.bbox,
                geometry={"x": i * 5, "y": i * 5, "w": 10, "h": 10},
                status="accepted",
            )
        )
    db_session.flush()

    # Build a YOLO bundle representing the 5-annotation state, store it
    # under a manual DatasetVersion blob_key.
    storage = _FakeStorage()
    lines = []
    for i in range(5):
        cx = (i * 5 + 5.0) / 100.0
        cy = (i * 5 + 5.0) / 80.0
        w_n = 10.0 / 100.0
        h_n = 10.0 / 80.0
        lines.append(f"0 {cx:.6f} {cy:.6f} {w_n:.6f} {h_n:.6f}")
    bundle = _bundle_with_labels("seed", lines)
    blob_key = f"manual/{t.id}/snapshot.zip"
    storage.objects[blob_key] = bundle

    snapshot = DatasetService.register(
        db_session,
        project_id=p.id,
        task_id=t.id,
        kind="manual",
        source=None,
        created_by=u.id,
        label="snapshot-5",
        summary={"annotations": 5},
        blob_key=blob_key,
    )
    db_session.commit()

    # Mutate to 3 annotations.
    extant = list(
        db_session.execute(
            __import__("sqlalchemy").select(Annotation).where(
                Annotation.task_id == t.id
            )
        ).scalars()
    )
    for ann in extant[3:]:
        db_session.delete(ann)
    db_session.commit()

    client = _client_with_overrides(db_session, storage)
    token = _mint_token(u)

    resp = client.post(
        f"/projects/{p.id}/datasets/{snapshot.id}/rollback",
        json={"task_id": str(t.id)},
        headers=_hdr(token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["replaced_count"] == 3
    assert body["restored_count"] == 5

    # Annotations are back to 5.
    after = list(
        db_session.execute(
            __import__("sqlalchemy").select(Annotation).where(
                Annotation.task_id == t.id
            )
        ).scalars()
    )
    assert len(after) == 5

    # rollback_pre + rollback_post versions exist.
    versions = DatasetService.list_for_project(db_session, p.id)
    kinds = [v.kind for v in versions]
    assert "rollback_pre" in kinds
    assert "rollback_post" in kinds

    # Audit row recorded.
    audit_rows = list(
        db_session.execute(
            __import__("sqlalchemy").select(AuditEvent).where(
                AuditEvent.project_id == p.id,
                AuditEvent.action == "dataset.rolled_back",
            )
        ).scalars()
    )
    assert len(audit_rows) == 1
    assert audit_rows[0].metadata_["replaced_count"] == 3
    assert audit_rows[0].metadata_["restored_count"] == 5


# ---------------------------------------------------------------------------
# 6. ACL: viewer can list+diff; member cannot rollback (admin-only).
# ---------------------------------------------------------------------------


def test_acl_viewer_can_list_member_cannot_rollback(db_session) -> None:
    # Seed an owner + a non-admin viewer + a non-admin member directly in
    # the DB so we don't depend on the public /auth/register flow.
    owner = User(
        email=f"o-{uuid.uuid4()}@x.com",
        password_hash="x",
        role=UserRole.admin,
    )
    viewer = User(
        email=f"v-{uuid.uuid4()}@x.com",
        password_hash="x",
        role=UserRole.member,
    )
    member = User(
        email=f"m-{uuid.uuid4()}@x.com",
        password_hash="x",
        role=UserRole.member,
    )
    db_session.add_all([owner, viewer, member])
    db_session.flush()
    proj = Project(name="ACL-P", owner_id=owner.id)
    db_session.add(proj)
    db_session.flush()
    pid = proj.id
    db_session.add(
        ProjectMember(project_id=pid, user_id=owner.id, role="owner")
    )
    db_session.add(
        ProjectMember(project_id=pid, user_id=viewer.id, role="viewer")
    )
    db_session.add(
        ProjectMember(project_id=pid, user_id=member.id, role="member")
    )
    db_session.commit()

    storage = _FakeStorage()
    client = _client_with_overrides(db_session, storage)
    owner_tok = _mint_token(owner)
    viewer_tok = _mint_token(viewer)
    member_tok = _mint_token(member)

    # List endpoint -- viewer 200.
    r = client.get(
        f"/projects/{pid}/datasets", headers=_hdr(viewer_tok)
    )
    assert r.status_code == 200, r.text

    # Create a dataset version we can target for rollback.
    # First create a task with at least one frame so rollback validation
    # can pass.
    proj = db_session.get(Project, pid)
    t = Task(project_id=proj.id, name="T", kind=TaskKind.image)
    db_session.add(t)
    db_session.flush()
    car = Class(project_id=proj.id, idx=0, name="car", color="#ff0000")
    db_session.add(car)
    db_session.flush()
    a = Asset(
        task_id=t.id,
        kind=AssetKind.image,
        xxh3_128="acl",
        mime="image/png",
        size_bytes=1,
        width=100,
        height=80,
        frames=1,
        original_name="acl.png",
    )
    db_session.add(a)
    db_session.flush()
    fr = Frame(asset_id=a.id, idx=0, pts_ms=0)
    db_session.add(fr)
    db_session.flush()
    bundle = _bundle_with_labels("acl", ["0 0.5 0.5 0.1 0.1"])
    blob_key = f"manual/{t.id}/snap.zip"
    storage.objects[blob_key] = bundle
    ds = DatasetService.register(
        db_session,
        project_id=proj.id,
        task_id=t.id,
        kind="manual",
        source=None,
        created_by=proj.owner_id,
        label="snap",
        summary={},
        blob_key=blob_key,
    )
    db_session.commit()

    # Member (role="member") cannot rollback.
    r = client.post(
        f"/projects/{pid}/datasets/{ds.id}/rollback",
        json={"task_id": str(t.id)},
        headers=_hdr(member_tok),
    )
    assert r.status_code == 403, r.text

    # Viewer cannot rollback either.
    r = client.post(
        f"/projects/{pid}/datasets/{ds.id}/rollback",
        json={"task_id": str(t.id)},
        headers=_hdr(viewer_tok),
    )
    assert r.status_code == 403, r.text

    # Viewer CAN diff (compute diff with itself for a deterministic call).
    r = client.get(
        f"/projects/{pid}/datasets/{ds.id}/diff/{ds.id}",
        headers=_hdr(viewer_tok),
    )
    assert r.status_code == 200, r.text
