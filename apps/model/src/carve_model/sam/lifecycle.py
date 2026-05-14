"""SAM lifecycle manager — unified ownership of the one resident SAM variant.

Replaces the three-singleton sprawl (_SESSION, _NATIVE_IMAGE_PREDICTOR,
_TEXT_PREDICTOR_FACTORY) with one state machine + one strategy protocol.
See docs/superpowers/specs/2026-05-14-sam-lifecycle-manager-design.md.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

__all__ = [
    "SamCapabilityError",
    "SamNotReadyError",
    "SamLoadError",
    "LoadStateKind",
    "LoadState",
    "SamVariant",
    "Sam2Variant",
    "Sam3p1Variant",
    "SamLifecycleManager",
    "_build_variant",
]


class SamCapabilityError(Exception):
    """Raised when a variant does not support the requested inference mode.

    sam2 variants raise this from predict_text / predict_box / predict_visual.
    Mapped to HTTP 409 by the router.
    """


class SamNotReadyError(Exception):
    """Raised when lease() is called but the manager is not in 'ready' state.

    state is one of 'idle', 'loading', 'error'. Mapped to HTTP 503 by the
    router with a state-specific detail string.
    """

    def __init__(self, state: str) -> None:
        super().__init__(f"sam not ready: state={state}")
        self.state = state


class SamLoadError(Exception):
    """Raised when ensure_loaded() fails to build the requested variant.

    The original exception is set as __cause__. The router does not catch
    this directly — load happens in a background thread; status reflects
    the failure via /sam/status.
    """

    def __init__(self, variant: str, cause: BaseException) -> None:
        super().__init__(f"load failed for {variant}: {cause!r}")
        self.variant = variant


LoadStateKind = Literal["idle", "loading", "ready", "error"]


@dataclass(frozen=True)
class LoadState:
    """Immutable snapshot of the manager's current load state.

    Mirrors the shape that today's predictor.py LoadState exposes; routers
    that today read from p_mod._LOAD_STATE will read manager.status() and
    get this object.
    """

    kind: LoadStateKind
    variant: str | None = None
    loaded_at: str | None = None
    started_at: str | None = None
    error: str | None = None

    @classmethod
    def idle(cls) -> LoadState:
        return cls(kind="idle")

    @classmethod
    def loading(cls, variant: str, *, started_at: str) -> LoadState:
        return cls(kind="loading", variant=variant, started_at=started_at)

    @classmethod
    def ready(cls, variant: str, *, loaded_at: str) -> LoadState:
        return cls(kind="ready", variant=variant, loaded_at=loaded_at)

    @classmethod
    def error_(cls, variant: str | None, error: str) -> LoadState:
        return cls(kind="error", variant=variant, error=error)


from typing import Any, Iterator, Protocol, runtime_checkable


@runtime_checkable
class SamVariant(Protocol):
    """One SAM model variant. Owns its weights, image cache, and the four
    inference paths.

    The manager holds at most one of these. Implementations:
    Sam2Variant (no text/box/visual), Sam3p1Variant (all four).
    """

    name: str
    device: str | None
    build_key: tuple[str, str, str]

    # ---- lifecycle ----
    def load(self, device: str | None) -> None: ...
    def unload(self) -> None: ...

    # ---- image cache ----
    def set_image(self, image: "Any") -> str: ...
    def cached_image_hash(self) -> str | None: ...
    def cached_image_shape(self) -> tuple[int, int] | None: ...
    def extract_embedding(self) -> bytes | None: ...

    # ---- iterative-refinement state ----
    def set_prev_logits(self, low_res_logits: Any | None, n_points: int) -> None: ...
    def get_prev_logits(self) -> tuple[Any | None, int]: ...

    # ---- inference ----
    def predict_point(
        self,
        *,
        point_coords: Any | None,
        point_labels: Any | None,
        box: Any | None = None,
        mask_input: Any | None = None,
        multimask_output: bool = True,
    ) -> tuple[Any, Any, Any]: ...

    def predict_text(
        self,
        *,
        image_b64: str,
        text: str,
        threshold: float | None = None,
        use_vlm_fo1: bool = False,
    ) -> list[dict]: ...

    def predict_box(
        self,
        *,
        image_b64: str,
        boxes: list[list[float]],
        box_labels: list[int],
        text: str | None = None,
    ) -> list[dict]: ...

    def predict_visual(
        self,
        *,
        image_b64: str,
        prompt_image_b64: str,
        prompt_box: list[float],
        threshold: float | None = None,
    ) -> list[dict]: ...

    # ---- capability flags ----
    @property
    def supports_text(self) -> bool: ...
    @property
    def supports_box(self) -> bool: ...
    @property
    def supports_visual(self) -> bool: ...


import hashlib


def _build_sam2_adapter(name: str, *, device: str | None) -> Any:
    """Thin indirection so tests can patch this name without importing torch."""
    from carve_model.sam import sam2_adapter
    return sam2_adapter.build_sam2_image_predictor(name, device=device)


def _hash_image(image: Any) -> str:
    """sha256 of an HxWx3 RGB uint8 numpy array (image-content-addressed cache key)."""
    return hashlib.sha256(memoryview(image).tobytes()).hexdigest()


class Sam2Variant:
    """SAM 2.x image predictor variant — point + box prompts, no text/visual."""

    supports_text = False
    supports_box = False
    supports_visual = False

    def __init__(self, name: str) -> None:
        self.name = name
        self.device: str | None = None
        self.build_key: tuple[str, str, str] = (name, "fp32", "sdpa")
        self._adapter: Any | None = None
        self._cached_hash: str | None = None
        self._cached_shape: tuple[int, int] | None = None
        self._prev_logits: Any | None = None
        self._prev_n_points: int = 0

    def load(self, device: str | None) -> None:
        self._adapter = _build_sam2_adapter(self.name, device=device)
        self.device = device

    def unload(self) -> None:
        self._adapter = None
        self._cached_hash = None
        self._cached_shape = None
        self._prev_logits = None
        self._prev_n_points = 0

    def set_image(self, image: Any) -> str:
        if self._adapter is None:
            raise RuntimeError("Sam2Variant.set_image called before load()")
        self._adapter.set_image(image)
        h = _hash_image(image)
        self._cached_hash = h
        self._cached_shape = (int(image.shape[0]), int(image.shape[1]))
        self._prev_logits = None
        self._prev_n_points = 0
        return h

    def cached_image_hash(self) -> str | None:
        return self._cached_hash

    def cached_image_shape(self) -> tuple[int, int] | None:
        return self._cached_shape

    def extract_embedding(self) -> bytes | None:
        if self._adapter is None:
            return None
        getter = getattr(self._adapter, "extract_embedding", None)
        if getter is None:
            return None
        return getter()

    def set_prev_logits(self, low_res_logits: Any | None, n_points: int) -> None:
        self._prev_logits = low_res_logits
        self._prev_n_points = int(n_points)

    def get_prev_logits(self) -> tuple[Any | None, int]:
        return (self._prev_logits, self._prev_n_points)

    def predict_point(
        self, *,
        point_coords: Any | None,
        point_labels: Any | None,
        box: Any | None = None,
        mask_input: Any | None = None,
        multimask_output: bool = True,
    ) -> tuple[Any, Any, Any]:
        if self._adapter is None:
            raise RuntimeError("Sam2Variant.predict_point called before load()")
        return self._adapter.predict(
            point_coords=point_coords,
            point_labels=point_labels,
            box=box,
            mask_input=mask_input,
            multimask_output=multimask_output,
        )

    def predict_text(self, **kw: Any) -> list[dict]:
        raise SamCapabilityError("sam2 variants do not support text prompts")

    def predict_box(self, **kw: Any) -> list[dict]:
        raise SamCapabilityError("sam2 variants do not support /sam/box-prompt")

    def predict_visual(self, **kw: Any) -> list[dict]:
        raise SamCapabilityError("sam2 variants do not support visual prompts")


def _build_sam3p1_adapter(*, device: str | None) -> Any:
    """Thin indirection for testing."""
    from carve_model.sam import sam3p1_adapter
    return sam3p1_adapter.build_sam3p1_image_predictor(device=device)


class Sam3p1Variant:
    """SAM 3.1 native predictor variant — point + box + text + visual, all
    four modes served by a single Sam3p1NativeImagePredictorAdapter
    instance. This unification is the structural fix for the double-load
    OOM bug."""

    name = "sam3.1"
    supports_text = True
    supports_box = True
    supports_visual = True

    def __init__(self) -> None:
        self.device: str | None = None
        self.build_key: tuple[str, str, str] = ("sam3.1", "bf16", "sdpa")
        self._adapter: Any | None = None
        self._cached_hash: str | None = None
        self._cached_shape: tuple[int, int] | None = None
        self._prev_logits: Any | None = None
        self._prev_n_points: int = 0

    def load(self, device: str | None) -> None:
        self._adapter = _build_sam3p1_adapter(device=device)
        self.device = device

    def unload(self) -> None:
        if self._adapter is not None:
            for attr in ("_state", "_model", "_processor", "_features"):
                try:
                    setattr(self._adapter, attr, None)
                except Exception:
                    pass
        self._adapter = None
        self._cached_hash = None
        self._cached_shape = None
        self._prev_logits = None
        self._prev_n_points = 0

    def set_image(self, image: Any) -> str:
        if self._adapter is None:
            raise RuntimeError("Sam3p1Variant.set_image called before load()")
        self._adapter.set_image(image)
        h = _hash_image(image)
        self._cached_hash = h
        self._cached_shape = (int(image.shape[0]), int(image.shape[1]))
        self._prev_logits = None
        self._prev_n_points = 0
        return h

    def cached_image_hash(self) -> str | None:
        return self._cached_hash

    def cached_image_shape(self) -> tuple[int, int] | None:
        return self._cached_shape

    def extract_embedding(self) -> bytes | None:
        return None

    def set_prev_logits(self, low_res_logits: Any | None, n_points: int) -> None:
        self._prev_logits = low_res_logits
        self._prev_n_points = int(n_points)

    def get_prev_logits(self) -> tuple[Any | None, int]:
        return (self._prev_logits, self._prev_n_points)

    def predict_point(
        self, *,
        point_coords: Any | None,
        point_labels: Any | None,
        box: Any | None = None,
        mask_input: Any | None = None,
        multimask_output: bool = True,
    ) -> tuple[Any, Any, Any]:
        if self._adapter is None:
            raise RuntimeError("Sam3p1Variant.predict_point called before load()")
        return self._adapter.predict(
            point_coords=point_coords,
            point_labels=point_labels,
            box=box,
            mask_input=mask_input,
            multimask_output=multimask_output,
        )

    def predict_text(self, **kw: Any) -> list[dict]:
        raise NotImplementedError("Sam3p1Variant.predict_text not yet migrated")

    def predict_box(self, **kw: Any) -> list[dict]:
        raise NotImplementedError("Sam3p1Variant.predict_box not yet migrated")

    def predict_visual(self, **kw: Any) -> list[dict]:
        raise NotImplementedError("Sam3p1Variant.predict_visual not yet migrated")


import gc
import threading
from contextlib import contextmanager


def _import_torch() -> Any | None:
    """Lazy torch import for cleanup helpers. Returns None when torch is absent."""
    try:
        import torch  # type: ignore[import-not-found]
        return torch
    except Exception:
        return None


def _build_variant(name: str) -> SamVariant:
    """Build a fresh variant instance for `name`. Does not call load()."""
    if name.startswith("sam2"):
        return Sam2Variant(name)
    if name == "sam3.1":
        return Sam3p1Variant()
    raise ValueError(f"unknown SAM variant: {name!r}")


class SamLifecycleManager:
    """Single owner of the resident SAM variant.

    Two locks:
    - _inference_lock: held during the full load operation AND during each
      inference call. Serializes everything against everything.
    - _load_lock: short critical sections only — state field mutation.

    Acquire order if both are needed: _inference_lock OUTER, _load_lock INNER.
    """

    def __init__(self) -> None:
        self._active: SamVariant | None = None
        self._test_variant: SamVariant | None = None
        self._state: LoadState = LoadState.idle()
        self._last_used_at: float | None = None
        self._remembered_variant: str | None = None
        self._inference_lock = threading.Lock()
        self._load_lock = threading.Lock()

    def status(self) -> LoadState:
        with self._load_lock:
            return self._state

    def install_test_variant(self, v: SamVariant | None) -> None:
        """Install a fake variant — bypasses load()/lease() locks entirely.

        When set, lease() yields this directly without acquiring locks or
        checking state. ensure_loaded/force_unload/evict_if_idle become
        no-ops. Pass None to uninstall."""
        self._test_variant = v

    def remembered_variant(self) -> str | None:
        with self._load_lock:
            return self._remembered_variant

    def _reset_for_tests(self) -> None:
        """Pytest-only reset to a clean post-construction state."""
        with self._inference_lock:
            with self._load_lock:
                self._active = None
                self._test_variant = None
                self._state = LoadState.idle()
                self._last_used_at = None
                self._remembered_variant = None

    def _run_cuda_cleanup(self) -> None:
        """Full eviction cleanup: 3x gc + sync + empty_cache + ipc_collect + dynamo.reset.

        Same sequence as predictor.py's force_evict_predictor() — centralized
        here so every unload path (idle, force, switch) gets identical cleanup."""
        torch = _import_torch()
        for _ in range(3):
            gc.collect()
            if torch is not None:
                try:
                    if torch.cuda.is_available():
                        torch.cuda.synchronize()
                        torch.cuda.empty_cache()
                except Exception:
                    pass
        try:
            import torch._dynamo  # type: ignore[import-not-found]
            torch._dynamo.reset()
        except Exception:
            pass
        if torch is not None:
            try:
                if torch.cuda.is_available():
                    torch.cuda.ipc_collect()
            except Exception:
                pass

    def _run_cuda_cleanup_light(self) -> None:
        """Best-effort empty_cache only. Used after inference OOM."""
        torch = _import_torch()
        if torch is None:
            return
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    @contextmanager
    def lease(self):
        """Stub — replaced in Task 1.8 with full implementation."""
        if self._test_variant is not None:
            yield self._test_variant
            return
        raise SamNotReadyError(self._state.kind)
        yield  # unreachable; satisfies the generator protocol
