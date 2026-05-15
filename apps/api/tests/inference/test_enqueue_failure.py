"""Regression tests for the batch-enqueue routes — when Redis is
unreachable or the enqueue itself raises, the endpoint must return
HTTP 503 with a clear detail instead of silently returning a phantom
``job_id``.

Why this matters: a user reported running SAM 3.1 auto-annotate
"on all assets" and the dialog getting stuck on "Initialising…". The
worker had never received the job — the route's old
``try/except Exception: pass`` block had silently swallowed the
enqueue failure and returned a job_id anyway. The frontend polled a
job that never existed forever.
"""

import io

import pytest
from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.inference import router as inference_router_mod
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
    """Project + task + at least one image + a class with a text prompt
    so the SAM auto-text-batch route passes its 422 guards and reaches
    the enqueue branch."""
    from carve_api.assets import service as svc_mod

    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client = _client(db_session)
    client.post(
        "/auth/register", json={"email": "enq@x.com", "password": "hunter22"},
    )
    token = client.post(
        "/auth/login",
        json={"email": "enq@x.com", "password": "hunter22"},
    ).json()["access_token"]
    pid = client.post(
        "/projects", json={"name": "P"}, headers=_hdr(token),
    ).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(_tiny_png()), "image/png")},
        headers=_hdr(token),
    )
    cls = client.post(
        f"/projects/{pid}/classes",
        json={
            "idx": 0,
            "name": "person",
            "color": "#ff0000",
            "text_prompt": "a person",
        },
        headers=_hdr(token),
    ).json()
    return client, token, pid, tid, cls["id"]


def test_sam_auto_text_batch_returns_503_when_redis_unavailable(
    _bootstrap, monkeypatch,
) -> None:
    """Repros the user's "stuck in Initialising" symptom: Redis is
    unavailable so the enqueue fails. The route must return 503
    instead of a phantom job_id."""
    client, token, _pid, tid, cls_id = _bootstrap
    # Force the redis-probe helper to report unavailable. The route
    # checks the result and short-circuits with HTTP 503.
    monkeypatch.setattr(
        inference_router_mod, "_redis_client_or_none", lambda: None,
    )
    r = client.post(
        f"/tasks/{tid}/sam/auto-text-batch",
        json={"class_ids": [cls_id], "threshold": 0.5},
        headers=_hdr(token),
    )
    assert r.status_code == 503, r.text
    body = r.json()
    assert body.get("error") == "redis_unavailable", body
    # Critically: NO ``job_id`` field — the old code returned one even
    # when the job wasn't queued.
    assert "job_id" not in body


def test_sam_auto_text_batch_returns_503_when_enqueue_raises(
    _bootstrap, monkeypatch,
) -> None:
    """If the RQ ``enqueue`` raises (e.g. Redis blip after the ping,
    rq lib mismatch, payload pickle failure), the route must surface
    503 instead of pretending the job was queued."""
    client, token, _pid, tid, cls_id = _bootstrap

    # Pretend Redis IS reachable (otherwise the route short-circuits
    # to ``redis_unavailable`` before reaching the enqueue path).
    class _FakeRedis:
        def ping(self):
            return True

    monkeypatch.setattr(
        inference_router_mod, "_redis_client_or_none", lambda: _FakeRedis(),
    )

    # Make ``enqueue_with_defaults`` raise. The route imports it
    # freshly inside the function, so the patch must hit the module
    # attribute the import resolves to.
    from carve_api.jobs import queue as queue_mod

    def _boom(*_a, **_k):
        raise RuntimeError("simulated rq failure")

    monkeypatch.setattr(queue_mod, "enqueue_with_defaults", _boom)
    r = client.post(
        f"/tasks/{tid}/sam/auto-text-batch",
        json={"class_ids": [cls_id], "threshold": 0.5},
        headers=_hdr(token),
    )
    assert r.status_code == 503, r.text
    body = r.json()
    assert body.get("error") == "enqueue_failed", body
    assert "job_id" not in body
