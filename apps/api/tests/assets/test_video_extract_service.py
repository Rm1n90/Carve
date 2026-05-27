# Armin Mehri — mehri.armin@gmail.com
"""Service-layer tests for ``video_extract_service``.

These tests monkeypatch the Redis access + RQ enqueue so the service
can be exercised without a running Redis or worker. Live wiring is
covered by the manual E2E (Task 13)."""
from __future__ import annotations

import uuid as _uuid
from typing import Any

import pytest

from carve_api.assets.video_extract_schemas import BatchEnqueueIn
from carve_api.assets import video_extract_service as svc
from carve_api.jobs import video_to_images as worker_mod


# ---------------------------------------------------------------------------
# Fake Redis — supports only the calls the service actually makes.
# ---------------------------------------------------------------------------
class _FakeRedis:
    def __init__(self) -> None:
        self.sets: dict[str, set[str]] = {}
        self.strings: dict[str, str] = {}
        self.hashes: dict[str, dict[str, str]] = {}

    def sadd(self, key, *vals):
        self.sets.setdefault(key, set()).update(str(v) for v in vals)

    def smembers(self, key):
        return set(self.sets.get(key, set()))

    def set(self, key, val, ex=None):  # noqa: ARG002
        self.strings[key] = str(val)

    def get(self, key):
        return self.strings.get(key)

    def expire(self, key, seconds):  # noqa: ARG002
        return True

    def hset(self, key, *args, mapping=None, **kw):
        """Accept both ``hset(key, mapping={...})`` and ``hset(key, field, value)``."""
        h = self.hashes.setdefault(key, {})
        if mapping:
            for k, v in mapping.items():
                h[k] = str(v) if v is not None else ""
        if args:
            # Positional (field, value) pair.
            if len(args) == 2:
                field, value = args
                h[field] = str(value) if value is not None else ""
            elif len(args) % 2 == 0:
                for i in range(0, len(args), 2):
                    h[args[i]] = str(args[i + 1]) if args[i + 1] is not None else ""
        for k, v in kw.items():
            h[k] = str(v) if v is not None else ""

    def hget(self, key, field):
        return self.hashes.get(key, {}).get(field)

    def hgetall(self, key):
        return dict(self.hashes.get(key, {}))


@pytest.fixture
def fake_redis(monkeypatch):
    r = _FakeRedis()
    monkeypatch.setattr(svc, "_redis", lambda: r)
    monkeypatch.setattr(worker_mod, "_redis", lambda: r)
    return r


@pytest.fixture
def captured_enqueues(monkeypatch):
    calls: list[Any] = []

    def fake_enqueue(payload):
        calls.append(payload)
        return payload.job_id

    monkeypatch.setattr(svc, "_enqueue", fake_enqueue)
    return calls


# ---------------------------------------------------------------------------
# Test helpers — minimal stand-ins so we can call the service without going
# through the full project model factories.
# ---------------------------------------------------------------------------
class _StubTask:
    def __init__(self, kind: str) -> None:
        self.id = _uuid.uuid4()
        from carve_api.projects.models import TaskKind
        self.kind = TaskKind.image if kind == "image" else TaskKind.video


class _StubAssetQuery:
    def __init__(self, assets: list[Any]) -> None:
        self._assets = assets

    def filter(self, criterion):  # noqa: ARG002
        return self

    def all(self):
        return list(self._assets)


class _StubDB:
    def __init__(self, assets: list[Any]) -> None:
        self._assets = assets

    def query(self, _model):
        return _StubAssetQuery(self._assets)


def _video_asset(task_id, name="x.mp4"):
    from carve_api.assets.models import AssetKind
    return type(
        "FakeAsset",
        (),
        {
            "id": _uuid.uuid4(),
            "task_id": task_id,
            "kind": AssetKind.video,
            "original_name": name,
        },
    )()


def _image_asset(task_id):
    from carve_api.assets.models import AssetKind
    return type(
        "FakeAsset",
        (),
        {
            "id": _uuid.uuid4(),
            "task_id": task_id,
            "kind": AssetKind.image,
            "original_name": "y.jpg",
        },
    )()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
def test_enqueue_happy_path(fake_redis, captured_enqueues) -> None:
    task = _StubTask("image")
    v1 = _video_asset(task.id, "a.mp4")
    v2 = _video_asset(task.id, "b.mp4")
    db = _StubDB([v1, v2])

    out = svc.enqueue_batch(
        db,
        task=task,
        payload=BatchEnqueueIn(
            source_asset_ids=[v1.id, v2.id],
            mode="count",
            n_or_k=10,
            quality=75,
        ),
    )
    assert len(out.jobs) == 2
    assert {j.source_filename for j in out.jobs} == {"a.mp4", "b.mp4"}
    assert all(j.status == "queued" for j in out.jobs)
    assert len(captured_enqueues) == 2


def test_enqueue_rejects_video_task(fake_redis, captured_enqueues) -> None:
    task = _StubTask("video")
    v = _video_asset(task.id)
    db = _StubDB([v])
    with pytest.raises(svc.VideoExtractError, match="image-kind task"):
        svc.enqueue_batch(
            db,
            task=task,
            payload=BatchEnqueueIn(
                source_asset_ids=[v.id], mode="auto", n_or_k=0, quality=75
            ),
        )


def test_enqueue_rejects_asset_not_in_task(fake_redis, captured_enqueues) -> None:
    task = _StubTask("image")
    db = _StubDB([])
    bogus = _uuid.uuid4()
    with pytest.raises(svc.VideoExtractError, match="not in this task"):
        svc.enqueue_batch(
            db,
            task=task,
            payload=BatchEnqueueIn(
                source_asset_ids=[bogus], mode="auto", n_or_k=0, quality=75
            ),
        )


def test_enqueue_rejects_image_asset(fake_redis, captured_enqueues) -> None:
    task = _StubTask("image")
    img = _image_asset(task.id)
    db = _StubDB([img])
    with pytest.raises(svc.VideoExtractError, match="not a video"):
        svc.enqueue_batch(
            db,
            task=task,
            payload=BatchEnqueueIn(
                source_asset_ids=[img.id], mode="auto", n_or_k=0, quality=75
            ),
        )


def test_enqueue_rejects_concurrent(fake_redis, captured_enqueues) -> None:
    task = _StubTask("image")
    v = _video_asset(task.id)
    db = _StubDB([v])
    body = BatchEnqueueIn(
        source_asset_ids=[v.id], mode="auto", n_or_k=0, quality=75
    )
    svc.enqueue_batch(db, task=task, payload=body)
    with pytest.raises(
        svc.VideoExtractError, match="already.*queued|already.*running"
    ) as exc:
        svc.enqueue_batch(db, task=task, payload=body)
    assert exc.value.status_code == 409


def test_get_batch_status_404(fake_redis) -> None:
    task = _StubTask("image")
    with pytest.raises(svc.VideoExtractError, match="batch.*not found"):
        svc.get_batch_status(task=task, batch_id=_uuid.uuid4())


def test_cancel_marks_jobs(fake_redis, captured_enqueues) -> None:
    task = _StubTask("image")
    v = _video_asset(task.id)
    db = _StubDB([v])
    out = svc.enqueue_batch(
        db,
        task=task,
        payload=BatchEnqueueIn(
            source_asset_ids=[v.id], mode="auto", n_or_k=0, quality=75
        ),
    )
    worker_mod.set_progress(out.jobs[0].job_id, {"status": "queued"})

    svc.cancel_batch(task=task, batch_id=out.batch_id)

    assert worker_mod.is_cancel_requested(out.jobs[0].job_id)
    status = worker_mod.get_progress(out.jobs[0].job_id).get("status")
    assert status == "cancelled"
