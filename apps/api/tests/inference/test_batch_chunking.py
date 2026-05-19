# Armin Mehri — mehri.armin@gmail.com
"""Resumable chunked-batch primitives (no DB / no real Redis).

Regression guard for the fix to the failure that lost ~2/3 of a
3600-image SAM auto-annotate batch: every ``run_*_batch`` used to
process the whole dataset in one RQ execution under a fixed
``job_timeout`` and was reaped mid-run. The batch is now a *chain* of
bounded, resumable windows. These tests pin the window/cursor/cancel
semantics that make that work, using an in-memory fake Redis hash so
they need neither Postgres nor a live Redis.
"""

from __future__ import annotations

import carve_api.inference.batch as b
import carve_api.jobs.queue as q


class FakeRedis:
    """Minimal hash-only fake covering exactly what the primitives use.

    Tracks ``expire`` calls so the TTL-refresh regression (a 100K batch
    must never let its resume cursor expire mid-run) is testable.
    """

    def __init__(self) -> None:
        self.h: dict[str, dict[str, str]] = {}
        self.ttl: dict[str, int] = {}
        self.expire_calls: dict[str, int] = {}

    def hset(self, k, f=None, v=None, mapping=None):
        d = self.h.setdefault(k, {})
        if mapping:
            for kk, vv in mapping.items():
                d[kk] = str(vv)
        else:
            d[f] = str(v)

    def hget(self, k, f):
        return self.h.get(k, {}).get(f)

    def hgetall(self, k):
        return dict(self.h.get(k, {}))

    def expire(self, k, ttl):
        self.ttl[k] = ttl
        self.expire_calls[k] = self.expire_calls.get(k, 0) + 1


def _payload(job_id="job-1"):
    return type("P", (), {"job_id": job_id})()


def test_first_chunk_inits_and_windows_from_zero():
    r = FakeRedis()
    plan = b.begin_chunk(r, "j", total=3600, kind="sam-auto-text", window=200)
    assert plan.first is True
    assert plan.canceled is False
    assert plan.cursor == 0
    assert plan.window_end == 200
    # init_progress ran (status=running, total seeded) + cursor=0.
    assert r.h["aa:job:j"]["status"] == "running"
    assert r.h["aa:job:j"]["total"] == "3600"
    assert b.read_cursor(r, "j") == 0


def test_finish_chunk_continues_and_persists_cursor(monkeypatch):
    r = FakeRedis()
    b.begin_chunk(r, "j", total=3600, kind="sam-auto-text", window=200)
    seen: list[int] = []
    monkeypatch.setattr(
        q,
        "enqueue_batch_continuation",
        lambda fn, pl, *, chunk_index: seen.append(chunk_index),
    )
    status = b.finish_chunk(
        r, "j", processed=200, total=3600, failed=0,
        canceled=False, runner=lambda: None, payload=_payload(),
    )
    assert status == "continued"
    assert seen == [200]                      # next window enqueued
    assert b.read_cursor(r, "j") == 200       # resume point persisted
    # NOT finalized — the logical batch stays "running" across the chain.
    assert r.h["aa:job:j"]["status"] == "running"


def test_continuation_chunk_resumes_without_reinit():
    r = FakeRedis()
    b.begin_chunk(r, "j", total=3600, kind="sam-auto-text", window=200)
    b.write_cursor(r, "j", 200)
    # Pretend the prior chunk accumulated some progress.
    r.hset("aa:job:j", mapping={"done": "200", "failed": "3"})
    plan = b.begin_chunk(r, "j", total=3600, kind="sam-auto-text", window=200)
    assert plan.first is False
    assert plan.cursor == 200
    assert plan.window_end == 400
    # done/failed must be preserved (no init_progress on continuation).
    assert r.h["aa:job:j"]["done"] == "200"
    assert r.h["aa:job:j"]["failed"] == "3"


def test_last_window_completes_without_continuation(monkeypatch):
    r = FakeRedis()
    b.begin_chunk(r, "j", total=400, kind="sam-auto-text", window=200)
    seen: list[int] = []
    monkeypatch.setattr(
        q, "enqueue_batch_continuation",
        lambda fn, pl, *, chunk_index: seen.append(chunk_index),
    )
    status = b.finish_chunk(
        r, "j", processed=400, total=400, failed=2,
        canceled=False, runner=lambda: None, payload=_payload(),
    )
    assert status == "completed_with_errors"
    assert seen == []                                  # no re-enqueue
    assert r.h["aa:job:j"]["status"] == "completed_with_errors"


def test_clean_completion_status(monkeypatch):
    r = FakeRedis()
    b.begin_chunk(r, "j", total=10, kind="yolo-predict-batch", window=200)
    monkeypatch.setattr(
        q, "enqueue_batch_continuation",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not enqueue")),
    )
    status = b.finish_chunk(
        r, "j", processed=10, total=10, failed=0,
        canceled=False, runner=lambda: None, payload=_payload(),
    )
    assert status == "completed"
    assert r.h["aa:job:j"]["status"] == "completed"


def test_pre_init_cancel_race_is_honored(monkeypatch):
    """User cancels while the job is still queued: status is already
    'canceled' in the hash. begin_chunk must NOT init over it, and no
    continuation may be enqueued."""
    r = FakeRedis()
    r.hset("aa:job:cj", mapping={"status": "canceled"})
    plan = b.begin_chunk(r, "cj", total=50, kind="sam-auto-text")
    assert plan.canceled is True
    monkeypatch.setattr(
        q, "enqueue_batch_continuation",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("no continuation")),
    )
    status = b.finish_chunk(
        r, "cj", processed=0, total=50, failed=0,
        canceled=True, runner=lambda: None, payload=_payload("cj"),
    )
    assert status == "canceled"
    assert r.h["aa:job:cj"]["status"] == "canceled"


def test_cancel_mid_batch_finalizes_and_stops_chain(monkeypatch):
    r = FakeRedis()
    b.begin_chunk(r, "j", total=3600, kind="sam-auto-text", window=200)
    monkeypatch.setattr(
        q, "enqueue_batch_continuation",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("no continuation")),
    )
    status = b.finish_chunk(
        r, "j", processed=137, total=3600, failed=1,
        canceled=True, runner=lambda: None, payload=_payload(),
    )
    assert status == "canceled"
    assert r.h["aa:job:j"]["status"] == "canceled"


def test_read_cursor_absent_is_none_then_int():
    r = FakeRedis()
    assert b.read_cursor(r, "missing") is None
    b.write_cursor(r, "missing", 42)
    assert b.read_cursor(r, "missing") == 42


def test_per_callable_timeouts_are_per_chunk_watchdogs():
    # No batch kind may fall back to RQ's tiny default; all are the
    # generous 4h per-chunk watchdog (dataset size is irrelevant now).
    for fn in (
        "run_batch_auto_annotate",
        "run_auto_text_batch",
        "run_auto_visual_batch",
        "run_yoloe_batch",
    ):
        assert q._JOB_TIMEOUTS[fn] == 4 * 3600


def test_enqueue_helpers_attach_retry_and_job_ids(monkeypatch):
    captured: list[dict] = []

    def fake_enqueue_with_defaults(queue, fn, *args, **kwargs):
        captured.append(kwargs)
        return object()

    monkeypatch.setattr(q, "enqueue_with_defaults", fake_enqueue_with_defaults)
    pl = _payload("batch-9")

    q.enqueue_batch_job(lambda: None, pl, connection=object())
    q.enqueue_batch_continuation(lambda: None, pl, chunk_index=200)

    first, cont = captured
    # chunk 0 pins the RQ id to the progress key (cancel/poll stable).
    assert first["job_id"] == "batch-9"
    # continuation gets a distinct id (RQ refuses a reused finished id).
    assert cont["job_id"] == "batch-9::c200"
    # both carry an RQ Retry so a killed chunk is requeued + resumes.
    from rq import Retry

    assert isinstance(first["retry"], Retry)
    assert isinstance(cont["retry"], Retry)
    assert first["retry"].max == q.BATCH_CHUNK_RETRY_MAX


def test_ttl_is_refreshed_on_every_per_asset_write():
    """The hard 24h-wall regression: a multi-day 100K batch must keep
    its resume cursor alive. Every per-asset write must push the TTL."""
    r = FakeRedis()
    b.begin_chunk(r, "j", total=100_000, kind="sam-auto-text", window=200)
    key = "aa:job:j"
    # init_progress + write_cursor(0) on the first chunk already set it.
    assert r.ttl[key] == b._PROGRESS_TTL_SECONDS
    before = r.expire_calls[key]

    b.write_cursor(r, "j", 12_345)
    b.update_progress(
        r, "j", done=12_345, failed=0, errors=[],
        total_annotations_created=1, total_skipped_detections=0,
        skipped_by_class={},
    )
    b._set_progress_status(r, "j", "running")
    b.finalize_progress(r, "j", status="completed")

    # Each of the four per-asset/terminal writes refreshed the TTL.
    assert r.expire_calls[key] == before + 4
    assert r.ttl[key] == b._PROGRESS_TTL_SECONDS


def test_continuation_does_not_let_cursor_expire():
    """Simulate many continuation chunks: the key's TTL must keep being
    pushed forward, never decaying to expiry."""
    r = FakeRedis()
    b.begin_chunk(r, "j", total=100_000, kind="sam-auto-text", window=200)
    for cursor in range(0, 100_000, 200):
        b.write_cursor(r, "j", cursor)
    # Still a full fresh window after the last write — never expired.
    assert r.ttl["aa:job:j"] == b._PROGRESS_TTL_SECONDS
    assert r.expire_calls["aa:job:j"] >= 500  # one per chunk + inits


def test_asset_ordering_has_deterministic_tiebreaker():
    """Chunk windowing resumes by integer cursor across separate worker
    processes, so the asset order must be byte-identical every chunk.
    Guard the ``Asset.id`` tiebreaker against accidental removal."""
    import inspect

    for fn in (b.list_assets_for_task, b._list_assets_for_task):
        src = inspect.getsource(fn)
        assert "Asset.created_at, Asset.id" in src, (
            f"{fn.__name__} lost its deterministic order tiebreaker — "
            "chunked resume would skip/double assets under created_at ties"
        )
