"""Unit tests for the GPU admission gate (``carve_model.admission``).

The model service is the single chokepoint for GPU work. These tests
verify the gate's three core behaviours:

  1. Happy path — when free VRAM exceeds the cost class floor and the
     semaphore has a free slot, ``admit()`` lets the caller run.
  2. Busy slot — a concurrent caller is rejected with a structured 503
     ``gpu_busy`` body so the api can surface a clear "GPU is busy"
     toast instead of a generic 5xx.
  3. OOM risk — when free VRAM is below the cost class floor, the
     gate rejects with ``gpu_oom_risk`` and includes ``free_mb`` /
     ``needed_mb`` so the UI can show the user the deficit.
"""
from __future__ import annotations

import threading
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from carve_model.admission import (
    COST_FLOORS_MB,
    CostClass,
    _SLOTS,
    admit,
)


def _drain_semaphore() -> int:
    """Acquire every available slot. Returns the count drained."""
    drained = 0
    while _SLOTS.acquire(blocking=False):
        drained += 1
    return drained


def _refill_semaphore(count: int) -> None:
    for _ in range(count):
        _SLOTS.release()


@pytest.fixture(autouse=True)
def reset_semaphore():
    """Each test starts and ends with the semaphore fully replenished."""
    pre = _drain_semaphore()
    _refill_semaphore(pre)
    yield
    post = _drain_semaphore()
    _refill_semaphore(post)


def test_admit_succeeds_when_headroom_and_slot_available() -> None:
    """Enough free VRAM + slot available → admit() runs the body."""
    with patch("carve_model.admission._free_mb", return_value=24_000):
        ran = False
        with admit(CostClass.SAM_TEXT):
            ran = True
        assert ran is True


def test_admit_rejects_when_free_vram_below_floor() -> None:
    """Free VRAM below the cost class floor → 503 gpu_oom_risk with payload."""
    needed = COST_FLOORS_MB[CostClass.YOLOE_PF]
    with patch("carve_model.admission._free_mb", return_value=needed - 100):
        with pytest.raises(HTTPException) as exc_info:
            with admit(CostClass.YOLOE_PF):
                pytest.fail("body should not run when admission rejects")
        e = exc_info.value
        assert e.status_code == 503
        assert isinstance(e.detail, dict)
        assert e.detail["code"] == "gpu_oom_risk"
        assert e.detail["cost_class"] == CostClass.YOLOE_PF.value
        assert e.detail["needed_mb"] == needed
        assert e.detail["free_mb"] == needed - 100
        assert "GPU memory" in e.detail["message"]


def test_admit_rejects_when_slot_busy() -> None:
    """Concurrent admit → second caller gets 503 gpu_busy fast."""
    holder_started = threading.Event()
    holder_release = threading.Event()
    holder_exit = threading.Event()

    def holder() -> None:
        with patch("carve_model.admission._free_mb", return_value=24_000):
            with admit(CostClass.SAM_IMAGE):
                holder_started.set()
                holder_release.wait(timeout=5)
        holder_exit.set()

    t = threading.Thread(target=holder, daemon=True)
    t.start()
    assert holder_started.wait(timeout=2), "holder did not enter admit"

    try:
        with patch("carve_model.admission._free_mb", return_value=24_000):
            with pytest.raises(HTTPException) as exc_info:
                with admit(CostClass.SAM_TEXT):
                    pytest.fail("second admit must not run while slot is held")
        e = exc_info.value
        assert e.status_code == 503
        assert isinstance(e.detail, dict)
        assert e.detail["code"] == "gpu_busy"
        assert e.detail["cost_class"] == CostClass.SAM_TEXT.value
        assert "busy" in e.detail["message"].lower()
    finally:
        holder_release.set()
        assert holder_exit.wait(timeout=2)


def test_admit_releases_slot_on_success() -> None:
    """After a happy-path admit, the slot must be available again."""
    with patch("carve_model.admission._free_mb", return_value=24_000):
        with admit(CostClass.SAM_IMAGE):
            pass
        with admit(CostClass.SAM_IMAGE):
            pass


def test_admit_releases_slot_on_exception() -> None:
    """Body raising must still release the slot."""

    class BodyError(Exception):
        pass

    with patch("carve_model.admission._free_mb", return_value=24_000):
        with pytest.raises(BodyError):
            with admit(CostClass.SAM_IMAGE):
                raise BodyError("simulated body failure")
        with admit(CostClass.SAM_IMAGE):
            pass


def test_admit_skips_oom_check_when_not_on_cuda() -> None:
    """When _free_mb returns -1 (CPU/MPS), the OOM check is skipped."""
    with patch("carve_model.admission._free_mb", return_value=-1):
        with admit(CostClass.YOLO):
            pass


def test_admit_payload_carries_all_required_fields() -> None:
    """OOM rejection body must include every field the api/frontend rely on."""
    with patch("carve_model.admission._free_mb", return_value=10):
        with pytest.raises(HTTPException) as exc_info:
            with admit(CostClass.SAM_VISUAL):
                pass
        detail = exc_info.value.detail
        for key in ("error", "code", "cost_class", "free_mb", "needed_mb", "message"):
            assert key in detail, f"missing {key} in admission payload"
        assert detail["error"] == "gpu_oom_risk"
