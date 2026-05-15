"""Regression tests for the autosave deadlock:

Scenario the user hit in production
-----------------------------------
1. User triggers SAM auto-annotate.
2. Mid-run, user deletes a polygon on a different frame.
3. The autosave batch fires; ``pendingDeletes`` contains the polygon's id.
4. Between the autosave's debounce and the request landing, the polygon's
   id is no longer on the server (a duplicate autosave or an
   ``overwrite=true`` predict already removed it).
5. The batch endpoint raised ``404 annotation_not_found`` which rolled
   back the ENTIRE batch — no creates, no updates, no other deletes
   persisted.
6. The frontend kept the stale id in ``pendingDeletes`` and the dirty
   drafts. Any subsequent edit re-fired the same poisoned batch → 404
   again → "Save failed" toast spam until the user refreshed.

The fix
-------
``DELETE`` is idempotent (REST semantics). A request to remove an
annotation that no longer exists is treated as success: the id is
echoed in the response's ``deleted`` array so the client clears its
queue and stops retrying. The rest of the batch (creates, updates,
other deletes) commits normally.
"""

import io

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


def _setup(client, monkeypatch):
    from carve_api.assets import service as svc_mod

    class _FakeStorage:
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
            pass

        def presigned_get(self, key, **k):
            return f"https://fake/{key}"

    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client.post(
        "/auth/register", json={"email": "idem@x.com", "password": "hunter22"},
    )
    token = client.post(
        "/auth/login",
        json={"email": "idem@x.com", "password": "hunter22"},
    ).json()["access_token"]
    pid = client.post(
        "/projects", json={"name": "P"}, headers=_hdr(token),
    ).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    cid = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "car", "color": "#ff0000"},
        headers=_hdr(token),
    ).json()["id"]
    aid = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(_tiny_png()), "image/png")},
        headers=_hdr(token),
    ).json()["id"]
    fid = client.get(f"/assets/{aid}", headers=_hdr(token)).json()["frame_id"]
    return token, tid, cid, fid


def test_batch_delete_missing_id_is_idempotent(db_session, monkeypatch) -> None:
    """Deleting an annotation that's already gone returns 200 with the
    id echoed in ``deleted`` — does NOT 404 the whole batch."""
    client = _client(db_session)
    token, tid, cid, fid = _setup(client, monkeypatch)

    # Create one annotation and immediately delete it server-side so the
    # batch sees an id the DB doesn't recognise.
    ann_id = client.post(
        f"/tasks/{tid}/annotations",
        json={
            "frame_id": fid,
            "class_id": cid,
            "kind": "bbox",
            "geometry": {"kind": "bbox", "x": 0, "y": 0, "w": 5, "h": 5},
        },
        headers=_hdr(token),
    ).json()["id"]
    r = client.delete(f"/annotations/{ann_id}", headers=_hdr(token))
    assert r.status_code == 204

    rb = client.post(
        f"/tasks/{tid}/annotations:batch",
        json={"create": [], "update": [], "delete": [ann_id]},
        headers=_hdr(token),
    )
    assert rb.status_code == 200, rb.text
    body = rb.json()
    assert body["deleted"] == [ann_id]


def test_batch_with_stale_delete_still_commits_creates(
    db_session, monkeypatch,
) -> None:
    """Reproduces the production scenario: the autosave batch contains
    a stale delete id plus fresh creates/updates. The stale delete
    must NOT roll back the rest of the payload."""
    client = _client(db_session)
    token, tid, cid, fid = _setup(client, monkeypatch)

    # Create a real annotation we'll legitimately update.
    real_id = client.post(
        f"/tasks/{tid}/annotations",
        json={
            "frame_id": fid,
            "class_id": cid,
            "kind": "bbox",
            "geometry": {"kind": "bbox", "x": 1, "y": 1, "w": 3, "h": 3},
        },
        headers=_hdr(token),
    ).json()["id"]

    # And another that we'll delete BEFORE the batch — so the batch's
    # ``delete`` list contains a stale id.
    stale_id = client.post(
        f"/tasks/{tid}/annotations",
        json={
            "frame_id": fid,
            "class_id": cid,
            "kind": "bbox",
            "geometry": {"kind": "bbox", "x": 4, "y": 4, "w": 2, "h": 2},
        },
        headers=_hdr(token),
    ).json()["id"]
    client.delete(f"/annotations/{stale_id}", headers=_hdr(token))

    payload = {
        "create": [
            {
                "frame_id": fid,
                "class_id": cid,
                "kind": "bbox",
                "geometry": {"kind": "bbox", "x": 8, "y": 8, "w": 4, "h": 4},
            },
        ],
        "update": [
            {
                "id": real_id,
                "kind": "bbox",
                "geometry": {"kind": "bbox", "x": 9, "y": 9, "w": 9, "h": 9},
                "class_id": cid,
            },
        ],
        "delete": [stale_id],
    }
    rb = client.post(
        f"/tasks/{tid}/annotations:batch",
        json=payload,
        headers=_hdr(token),
    )
    assert rb.status_code == 200, rb.text
    body = rb.json()
    assert len(body["created"]) == 1, body
    assert len(body["updated"]) == 1, body
    assert body["updated"][0]["geometry"]["w"] == 9
    assert body["deleted"] == [stale_id]
