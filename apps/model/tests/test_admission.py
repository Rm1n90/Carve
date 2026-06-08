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
    _admission_wait_s,
    admit,
)


def test_admission_wait_parsing(monkeypatch) -> None:
    """The wait timeout falls back to 60s for anything that would weaken
    or disable the safety valve: <=0, non-finite (inf/nan), unparseable.
    A valid positive value passes through."""
    monkeypatch.setenv("MODEL_INFERENCE_WAIT_S", "30")
    assert _admission_wait_s() == 30.0
    for bad in ("0", "-5", "inf", "-inf", "nan", "notanumber"):
        monkeypatch.setenv("MODEL_INFERENCE_WAIT_S", bad)
        assert _admission_wait_s() == 60.0, bad
    monkeypatch.delenv("MODEL_INFERENCE_WAIT_S", raising=False)
    assert _admission_wait_s() == 60.0


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


def test_admit_queues_when_slot_busy_then_proceeds() -> None:
    """Multi-user fix: a concurrent caller QUEUES on the slot instead of
    being rejected. It blocks while the first holds the slot, then runs
    once the slot is released — so two users sharing one GPU never see a
    spurious ``gpu_busy``. This is the CVAT-style behaviour Armin asked
    for ("even 10 ppl can use a loaded SAM3.1 ... without get failed").
    """
    holder_in = threading.Event()
    holder_release = threading.Event()
    second_ran = threading.Event()

    def holder() -> None:
        with patch("carve_model.admission._free_mb", return_value=24_000):
            with admit(CostClass.SAM_IMAGE):
                holder_in.set()
                holder_release.wait(timeout=5)

    def second() -> None:
        holder_in.wait(timeout=2)
        with patch("carve_model.admission._free_mb", return_value=24_000):
            with admit(CostClass.SAM_TEXT):
                second_ran.set()

    th = threading.Thread(target=holder, daemon=True)
    ts = threading.Thread(target=second, daemon=True)
    th.start()
    assert holder_in.wait(timeout=2), "holder did not enter admit"
    ts.start()
    # While the holder still owns the slot, the second caller must NOT
    # have run — it is queued (blocked), not rejected.
    assert not second_ran.wait(timeout=0.5), (
        "second caller ran while the slot was held — expected it to queue"
    )
    # Release the holder; the queued caller now proceeds on its own.
    holder_release.set()
    assert second_ran.wait(timeout=3), (
        "second caller did not run after the slot was released"
    )
    th.join(timeout=2)
    ts.join(timeout=2)


def test_admit_times_out_to_gpu_busy_when_slot_stuck(monkeypatch) -> None:
    """Safety valve: if the slot never frees (a hung/crashed inference),
    a waiter gives up after ``MODEL_INFERENCE_WAIT_S`` with 503 gpu_busy
    rather than blocking forever."""
    monkeypatch.setenv("MODEL_INFERENCE_WAIT_S", "0.2")
    holder_in = threading.Event()
    holder_release = threading.Event()
    holder_exit = threading.Event()

    def holder() -> None:
        with patch("carve_model.admission._free_mb", return_value=24_000):
            with admit(CostClass.SAM_IMAGE):
                holder_in.set()
                holder_release.wait(timeout=5)
        holder_exit.set()

    t = threading.Thread(target=holder, daemon=True)
    t.start()
    assert holder_in.wait(timeout=2), "holder did not enter admit"

    try:
        with patch("carve_model.admission._free_mb", return_value=24_000):
            with pytest.raises(HTTPException) as exc_info:
                with admit(CostClass.SAM_TEXT):
                    pytest.fail("must not run while the slot is stuck")
        e = exc_info.value
        assert e.status_code == 503
        assert isinstance(e.detail, dict)
        assert e.detail["code"] == "gpu_busy"
        assert e.detail["cost_class"] == CostClass.SAM_TEXT.value
        assert "busy" in e.detail["message"].lower()
    finally:
        holder_release.set()
        assert holder_exit.wait(timeout=2)


def test_admit_oom_check_runs_after_acquiring_slot() -> None:
    """The VRAM floor check happens while holding the slot, and the slot
    is released even when the OOM rejection fires — so a subsequent admit
    can still acquire it. Guards the acquire-then-check ordering."""
    needed = COST_FLOORS_MB[CostClass.SAM_TEXT]
    with patch("carve_model.admission._free_mb", return_value=needed - 50):
        with pytest.raises(HTTPException) as exc_info:
            with admit(CostClass.SAM_TEXT):
                pytest.fail("body must not run when headroom is insufficient")
        assert exc_info.value.detail["code"] == "gpu_oom_risk"
    # Slot was released despite the OOM rejection — this admit succeeds.
    with patch("carve_model.admission._free_mb", return_value=24_000):
        with admit(CostClass.SAM_TEXT):
            pass


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
