"""YOLOE checkpoint registry.

Unlike the YOLO LRU (user-uploaded weights, keyed by weight_id), the
YOLOE registry holds at most two fixed checkpoints under stable keys:

* ``"text"`` -> ``yoloe-26l-seg.pt`` (text + visual prompts).
* ``"pf"``   -> ``yoloe-26l-seg-pf.pt`` (prompt-free).

Both are loaded lazily on first use and idle-evicted by the same
sweeper that frees SAM models. The loader factory is injectable so
unit tests can stub it without importing ultralytics.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

log = logging.getLogger(__name__)

YoloeKey = Literal["text", "pf"]


_DEFAULT_WEIGHTS_DIR = "/app/weights/yoloe"
_DEFAULT_TEXT_NAME = "yoloe-26l-seg.pt"
_DEFAULT_PF_NAME = "yoloe-26l-seg-pf.pt"

_DEFAULT_IDLE_TIMEOUT_S = 900.0  # 15 min — matches SAM predictor


@dataclass
class _Slot:
    model: Any | None = None
    last_used: float = field(default_factory=time.monotonic)


class YoloeRegistry:
    """Thread-safe holder for the two YOLOE checkpoints."""

    def __init__(
        self,
        loader: Callable[[Path], Any] | None = None,
        weights_dir: str | None = None,
        text_name: str | None = None,
        pf_name: str | None = None,
        idle_timeout_s: float | None = None,
    ) -> None:
        self._loader = loader
        self._weights_dir = Path(
            weights_dir or os.environ.get("YOLOE_WEIGHTS_DIR", _DEFAULT_WEIGHTS_DIR)
        )
        self._text_name = text_name or os.environ.get("YOLOE_TEXT_NAME", _DEFAULT_TEXT_NAME)
        self._pf_name = pf_name or os.environ.get("YOLOE_PF_NAME", _DEFAULT_PF_NAME)
        env_timeout = os.environ.get("YOLOE_IDLE_TIMEOUT_S")
        if idle_timeout_s is None and env_timeout:
            try:
                idle_timeout_s = float(env_timeout)
            except ValueError:
                idle_timeout_s = None
        self._idle_timeout_s = (
            idle_timeout_s if idle_timeout_s is not None else _DEFAULT_IDLE_TIMEOUT_S
        )
        self._slots: dict[YoloeKey, _Slot] = {"text": _Slot(), "pf": _Slot()}
        self._lock = threading.Lock()

    def set_loader(self, loader: Callable[[Path], Any]) -> None:
        self._loader = loader

    def weight_path(self, key: YoloeKey) -> Path:
        name = self._text_name if key == "text" else self._pf_name
        return self._weights_dir / name

    def is_available(self, key: YoloeKey) -> bool:
        """Whether the on-disk .pt file exists.

        Used by the /yoloe/status probe so the frontend can hide UI
        when the operator hasn't shipped the weights to the model
        container.
        """
        return self.weight_path(key).is_file()

    def is_loaded(self, key: YoloeKey) -> bool:
        with self._lock:
            return self._slots[key].model is not None

    def get(self, key: YoloeKey) -> Any:
        """Return the loaded model, loading it from disk on first call.

        Raises ``FileNotFoundError`` when the checkpoint isn't on disk
        and ``RuntimeError`` when no loader has been configured.
        """
        if self._loader is None:
            raise RuntimeError("YoloeRegistry has no loader configured")
        with self._lock:
            slot = self._slots[key]
            if slot.model is None:
                path = self.weight_path(key)
                if not path.is_file():
                    raise FileNotFoundError(f"yoloe_weight_missing: {path}")
                log.info("yoloe.load key=%s path=%s", key, path)
                slot.model = self._loader(path)
            slot.last_used = time.monotonic()
            return slot.model

    def evict_idle(self) -> list[YoloeKey]:
        """Drop checkpoints that have been idle longer than the timeout.

        Called by the global sweeper in ``main.py``. Returns the keys
        that were evicted so the sweeper can log them.
        """
        evicted: list[YoloeKey] = []
        now = time.monotonic()
        with self._lock:
            for key, slot in self._slots.items():
                if slot.model is None:
                    continue
                if now - slot.last_used >= self._idle_timeout_s:
                    slot.model = None
                    evicted.append(key)  # type: ignore[arg-type]
        for key in evicted:
            log.info("yoloe.evict_idle key=%s", key)
        return evicted

    def evict_all(self) -> list[YoloeKey]:
        """Force-drop every loaded checkpoint. Used by /yoloe/unload."""
        evicted: list[YoloeKey] = []
        with self._lock:
            for key, slot in self._slots.items():
                if slot.model is not None:
                    slot.model = None
                    evicted.append(key)  # type: ignore[arg-type]
        return evicted


def _default_loader(path: Path) -> Any:
    """Production loader. Imports ultralytics lazily so dev boxes work."""
    from ultralytics import YOLOE  # type: ignore[import-not-found]

    return YOLOE(str(path))


REGISTRY = YoloeRegistry()


def install_default_loader() -> None:
    """Wire the production Ultralytics loader. Idempotent."""
    REGISTRY.set_loader(_default_loader)
