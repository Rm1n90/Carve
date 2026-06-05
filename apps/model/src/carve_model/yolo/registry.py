"""LRU cache of loaded YOLO weights.

The registry doesn't import Ultralytics directly — callers pass a factory
function (typically ``YOLO`` from ``ultralytics``) so the registry stays
testable on a dev box without Ultralytics installed.
"""

import threading
from collections import OrderedDict
from collections.abc import Callable
from pathlib import Path
from typing import Any


class WeightRegistry:
    """Thread-safe LRU of loaded model objects keyed by weight_id."""

    def __init__(
        self,
        capacity: int = 2,
        loader: Callable[[Path], Any] | None = None,
    ) -> None:
        self._capacity = capacity
        self._loader = loader
        self._cache: OrderedDict[str, Any] = OrderedDict()
        self._lock = threading.Lock()

    def set_loader(self, loader: Callable[[Path], Any]) -> None:
        """Set the loader factory after construction (for global REGISTRY init)."""
        self._loader = loader

    def load(self, key: str, weights_path: Path) -> Any:
        if self._loader is None:
            raise RuntimeError("WeightRegistry has no loader configured")
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
            model = self._loader(weights_path)
            self._cache[key] = model
            while len(self._cache) > self._capacity:
                self._cache.popitem(last=False)
            return model

    def get(self, key: str) -> Any | None:
        with self._lock:
            return self._cache.get(key)

    def evict(self, key: str) -> bool:
        with self._lock:
            return self._cache.pop(key, None) is not None

    def evict_all(self) -> list[str]:
        """Drop every loaded checkpoint. Returns the evicted keys.

        Used by the System page's "Free memory" reclaim so YOLO weights
        don't sit pinned in RAM/VRAM after the operator asks to clear
        memory. Mirrors ``YoloeRegistry.evict_all``. Idempotent.
        """
        with self._lock:
            keys = list(self._cache.keys())
            self._cache.clear()
            return keys

    def __len__(self) -> int:
        with self._lock:
            return len(self._cache)


def _default_loader(weights_path: Path) -> Any:
    """Default loader for production. Imports ultralytics lazily."""
    from ultralytics import YOLO  # type: ignore[import-not-found]
    return YOLO(str(weights_path))


# Global registry; loader is set lazily so tests can override before first use.
REGISTRY = WeightRegistry(capacity=2)


def install_default_loader() -> None:
    """Set the production Ultralytics loader. Idempotent."""
    REGISTRY.set_loader(_default_loader)
