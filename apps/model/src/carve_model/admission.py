"""GPU admission control to prevent OOM and oversubscription.

Every GPU-touching endpoint wraps its critical section in ``admit()``.
The gate:
  - Computes the relevant CUDA device for the request (via
    ``carve_model.devices.get_device``).
  - Probes free VRAM via ``cuda.mem_get_info`` (carve_model.devices
    .vram_free_mb).
  - Compares against the request's cost class floor.
  - Acquires a global semaphore (default 1 slot — configurable via
    ``MODEL_INFERENCE_SLOTS``) so GPU-heavy jobs run one at a time.
    Concurrent callers QUEUE on the slot (blocking up to
    ``MODEL_INFERENCE_WAIT_S``) instead of being rejected, so many
    users share one resident model on one GPU the way CVAT does — the
    second user's SAM click waits a beat for the first to finish rather
    than failing with "GPU is busy".

On admission failure, raises ``HTTPException(503, detail=<dict>)`` with
a structured body the api layer parses into a typed error so the
frontend can surface a friendly toast:

  {"error": "gpu_oom_risk", "code": "gpu_oom_risk",
   "cost_class": "yoloe_pf", "free_mb": 1200, "needed_mb": 2500,
   "message": "Not enough GPU memory: ..."}

  {"error": "gpu_busy", "code": "gpu_busy",
   "cost_class": "sam_text",
   "message": "GPU is still busy after waiting ..."}

``gpu_busy`` is now only raised as a safety valve: a waiter gives up
after ``MODEL_INFERENCE_WAIT_S`` so a hung/crashed inference can't block
every other user forever. Under normal multi-user load nobody ever sees
it — they just queue for the sub-second it takes the in-flight job to
finish.
"""
from __future__ import annotations

import enum
import logging
import math
import os
import threading
from contextlib import contextmanager
from typing import Iterator

from fastapi import HTTPException

log = logging.getLogger(__name__)


class CostClass(enum.Enum):
    SAM_IMAGE = "sam_image"  # encode + point-decode
    SAM_TEXT = "sam_text"
    SAM_VISUAL = "sam_visual"
    SAM_BOX = "sam_box"
    SAM_TRACK = "sam_track"
    YOLO = "yolo"
    YOLOE_TEXT = "yoloe_text"
    YOLOE_VISUAL = "yoloe_visual"
    YOLOE_PF = "yoloe_pf"


# Conservative MIN_FREE floors, in MB. The intent is to leave enough
# headroom for the cost class to allocate without OOMing. Numbers
# tuned from observed peak deltas on 3090-class hardware; raise via
# operator override (env-driven extension in a later iteration) if a
# specific path keeps OOMing.
COST_FLOORS_MB: dict[CostClass, int] = {
    CostClass.SAM_IMAGE: 1500,
    CostClass.SAM_TEXT: 3000,
    CostClass.SAM_VISUAL: 3000,
    CostClass.SAM_BOX: 2000,
    CostClass.SAM_TRACK: 4000,
    CostClass.YOLO: 800,
    CostClass.YOLOE_TEXT: 2000,
    CostClass.YOLOE_VISUAL: 2500,
    CostClass.YOLOE_PF: 2500,
}


def _slot_count() -> int:
    raw = os.environ.get("MODEL_INFERENCE_SLOTS", "1")
    try:
        return max(1, int(raw))
    except ValueError:
        return 1


# Single global semaphore. Default 1 slot — strict serialization of
# every GPU-heavy job. Concurrent callers QUEUE on it (see admit) rather
# than being rejected, so N users share one resident model on one GPU.
# Raise the slot count via env in roomy / multi-GPU deployments.
_SLOTS = threading.Semaphore(_slot_count())


def _admission_wait_s() -> float:
    """Max seconds to wait for a free GPU slot before giving up.

    Concurrent inference is serialized through ``_SLOTS``; a second
    caller blocks here until the in-flight job releases the slot —
    typically sub-second for an interactive SAM click. The timeout is
    only a safety valve so a hung/crashed inference can't block every
    other user forever: on expiry ``admit`` raises ``gpu_busy`` (the same
    503 the gate used to return immediately). Tune via
    ``MODEL_INFERENCE_WAIT_S`` (default 60s); values ``<= 0``,
    non-finite (``inf``/``nan``), or unparseable fall back to the
    default so the safety valve can never be accidentally disabled.
    """
    raw = os.environ.get("MODEL_INFERENCE_WAIT_S", "60")
    try:
        v = float(raw)
    except ValueError:
        return 60.0
    if not math.isfinite(v) or v <= 0:
        return 60.0
    return v


def _free_mb() -> int:
    """Return free VRAM in MB on the active CUDA device, or -1 if not on CUDA."""
    try:
        from carve_model.devices import get_device, vram_free_mb
    except ImportError:
        return -1
    try:
        device = get_device()
    except Exception:  # noqa: BLE001
        return -1
    if not device.startswith("cuda"):
        return -1  # CPU / MPS — no GPU gating needed
    try:
        return vram_free_mb(device)
    except Exception as exc:  # noqa: BLE001
        log.warning("admission free_mb probe failed: %s", exc)
        return -1


@contextmanager
def admit(cost: CostClass) -> Iterator[None]:
    """Admit a GPU-touching critical section, or raise HTTPException(503).

    Use as ``with admit(CostClass.X): ...`` around the model call.

    Concurrency model (CVAT-style): every GPU-heavy job acquires the
    single global slot, so concurrent callers SERIALIZE — the second
    user's SAM click WAITS for the first to finish instead of being
    rejected. This is the multi-user fix: one resident model on one GPU
    serves many users without ever failing a request just because
    another was in flight. Only a genuinely stuck slot (a hung/crashed
    inference) times out after ``MODEL_INFERENCE_WAIT_S`` → ``gpu_busy``.

    Ordering / deadlock note: the slot is acquired BEFORE the SAM
    lifecycle manager's inference lock in every SAM endpoint
    (admit-outer), so no thread ever holds that lock while waiting on
    this semaphore — there is no ABBA deadlock between the two.

    The VRAM headroom check runs AFTER the slot is acquired: holding the
    slot we are the only admission-gated GPU job, so ``free_mb`` reflects
    true headroom rather than a value transiently depressed by a
    concurrent inference (which, when the check ran first, could fail the
    next user with a spurious ``gpu_oom_risk``).
    """
    if not _SLOTS.acquire(timeout=_admission_wait_s()):
        raise HTTPException(
            status_code=503,
            detail={
                "error": "gpu_busy",
                "code": "gpu_busy",
                "cost_class": cost.value,
                "message": (
                    "GPU is still busy after waiting for the current "
                    "inference job to finish. Try again in a moment."
                ),
            },
        )
    try:
        free_mb = _free_mb()
        needed_mb = COST_FLOORS_MB.get(cost, 1500)
        if free_mb >= 0 and free_mb < needed_mb:
            raise HTTPException(
                status_code=503,
                detail={
                    "error": "gpu_oom_risk",
                    "code": "gpu_oom_risk",
                    "cost_class": cost.value,
                    "free_mb": free_mb,
                    "needed_mb": needed_mb,
                    "message": (
                        f"Not enough GPU memory for {cost.value}: need "
                        f"~{needed_mb} MB, only {free_mb} MB free. Try "
                        "again after the current job finishes, or unload "
                        "other models from the System page."
                    ),
                },
            )
        yield
    finally:
        _SLOTS.release()
