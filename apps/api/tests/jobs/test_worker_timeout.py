"""Tests for plan-09 task-09 — worker timeout/retry helpers + traceback capture."""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock

import pytest

from carve_api.inference.model_client import ModelServiceError
from carve_api.jobs.queue import enqueue_with_defaults
from carve_api.jobs.retry import run_with_retry


# ---------------------------------------------------------------------------
# run_with_retry — transient (503) is retried; non-transient is re-raised.
# ---------------------------------------------------------------------------


def test_run_with_retry_retries_three_times_on_503_then_raises(monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr("time.sleep", lambda s: sleeps.append(s))

    calls = {"n": 0}

    def always_503():
        calls["n"] += 1
        raise ModelServiceError(503, {"error": "model_service_unreachable"})

    with pytest.raises(ModelServiceError) as excinfo:
        run_with_retry(always_503, attempts=3, backoff_s=10)

    assert calls["n"] == 3
    assert excinfo.value.status_code == 503
    # Two sleeps between three attempts (linear: 10, 20). The last attempt
    # exhausts the budget without sleeping again.
    assert sleeps == [10, 20]


def test_run_with_retry_does_not_retry_on_non_transient(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)

    calls = {"n": 0}

    def boom():
        calls["n"] += 1
        raise ValueError("nope")

    with pytest.raises(ValueError, match="nope"):
        run_with_retry(boom, attempts=3, backoff_s=0)

    assert calls["n"] == 1


def test_run_with_retry_returns_value_on_eventual_success(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)

    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 2:
            raise ModelServiceError(503, {"error": "warming"})
        return "ok"

    assert run_with_retry(flaky, attempts=3, backoff_s=0) == "ok"
    assert calls["n"] == 2


def test_run_with_retry_does_not_retry_on_non_503_model_error(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)

    calls = {"n": 0}

    def four_oh_four():
        calls["n"] += 1
        raise ModelServiceError(404, {"error": "not_found"})

    with pytest.raises(ModelServiceError) as excinfo:
        run_with_retry(four_oh_four, attempts=3, backoff_s=0)

    assert excinfo.value.status_code == 404
    assert calls["n"] == 1


# ---------------------------------------------------------------------------
# enqueue_with_defaults — per-callable job_timeout is injected.
# ---------------------------------------------------------------------------


def _named(name: str):
    """Build a stand-in callable whose ``__name__`` is ``name``."""

    def _fn(*_a, **_kw):
        return None

    _fn.__name__ = name
    return _fn


@pytest.mark.parametrize(
    "callable_name,expected_timeout",
    [
        ("run_batch_auto_annotate", 4 * 3600),
        ("run_auto_text_batch", 4 * 3600),
        ("extract_frames_for_video", 30 * 60),
        ("run_retrain_job", 24 * 3600),
        ("run_export_job", 2 * 3600),
    ],
)
def test_enqueue_with_defaults_sets_job_timeout(
    callable_name, expected_timeout, monkeypatch
):
    queue = MagicMock()
    # enqueue_with_defaults re-homes the job onto its priority lane by
    # constructing a fresh Queue(target_lane, connection=...). With a bare
    # MagicMock that reassignment would build a *real* rq.Queue and our mock's
    # .enqueue would never be called. Patch the Queue symbol so the lane
    # reassignment returns the same mock, isolating the timeout-injection logic.
    monkeypatch.setattr("carve_api.jobs.queue.Queue", lambda *a, **k: queue)
    fn = _named(callable_name)

    enqueue_with_defaults(queue, fn, "arg1", "arg2")

    queue.enqueue.assert_called_once()
    _, kwargs = queue.enqueue.call_args
    assert kwargs["job_timeout"] == expected_timeout
    assert kwargs["result_ttl"] == 86400
    assert kwargs["failure_ttl"] == 86400


def test_enqueue_with_defaults_omits_unknown_callable_timeout(monkeypatch):
    queue = MagicMock()
    monkeypatch.setattr("carve_api.jobs.queue.Queue", lambda *a, **k: queue)
    fn = _named("some_other_function")

    enqueue_with_defaults(queue, fn, 1, 2)

    _, kwargs = queue.enqueue.call_args
    assert "job_timeout" not in kwargs
    # TTLs still applied
    assert kwargs["result_ttl"] == 86400


def test_enqueue_with_defaults_caller_override_wins(monkeypatch):
    queue = MagicMock()
    monkeypatch.setattr("carve_api.jobs.queue.Queue", lambda *a, **k: queue)
    fn = _named("run_batch_auto_annotate")  # table default would be 14400

    enqueue_with_defaults(queue, fn, "p", job_timeout=99)

    _, kwargs = queue.enqueue.call_args
    assert kwargs["job_timeout"] == 99


# ---------------------------------------------------------------------------
# A failing batch job writes ``error_traceback`` to its Redis status hash.
# ---------------------------------------------------------------------------


class _RecordingRedis:
    """Minimal Redis stand-in that supports both hset forms used by batch.py.

    Real ``redis.Redis.hset`` takes either ``mapping=...`` or positional
    ``field, value``. ``run_batch_auto_annotate`` uses both, so the fake
    must too.
    """

    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, str]] = {}

    def hset(self, key, *args, mapping=None, **_kw):
        if mapping is not None:
            self.hashes.setdefault(key, {}).update(
                {str(k): str(v) for k, v in mapping.items()}
            )
            return len(mapping)
        if len(args) == 2:
            field, value = args
            self.hashes.setdefault(key, {})[str(field)] = str(value)
            return 1
        return 0

    def expire(self, key, ttl):
        return True

    def hgetall(self, key):
        return dict(self.hashes.get(key, {}))


def test_failing_batch_job_writes_error_traceback_to_redis(monkeypatch):
    """run_batch_auto_annotate should persist a traceback to the progress
    hash when the boot phase raises. We force the failure by making the
    SessionLocal factory blow up.
    """
    from carve_api.inference import batch as batch_mod
    from carve_api import db as db_mod

    def _boom_factory():
        raise RuntimeError("boot exploded for testing")

    # ``run_batch_auto_annotate`` lazy-imports ``get_session_factory`` from
    # ``carve_api.db`` inside the function body, so we patch it on the
    # source module. The worker calls the factory, then ``SessionLocal()``
    # inside ``with SessionLocal() as boot:`` — the factory itself raising
    # triggers the boot ``except Exception`` branch (where we added the
    # traceback write).
    monkeypatch.setattr(db_mod, "get_session_factory", lambda: _boom_factory)

    fake = _RecordingRedis()

    # Replace the Redis class imported lazily inside the worker so it
    # returns our recording fake instead of attempting a real connection.
    import redis as _redis_mod

    monkeypatch.setattr(_redis_mod, "Redis", lambda *a, **kw: fake)

    payload = batch_mod.BatchJobPayload(
        job_id=str(uuid.uuid4()),
        actor_id=str(uuid.uuid4()),
        task_id=str(uuid.uuid4()),
        weight_id=str(uuid.uuid4()),
        overwrite=False,
    )

    result = batch_mod.run_batch_auto_annotate(payload)
    assert result["status"] == "failed"

    key = batch_mod.progress_key(payload.job_id)
    hash_data = fake.hashes.get(key, {})
    assert "error_traceback" in hash_data, hash_data
    assert "boot exploded for testing" in hash_data["error_traceback"]
