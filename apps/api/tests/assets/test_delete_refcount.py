"""Deleting an asset must not erase a content-addressed blob that other
assets still reference.

Since dedup is now by filename (not content), several assets in a task — or
across tasks — can share the same ``assets/<hash>/`` object. AssetService.delete
must only remove the blob when it is the last reference to that hash.
"""
import uuid
from io import BytesIO

from carve_api.assets.models import Asset, AssetKind
from carve_api.assets.service import AssetService
from carve_api.auth.models import User, UserRole
from carve_api.projects.models import Project, Task, TaskKind


def _tiny_png() -> bytes:
    return bytes.fromhex(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489"
        "0000000A4944415478DA63000000000200015C8B59FA0000000049454E44AE426082"
    )


class _RecordingStorage:
    def __init__(self):
        self.removed: list[str] = []

    @classmethod
    def from_settings(cls):
        return cls()

    def ensure_bucket(self):
        pass

    def put_object(self, *a, **k):
        pass

    def get_object(self, key):
        return BytesIO(_tiny_png())

    def remove_object(self, key):
        self.removed.append(key)


def _seed_task(db) -> Task:
    u = User(email=f"e-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.admin)
    db.add(u); db.flush()
    p = Project(name="P", owner_id=u.id); db.add(p); db.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image); db.add(t); db.flush()
    return t


def test_delete_keeps_blob_while_another_asset_shares_the_hash(
    db_session, monkeypatch
) -> None:
    from carve_api.assets import service as svc_mod
    monkeypatch.setattr(svc_mod, "MinioClient", _RecordingStorage)

    t = _seed_task(db_session)
    svc = AssetService(db_session)
    png = _tiny_png()
    # Same bytes, different names -> two assets sharing one assets/<hash>/ blob.
    a1 = svc.upload_stream(
        task=t, original_name="a.png", mime="image/png",
        stream=BytesIO(png), size=len(png),
    )
    a2 = svc.upload_stream(
        task=t, original_name="b.png", mime="image/png",
        stream=BytesIO(png), size=len(png),
    )
    assert a1.xxh3_128 == a2.xxh3_128  # same content => same blob key

    # Deleting the first must NOT remove the shared blob (a2 still references it).
    svc.delete(asset=a1)
    assert svc.storage.removed == [], svc.storage.removed
    assert db_session.get(Asset, a2.id) is not None

    # Deleting the last reference DOES remove the blob.
    svc.delete(asset=a2)
    assert any(a2.xxh3_128 in key for key in svc.storage.removed), svc.storage.removed
