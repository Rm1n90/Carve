"""GPU admission control to prevent OOM and oversubscription.

Every GPU-touching endpoint wraps its critical section in ``admit()``.
The gate:
  - Computes the relevant CUDA device for the request (via
    ``carve_model.devices.get_device``).
  - Probes free VRAM via ``cuda.mem_get_info`` (carve_model.devices
    .vram_free_mb).
  - Compares against the request's cost class floor.
  - Acquires a global semaphore (default 1 slot — configurable via
    ``MODEL_INFERENCE_SLOTS``). One GPU-heavy inference at a time
    prevents a second user from racing the first on the same
    predictor and OOMing the device.

On admission failure, raises ``HTTPException(503, detail=<dict>)`` with
a structured body the api layer parses into a typed error so the
frontend can surface a friendly toast:

  {"error": "gpu_oom_risk", "code": "gpu_oom_risk",
   "cost_class": "yoloe_pf", "free_mb": 1200, "needed_mb": 2500,
   "message": "Not enough GPU memory: ..."}

  {"error": "gpu_busy", "code": "gpu_busy",
   "cost_class": "sam_text",
   "message": "GPU is busy with another inference job. ..."}
"""
from __future__ import annotations

import enum
import logging
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
# every GPU-heavy job. Raise via env in operator-tuned deployments.
_SLOTS = threading.Semaphore(_slot_count())


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
    Headroom check happens BEFORE the semaphore so a hopeless request
    fails fast without blocking the queue. Semaphore is non-blocking
    by default — a busy GPU returns 503 immediately so the UI can
    surface a clear toast.
    """
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

    if not _SLOTS.acquire(blocking=False):
        raise HTTPException(
            status_code=503,
            detail={
                "error": "gpu_busy",
                "code": "gpu_busy",
                "cost_class": cost.value,
                "message": (
                    "GPU is currently busy with another inference job. "
                    "Try again in a moment."
                ),
            },
        )
    try:
        yield
    finally:
        _SLOTS.release()
