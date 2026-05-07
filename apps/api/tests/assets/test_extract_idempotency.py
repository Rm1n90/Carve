# Armin Mehri — mehri.armin@gmail.com
"""POST /assets/{id}/frames/extract idempotency helper.

The pre-enqueue check must:
  - return the existing job_id when an alive RQ job is recorded under
    ``frame-extract:{asset_id}:status==running``;
  - clear the stale key when the recorded job_id no longer exists in
    RQ (worker died) and let the caller proceed to enqueue a new one;
  - return None when there is no running marker at all.

Tested at the helper level so we don't need a live Postgres.
"""
from unittest.mock import MagicMock, patch

import pytest

from carve_api.assets.extract_guard import check_extract_idempotency


def _fake_redis_with(mapping: dict | None) -> MagicMock:
    fake = MagicMock()
    fake.hgetall.return_value = mapping or {}
    return fake


@pytest.mark.unit
def test_returns_none_when_no_running_marker():
    fake = _fake_redis_with(None)
    with patch("rq.job.Job.fetch") as fake_fetch:
        result = check_extract_idempotency(fake, "asset-1")
    assert result is None
    fake_fetch.assert_not_called()
    fake.delete.assert_not_called()


@pytest.mark.unit
def test_returns_none_when_status_completed():
    fake = _fake_redis_with({"status": "completed", "job_id": "old"})
    result = check_extract_idempotency(fake, "asset-1")
    assert result is None


@pytest.mark.unit
def test_returns_existing_job_id_when_alive():
    fake = _fake_redis_with({"status": "running", "job_id": "alive-job"})
    with patch("rq.job.Job.fetch", return_value=MagicMock()):
        result = check_extract_idempotency(fake, "asset-1")
    assert result == "alive-job"
    fake.delete.assert_not_called()


@pytest.mark.unit
def test_clears_stale_key_when_job_dead():
    from rq.exceptions import NoSuchJobError

    fake = _fake_redis_with({"status": "running", "job_id": "ghost-job"})
    with patch("rq.job.Job.fetch", side_effect=NoSuchJobError):
        result = check_extract_idempotency(fake, "asset-1")
    assert result is None
    fake.delete.assert_called_once_with("frame-extract:asset-1")


@pytest.mark.unit
def test_clears_stale_key_when_status_running_but_no_job_id():
    fake = _fake_redis_with({"status": "running"})
    result = check_extract_idempotency(fake, "asset-1")
    assert result is None
    fake.delete.assert_called_once_with("frame-extract:asset-1")
