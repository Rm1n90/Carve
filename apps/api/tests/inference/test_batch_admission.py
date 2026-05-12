"""Unit tests for the GPU-admission retry helpers in inference/batch.py.

These cover the new ``_is_admission_error`` detector and the
``_run_with_admission_retry`` backoff wrapper added so a busy GPU
doesn't kill a whole batch — instead the worker waits, retries the
same asset, and surfaces a ``waiting_for_gpu`` status to the UI.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from carve_api.errors import GpuAdmissionError
from carve_api.inference.batch import (
    _is_admission_error,
    _run_with_admission_retry,
    progress_key,
)
from carve_api.inference.model_client import ModelServiceError


# ---------------------------------------------------------------------------
# _is_admission_error
# ---------------------------------------------------------------------------


def test_is_admission_error_recognises_gpu_busy_in_payload() -> None:
    exc = GpuAdmissionError({"code": "gpu_busy", "message": "busy"})
    assert _is_admission_error(exc) is True


def test_is_admission_error_recognises_gpu_oom_risk_in_payload() -> None:
    exc = GpuAdmissionError(
        {"code": "gpu_oom_risk", "free_mb": 100, "needed_mb": 2000}
    )
    assert _is_admission_error(exc) is True


def test_is_admission_error_recognises_admission_in_model_service_body() -> None:
    """ModelServiceError(503, {"detail": {"code": "gpu_busy"}}) is admission."""
    exc = ModelServiceError(503, {"detail": {"code": "gpu_busy"}})
    assert _is_admission_error(exc) is True


def test_is_admission_error_recognises_admission_top_level_body() -> None:
    """Older shape where the code lives at the top of the body."""
    exc = ModelServiceError(503, {"code": "gpu_oom_risk", "free_mb": 10})
    assert _is_admission_error(exc) is True


def test_is_admission_error_ignores_generic_errors() -> None:
    """Random exceptions / non-admission 503s should not be retried."""
    assert _is_admission_error(ValueError("nope")) is False
    assert (
        _is_admission_error(ModelServiceError(500, {"detail": "internal_error"}))
        is False
    )
    assert (
        _is_admission_error(
            ModelServiceError(503, {"detail": "model_service_unreachable"})
        )
        is False
    )


# ---------------------------------------------------------------------------
# _run_with_admission_retry
# ---------------------------------------------------------------------------


def _fake_redis() -> tuple[MagicMock, list[tuple[str, str]]]:
    """Return a MagicMock redis client + a captured (key, status) log of
    every ``hset(key, "status", value)`` call so the test can assert on
    the status transitions the worker would publish."""
    statuses: list[tuple[str, str]] = []
    rc = MagicMock()

    def _hset(key: str, *args, **kwargs) -> None:
        # The worker uses hset(key, "status", value)
        if len(args) == 2 and args[0] == "status":
            statuses.append((key, str(args[1])))
        elif "status" in kwargs:
            statuses.append((key, str(kwargs["status"])))

    rc.hset.side_effect = _hset
    return rc, statuses


def test_admission_retry_returns_immediately_on_success() -> None:
    """Happy path: fn returns first try → no retry, no status writes."""
    rc, statuses = _fake_redis()
    calls = {"n": 0}

    def fn() -> dict[str, Any]:
        calls["n"] += 1
        return {"ok": True}

    out = _run_with_admission_retry(
        fn,
        redis_client=rc,
        job_id="job-1",
        asset_label="asset-1",
    )
    assert out == {"ok": True}
    assert calls["n"] == 1
    assert statuses == []  # no status transitions when nothing waited


def test_admission_retry_recovers_after_one_busy(monkeypatch: pytest.MonkeyPatch) -> None:
    """One ``gpu_busy`` then success → returns the success value and
    publishes waiting_for_gpu then running."""
    # Skip the real sleep so the test runs instantly.
    monkeypatch.setattr("time.sleep", lambda _s: None)

    rc, statuses = _fake_redis()
    calls = {"n": 0}

    def fn() -> dict[str, Any]:
        calls["n"] += 1
        if calls["n"] == 1:
            raise GpuAdmissionError({"code": "gpu_busy", "message": "busy"})
        return {"ok": True, "asset": "a1"}

    out = _run_with_admission_retry(
        fn,
        redis_client=rc,
        job_id="job-x",
        asset_label="asset-1",
        max_attempts=3,
        base_delay_s=0.001,
        max_delay_s=0.01,
    )
    assert out == {"ok": True, "asset": "a1"}
    assert calls["n"] == 2
    job_key = progress_key("job-x")
    assert (job_key, "waiting_for_gpu") in statuses
    assert (job_key, "running") in statuses


def test_admission_retry_gives_up_after_max_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If every attempt raises gpu_busy, the last exception bubbles up
    so the caller can record a per-asset failure normally."""
    monkeypatch.setattr("time.sleep", lambda _s: None)

    rc, statuses = _fake_redis()
    calls = {"n": 0}

    def fn() -> None:
        calls["n"] += 1
        raise GpuAdmissionError({"code": "gpu_busy", "message": "still busy"})

    with pytest.raises(GpuAdmissionError):
        _run_with_admission_retry(
            fn,
            redis_client=rc,
            job_id="job-z",
            asset_label="asset-Z",
            max_attempts=4,
            base_delay_s=0.001,
            max_delay_s=0.01,
        )
    assert calls["n"] == 4
    assert any(status == "waiting_for_gpu" for _key, status in statuses)


def test_admission_retry_propagates_non_admission_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Non-admission errors propagate immediately with no retry."""
    monkeypatch.setattr("time.sleep", lambda _s: None)

    rc, _statuses = _fake_redis()
    calls = {"n": 0}

    def fn() -> None:
        calls["n"] += 1
        raise ModelServiceError(500, {"detail": "internal_error"})

    with pytest.raises(ModelServiceError):
        _run_with_admission_retry(
            fn,
            redis_client=rc,
            job_id="job-q",
            asset_label="asset-Q",
            max_attempts=5,
            base_delay_s=0.001,
        )
    assert calls["n"] == 1


def test_admission_retry_tolerates_none_redis_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Workers that lost their Redis connection still retry; status
    writes are best-effort and must not crash the wrapper."""
    monkeypatch.setattr("time.sleep", lambda _s: None)
    calls = {"n": 0}

    def fn() -> str:
        calls["n"] += 1
        if calls["n"] == 1:
            raise GpuAdmissionError({"code": "gpu_busy"})
        return "ok"

    out = _run_with_admission_retry(
        fn,
        redis_client=None,
        job_id="job-no-redis",
        asset_label="asset-NR",
        base_delay_s=0.001,
        max_delay_s=0.01,
    )
    assert out == "ok"
