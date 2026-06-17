"""Regression tests proving that the asset deduplication scope is
strictly per-task: identical bytes uploaded to two distinct tasks
within the same project both succeed (each task gets its own row).

Why this exists: a user reported uploading 3000 files to a freshly
created task and seeing 2000 of them flagged "duplicate skipped"
because they had previously uploaded the same files to an older
(now-deleted) task in the same project. The fear was that the
``UniqueConstraint("task_id", "xxh3_128")`` had silently degraded to
project-scoped — these tests rule that out and pin the contract.

Pair with the frontend ``AssetUploadDialog`` cancel + abort fix
which addresses the actual root cause (orphan background uploads to
the original task that kept firing after the user closed the
dialog).
"""

import io

import pytest
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


def _hdr(t):
    return {"Authorization": f"Bearer {t}"}


def _tiny_png() -> bytes:
    return bytes.fromhex(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489"
        "0000000A4944415478DA63000000000200015C8B59FA0000000049454E44AE426082"
    )


class _FakeStorage:
    @classmethod
    def from_settings(cls):
        return cls()

    def ensure_bucket(self):
        pass

    def put_object(self, *a, **k):
        pass

    def get_object(self, key):
        return io.BytesIO(_tiny_png())

    def remove_object(self, key):
        pass

    def presigned_get(self, key, **k):
        return f"https://fake/{key}"


@pytest.fixture
def _bootstrap(db_session, monkeypatch):
    from carve_api.assets import service as svc_mod

    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client = _client(db_session)
    client.post(
        "/auth/register", json={"email": "dedup@x.com", "password": "hunter22"},
    )
    token = client.post(
        "/auth/login",
        json={"email": "dedup@x.com", "password": "hunter22"},
    ).json()["access_token"]
    pid = client.post(
        "/projects", json={"name": "P"}, headers=_hdr(token),
    ).json()["id"]
    return client, token, pid


def test_same_bytes_upload_to_two_tasks_both_succeed(_bootstrap) -> None:
    """The asset uniqueness constraint is ``(task_id, xxh3_128)``. Two
    tasks in the same project — same name or different — must each
    accept the same file independently."""
    client, token, pid = _bootstrap

    t1 = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "task2", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    t2 = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "task2", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    assert t1 != t2, "two POSTs with the same name must produce distinct tasks"

    png = _tiny_png()
    r1 = client.post(
        f"/tasks/{t1}/assets",
        files={"file": ("a.png", io.BytesIO(png), "image/png")},
        headers=_hdr(token),
    )
    r2 = client.post(
        f"/tasks/{t2}/assets",
        files={"file": ("a.png", io.BytesIO(png), "image/png")},
        headers=_hdr(token),
    )
    assert r1.status_code == 201, r1.text
    assert r2.status_code == 201, r2.text
    # Distinct asset ids — each task owns its own row.
    assert r1.json()["id"] != r2.json()["id"]


def test_same_filename_same_task_is_skipped(_bootstrap) -> None:
    """Dedup is now by FILENAME: re-uploading the same name to the same task
    is skipped with the distinct asset_name_exists code (so the UI can report
    a benign 'skipped', not a hard error)."""
    client, token, pid = _bootstrap
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]

    png = _tiny_png()
    first = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(png), "image/png")},
        headers=_hdr(token),
    )
    second = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(png), "image/png")},
        headers=_hdr(token),
    )
    assert first.status_code == 201
    assert second.status_code == 409
    assert second.json()["error"] == "asset_name_exists"


def test_same_content_different_name_same_task_allowed(_bootstrap) -> None:
    """Identical bytes under a DIFFERENT filename in the same task now upload
    fine — content dedup was removed; only the filename is deduped."""
    client, token, pid = _bootstrap
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]

    png = _tiny_png()
    first = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(png), "image/png")},
        headers=_hdr(token),
    )
    second = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("b.png", io.BytesIO(png), "image/png")},
        headers=_hdr(token),
    )
    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert first.json()["id"] != second.json()["id"]


def test_deleting_task_does_not_block_reupload_to_new_task(_bootstrap) -> None:
    """Reproduces the user's scenario: upload files to task1, soft-
    delete task1, create task2 (same name), re-upload same files —
    every byte-identical file must land in task2 successfully."""
    client, token, pid = _bootstrap
    t1 = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "task2", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    png = _tiny_png()
    r_first = client.post(
        f"/tasks/{t1}/assets",
        files={"file": ("a.png", io.BytesIO(png), "image/png")},
        headers=_hdr(token),
    )
    assert r_first.status_code == 201
    # Soft-delete task1 (sets deleted_at).
    client.delete(f"/projects/{pid}/tasks/{t1}", headers=_hdr(token))

    t2 = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "task2", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    assert t2 != t1
    r = client.post(
        f"/tasks/{t2}/assets",
        files={"file": ("a.png", io.BytesIO(png), "image/png")},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
