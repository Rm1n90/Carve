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
    "manager",
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

    def predict_text(
        self,
        *,
        image_b64: str,
        text: str,
        threshold: float | None = None,
        use_vlm_fo1: bool = False,
    ) -> list[dict]:
        """Run a text prompt and return [{counts, size, score, bbox, polygon}, ...]
        sorted by score desc.

        Uses self._adapter — the same instance as predict_point. No second
        Sam3p1NativeImagePredictorAdapter is built; this is the structural
        fix for the double-load OOM bug.
        """
        if self._adapter is None:
            raise RuntimeError("Sam3p1Variant.predict_text called before load()")

        torch = _import_torch()

        image_np = _decode_image_b64_to_numpy(image_b64)
        # CRITICAL: route through self.set_image() so cache state AND
        # _prev_logits/_prev_n_points are all atomically updated.
        # Direct adapter.set_image() would leave stale refinement logits.
        self.set_image(image_np)

        adapter = self._adapter  # local alias after set_image succeeded
        state = adapter._state
        if state is None:
            return []

        adapter._processor.reset_all_prompts(state)

        processor = adapter._processor
        original_threshold = None
        if threshold is not None:
            original_threshold = getattr(processor, "confidence_threshold", 0.5)
            try:
                processor.set_confidence_threshold(float(threshold))
            except Exception:
                original_threshold = None

        try:
            if adapter._device == "cuda" and torch is not None:
                with torch.no_grad():
                    with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                        processor.set_text_prompt(text, state)
            else:
                if torch is not None:
                    with torch.no_grad():
                        processor.set_text_prompt(text, state)
                else:
                    processor.set_text_prompt(text, state)
        finally:
            if original_threshold is not None:
                try:
                    processor.set_confidence_threshold(original_threshold)
                except Exception:
                    pass

        detections = _extract_text_detections(state)
        boxes = state.get("boxes")
        boxes_np = to_numpy_safe(boxes) if boxes is not None else None

        rows: list[dict] = []
        for i, (mask_np, score) in enumerate(detections):
            counts, size = encode_mask_rle(mask_np)
            polygon = mask_to_polygon(mask_np)
            if boxes_np is not None and i < len(boxes_np):
                bbox = [float(x) for x in boxes_np[i].tolist()]
            else:
                bbox = [0.0, 0.0, 0.0, 0.0]
            rows.append({
                "counts": counts,
                "size": size,
                "score": score,
                "bbox": bbox,
                "polygon": polygon,
            })
        rows.sort(key=lambda r: r["score"], reverse=True)

        top_score = rows[0]["score"] if rows else 0.0
        min_score = rows[-1]["score"] if rows else 0.0
        log.info(
            "sam3.1 text-prompt: text=%r threshold=%s detections=%d "
            "score_range=[%.3f, %.3f]",
            text,
            f"{threshold:.3f}" if threshold is not None else "default",
            len(rows),
            min_score,
            top_score,
        )

        # GPU-hygiene: drop state tensors before next call
        if "masks_logits" in state: state["masks_logits"] = None
        if "masks" in state: state["masks"] = None
        if "boxes" in state: state["boxes"] = None
        if "scores" in state: state["scores"] = None
        if adapter._device == "cuda" and torch is not None:
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass

        if not use_vlm_fo1 or not rows:
            return rows

        import os
        try:
            top_k = int(os.environ.get("SAM3_TOPK_PROPOSALS", "64"))
        except ValueError:
            top_k = 64
        if top_k > 0 and len(rows) > top_k:
            rows = rows[:top_k]

        from carve_model.sam import predictor as p_mod
        vlm_filter = p_mod.get_vlm_fo1_filter()
        if vlm_filter is None:
            return rows

        try:
            from io import BytesIO
            from PIL import Image  # type: ignore[import-not-found]
            img_bytes = base64.b64decode(image_b64)
            pil = Image.open(BytesIO(img_bytes)).convert("RGB")
            boxes_xyxy = [list(r["bbox"]) for r in rows]
            indexes = vlm_filter(image=pil, text=text, boxes=boxes_xyxy)
        except Exception as exc:
            log.warning("vlm_fo1 filter failed (%s); degrading to passthrough", exc)
            return rows

        seen: set[int] = set()
        clean: list[int] = []
        for idx in indexes:
            try:
                ii = int(idx)
            except (TypeError, ValueError):
                continue
            if 0 <= ii < len(rows) and ii not in seen:
                seen.add(ii)
                clean.append(ii)
        return [rows[i] for i in clean]

    def predict_box(
        self,
        *,
        image_b64: str,
        boxes: list[list[float]],
        box_labels: list[int],
        text: str | None = None,
    ) -> list[dict]:
        """For each positive box (label=1), run predict_inst with
        multimask_output=False and keep the resulting mask. Optional text
        is applied first via set_text_prompt to bias the concept. Negative
        boxes (label=0) subtract from the union of positive masks.

        Uses self._adapter — same instance as predict_point/predict_text.
        """
        if self._adapter is None:
            raise RuntimeError("Sam3p1Variant.predict_box called before load()")

        import numpy as np
        torch = _import_torch()

        image_np = _decode_image_b64_to_numpy(image_b64)
        # Route through self.set_image() to atomically refresh cache + clear prev_logits
        self.set_image(image_np)

        adapter = self._adapter
        state = adapter._state
        if state is None:
            return []

        adapter._processor.reset_all_prompts(state)

        if text:
            if adapter._device == "cuda" and torch is not None:
                with torch.no_grad():
                    with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                        adapter._processor.set_text_prompt(text, state)
            else:
                if torch is not None:
                    with torch.no_grad():
                        adapter._processor.set_text_prompt(text, state)
                else:
                    adapter._processor.set_text_prompt(text, state)

        positive_masks: list[Any] = []
        negative_masks: list[Any] = []
        positive_scores: list[float] = []
        positive_boxes: list[list[float]] = []

        for box, label in zip(boxes, box_labels, strict=False):
            box_arr = np.asarray(box, dtype=np.float32).reshape(-1)
            result = self._run_box_predict_inst(state=state, box_arr=box_arr)
            if not result:
                continue
            best_mask, best_score = result
            if int(label) == 1:
                positive_masks.append(best_mask)
                positive_scores.append(best_score)
                positive_boxes.append([float(x) for x in box_arr.tolist()])
            else:
                negative_masks.append(best_mask)

        if not positive_masks:
            return []

        # Subtract union of negatives from each positive mask
        if negative_masks:
            neg_union = negative_masks[0].copy()
            for m in negative_masks[1:]:
                neg_union = np.logical_or(neg_union, m).astype(np.uint8)
            for i, m in enumerate(positive_masks):
                positive_masks[i] = np.logical_and(
                    m, np.logical_not(neg_union),
                ).astype(np.uint8)

        rows: list[dict] = []
        for mask_np, score, bbox in zip(
            positive_masks, positive_scores, positive_boxes, strict=False,
        ):
            counts, size = encode_mask_rle(mask_np)
            polygon = mask_to_polygon(mask_np)
            rows.append({
                "counts": counts,
                "size": size,
                "score": score,
                "bbox": bbox,
                "polygon": polygon,
            })
        rows.sort(key=lambda r: r["score"], reverse=True)

        # GPU-hygiene: clear state-dict tensors + empty_cache
        if "masks_logits" in state: state["masks_logits"] = None
        if "masks" in state: state["masks"] = None
        if "boxes" in state: state["boxes"] = None
        if "scores" in state: state["scores"] = None
        if adapter._device == "cuda" and torch is not None:
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass

        return rows

    def _run_box_predict_inst(
        self,
        *,
        state: dict,
        box_arr: Any,
    ) -> tuple[Any, float] | None:
        """Run one box prediction via adapter._model.predict_inst. Returns
        (best_mask, best_score) or None when no mask produced. Factored
        out so tests can stub without importing torch."""
        if self._adapter is None:
            return None

        import numpy as np
        torch = _import_torch()
        adapter = self._adapter

        if adapter._device == "cuda" and torch is not None:
            with torch.no_grad():
                with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                    masks, scores, _ = adapter._model.predict_inst(
                        state,
                        point_coords=None,
                        point_labels=None,
                        box=box_arr,
                        multimask_output=False,
                    )
        else:
            if torch is not None:
                with torch.no_grad():
                    masks, scores, _ = adapter._model.predict_inst(
                        state,
                        point_coords=None,
                        point_labels=None,
                        box=box_arr,
                        multimask_output=False,
                    )
            else:
                masks, scores, _ = adapter._model.predict_inst(
                    state,
                    point_coords=None,
                    point_labels=None,
                    box=box_arr,
                    multimask_output=False,
                )

        if masks is None or len(masks) == 0:
            return None
        best_idx = int(np.argmax(np.asarray(scores)))
        best_mask = np.asarray(masks[best_idx]).astype(np.uint8)
        best_score = float(np.asarray(scores)[best_idx])
        return (best_mask, best_score)

    def predict_visual(self, **kw: Any) -> list[dict]:
        raise NotImplementedError("Sam3p1Variant.predict_visual not yet migrated")


import base64
import gc
import logging
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone

log = logging.getLogger(__name__)


def _extract_text_detections(state: dict) -> list[tuple[Any, float]]:
    from carve_model.sam.sam3p1_adapter import _extract_text_detections as _impl
    return _impl(state)


def _decode_image_b64_to_numpy(image_b64: str) -> Any:
    from carve_model.sam.sam3p1_adapter import _decode_image_b64_to_numpy as _impl
    return _impl(image_b64)


def encode_mask_rle(mask_np: Any) -> tuple[str, list[int]]:
    from carve_model.sam.codec import encode_mask_rle as _impl
    return _impl(mask_np)


def mask_to_polygon(mask_np: Any) -> list:
    from carve_model.sam.polygonize import mask_to_polygon as _impl
    return _impl(mask_np)


def to_numpy_safe(x: Any) -> Any:
    from carve_model.sam.perf import to_numpy_safe as _impl
    return _impl(x)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _short_repr(exc: BaseException, maxlen: int = 200) -> str:
    s = repr(exc)
    return s if len(s) <= maxlen else s[: maxlen - 3] + "..."


_ALLOWED_VARIANTS = frozenset({
    "sam2.1-tiny",
    "sam2.1-small",
    "sam2.1-base-plus",
    "sam2.1-large",
    "sam3.1",
})


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


def _is_cuda_oom(exc: BaseException) -> bool:
    """Best-effort detection of torch.cuda.OutOfMemoryError without importing torch."""
    cls_name = type(exc).__name__
    if "OutOfMemory" in cls_name:
        return True
    msg = str(exc).lower()
    return "out of memory" in msg or "cuda oom" in msg


class SamLifecycleManager:
    """Single owner of the resident SAM variant.

    Two locks:
    - _inference_lock: held during the full load operation AND during each
      inference call. Serializes everything against everything.
    - _load_lock: short critical sections only — state field mutation.

    Acquire order if both are needed: _inference_lock OUTER, _load_lock INNER.
    """

    DEFAULT_IDLE_TIMEOUT_S = 15 * 60  # 15 minutes

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

    def ensure_loaded(self, variant: str, *, device: str | None = None) -> None:
        """Switch the manager to `variant`. Idempotent if already loaded.

        Synchronous. Callers that need a 202-style endpoint should run this
        in a background thread.

        Raises ValueError for unknown variants, SamLoadError on load failure.
        """
        if self._test_variant is not None:
            return  # test mode — never touches real lifecycle

        if variant not in _ALLOWED_VARIANTS:
            raise ValueError(f"unknown SAM variant: {variant!r}")

        # Fast-path: already on it
        with self._load_lock:
            if (
                self._state.kind == "ready"
                and self._active is not None
                and self._active.name == variant
            ):
                self._remembered_variant = variant
                return

        # Slow-path: take inference lock first (waits for in-flight inference)
        self._inference_lock.acquire()
        try:
            # Re-check under both locks
            with self._load_lock:
                if (
                    self._state.kind == "ready"
                    and self._active is not None
                    and self._active.name == variant
                ):
                    self._remembered_variant = variant
                    return
                self._state = LoadState.loading(variant, started_at=_now_iso())

            # Unload existing (if any)
            if self._active is not None:
                self._try_unload_locked(self._active)
                self._active = None
                self._run_cuda_cleanup()

            # Build + load new
            new_variant: SamVariant | None = None
            try:
                new_variant = _build_variant(variant)
                resolved = self._resolve_device(device)
                new_variant.load(device=resolved)
            except Exception as exc:
                if new_variant is not None:
                    self._try_unload_locked(new_variant)
                self._run_cuda_cleanup()
                with self._load_lock:
                    self._state = LoadState.error_(variant, _short_repr(exc))
                    self._active = None
                    self._remembered_variant = variant
                raise SamLoadError(variant, exc) from exc

            with self._load_lock:
                self._active = new_variant
                self._state = LoadState.ready(variant, loaded_at=_now_iso())
                self._last_used_at = time.monotonic()
                self._remembered_variant = variant
        finally:
            self._inference_lock.release()

    def _try_unload_locked(self, v: SamVariant) -> None:
        """Best-effort unload — logs and swallows exceptions."""
        try:
            v.unload()
        except Exception:
            log.exception("variant %s unload raised; continuing with GC", v.name)

    def _resolve_device(self, device: str | None) -> str | None:
        """Device resolution wiring. Phase 1 returns the caller's value as-is."""
        return device

    @contextmanager
    def lease(self):
        """Acquire exclusive use of the active variant.

        Yields the SamVariant. Acquires _inference_lock; ticks _last_used_at
        on enter and exit. Raises SamNotReadyError when not in 'ready' state.
        CUDA OOM during the lease block triggers a light cleanup before reraising.
        """
        if self._test_variant is not None:
            yield self._test_variant
            return
        self._inference_lock.acquire()
        try:
            with self._load_lock:
                if self._state.kind != "ready" or self._active is None:
                    raise SamNotReadyError(self._state.kind)
                self._last_used_at = time.monotonic()
                active = self._active
            try:
                yield active
            except Exception as exc:
                if _is_cuda_oom(exc):
                    self._run_cuda_cleanup_light()
                    log.warning("inference OOM in %s: %s", active.name, exc)
                raise
        finally:
            with self._load_lock:
                self._last_used_at = time.monotonic()
            self._inference_lock.release()

    def _idle_timeout_s(self) -> int:
        """Return SAM_IDLE_TIMEOUT_S env var (default 900s; 0 disables)."""
        import os
        raw = os.environ.get("SAM_IDLE_TIMEOUT_S", str(self.DEFAULT_IDLE_TIMEOUT_S))
        try:
            v = int(raw)
            return max(0, v)
        except ValueError:
            return self.DEFAULT_IDLE_TIMEOUT_S

    def force_unload(self) -> bool:
        """Drop the active variant + run GPU cleanup. Returns True iff freed."""
        if self._test_variant is not None:
            return False
        self._inference_lock.acquire()
        try:
            with self._load_lock:
                if self._active is None and self._state.kind == "idle":
                    return False
                old = self._active
                self._active = None
            if old is not None:
                self._try_unload_locked(old)
            self._run_cuda_cleanup()
            with self._load_lock:
                self._state = LoadState.idle()
                self._last_used_at = None
            return True
        finally:
            self._inference_lock.release()

    def evict_if_idle(self) -> bool:
        """No-op when not idle, when timeout=0, or when last_used is fresh."""
        if self._test_variant is not None:
            return False
        timeout = self._idle_timeout_s()
        if timeout == 0:
            return False
        with self._load_lock:
            if self._active is None or self._last_used_at is None:
                return False
            if (time.monotonic() - self._last_used_at) < timeout:
                return False
        self._inference_lock.acquire()
        try:
            with self._load_lock:
                if self._active is None or self._last_used_at is None:
                    return False
                if (time.monotonic() - self._last_used_at) < timeout:
                    return False
                old = self._active
                self._active = None
            self._try_unload_locked(old)
            self._run_cuda_cleanup()
            with self._load_lock:
                self._state = LoadState.idle()
                self._last_used_at = None
            log.info("sam_lifecycle: evicted_on_idle variant=%s", old.name)
            return True
        finally:
            self._inference_lock.release()

    @contextmanager
    def lease_or_load(self):
        """Canonical router entry point: lease the active variant; lazily
        load the last-known variant if currently idle.

        Other not-ready states (loading, error) propagate as SamNotReadyError.
        """
        try:
            with self.lease() as sam:
                yield sam
                return
        except SamNotReadyError as e:
            if e.state != "idle":
                raise
        variant = self.remembered_variant() or self._env_default_variant()
        self.ensure_loaded(variant)
        with self.lease() as sam:
            yield sam

    def _env_default_variant(self) -> str:
        """Read SAM_MODEL env var with the production default fallback."""
        import os
        return os.environ.get("SAM_MODEL", "sam2.1-large")


# Module-level singleton — the production manager.
manager = SamLifecycleManager()
