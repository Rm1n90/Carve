"""GPU detection helpers for the model service.

We import torch lazily inside each function so the module is importable on a
CPU-only dev box where torch is not installed. ``get_device()`` falls back to
"cpu" cleanly when CUDA (or torch itself) is unavailable.
"""

from typing import Literal

DeviceName = Literal["cuda:0", "cpu"]


def get_device() -> DeviceName:
    try:
        import torch  # type: ignore[import-not-found]
    except ImportError:
        return "cpu"
    return "cuda:0" if torch.cuda.is_available() else "cpu"


def vram_free_mb() -> int:
    """Free VRAM in MiB on the active CUDA device, or 0 when no CUDA."""
    try:
        import torch  # type: ignore[import-not-found]
    except ImportError:
        return 0
    if not torch.cuda.is_available():
        return 0
    free, _total = torch.cuda.mem_get_info()
    return int(free // (1024 * 1024))


def has_cuda() -> bool:
    return get_device() == "cuda:0"
