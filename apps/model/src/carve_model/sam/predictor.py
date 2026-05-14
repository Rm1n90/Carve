"""SAM predictor compat facade.

Task 5.2 of the SAM Lifecycle Manager refactor reduced this module to a
thin back-compat shim layer. All real SAM lifecycle state — variant,
load status, image cache, refinement logits, idle clock — now lives on
``carve_model.sam.lifecycle.manager``.

External callers (routers, adapters, tests) keep importing the same
public names; each is now a 3-5 line delegation to the manager. Operators
who poked the legacy module globals (``_SESSION``, ``_LOAD_STATE``,
``_PREDICTOR_LOCK``, etc.) directly need to migrate to
``manager.lease_or_load()`` and friends — see the spec.
"""

from __future__ import annotations

import contextlib
import logging
import os
import time
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Callable, Iterator, Protocol

from carve_model.sam.lifecycle import (
    LoadState,
    _LegacyTestVariant,
    manager as _sam_manager,
)

log = logging.getLogger(__name__)


# Allowed values for SAM_MODEL. Keep in lockstep with README and .env.example.
ALLOWED_SAM_MODELS = (
    "sam2.1-tiny",
    "sam2.1-small",
    "sam2.1-base-plus",
    "sam2.1-large",
    "sam3",
    "sam3.1",
)
DEFAULT_SAM_MODEL = "sam2.1-large"

# Hugging Face repo ids per variant. sam3.1 reads transformers-loadable
# ``facebook/sam3`` weights for the image side; the multiplex tracker
# uses its own checkpoint (see ``tracker._default_factory``).
_HF_REPO_BY_MODEL = {
    "sam2.1-tiny":      "facebook/sam2.1-hiera-tiny",
    "sam2.1-small":     "facebook/sam2.1-hiera-small",
    "sam2.1-base-plus": "facebook/sam2.1-hiera-base-plus",
    "sam2.1-large":     "facebook/sam2.1-hiera-large",
    "sam3":             "facebook/sam3",
    "sam3.1":           "facebook/sam3",
}


_SAM3_WARNED = False


def get_sam_model() -> str:
    """Return the configured SAM model id.

    Reads ``SAM_MODEL`` first; falls back to the legacy ``SAM_VARIANT`` env
    (Plan 08). Unknown values fall back to ``DEFAULT_SAM_MODEL`` with a
    one-line warning.

    Phase 6: ``SAM_MODEL=sam3`` is deprecated. Auto-remaps to ``sam3.1`` with
    a one-time WARN log so existing operator configs keep working until they
    update their env. To silence the warning, set ``SAM_MODEL=sam3.1``.
    """
    global _SAM3_WARNED
    raw = os.getenv("SAM_MODEL") or os.getenv("SAM_VARIANT") or DEFAULT_SAM_MODEL
    if raw == "sam2":
        raw = DEFAULT_SAM_MODEL
    if raw == "sam3":
        if not _SAM3_WARNED:
            log.warning(
                "SAM_MODEL=sam3 is deprecated; remapping to sam3.1 "
                "(same accuracy, single model on GPU). Update your env "
                "to silence this warning."
            )
            _SAM3_WARNED = True
        raw = "sam3.1"
    if raw not in ALLOWED_SAM_MODELS:
        log.warning("unknown SAM_MODEL=%r; falling back to %s", raw, DEFAULT_SAM_MODEL)
        return DEFAULT_SAM_MODEL
    return raw


def get_sam_variant() -> str:
    """Return ``"sam3"`` for sam3 family, otherwise ``"sam2"`` (Plan 08 contract)."""
    return "sam3" if get_sam_model() in ("sam3", "sam3.1") else "sam2"


def is_sam3_family() -> bool:
    """True when the active model is sam3 or sam3.1."""
    return get_sam_model() in ("sam3", "sam3.1")


# --- bf16 autocast gate ----------------------------------------------------

_TRUTHY_BF16 = ("1", "true", "yes", "on")


def use_bf16() -> bool:
    """True when bf16 autocast should wrap SAM inference (env + hardware gated)."""
    if os.getenv("SAM_BF16", "1") not in _TRUTHY_BF16:
        return False
    try:
        import torch  # type: ignore[import-not-found]
        if not torch.cuda.is_available():
            return False
        return bool(torch.cuda.is_bf16_supported())
    except Exception:
        return False


@contextlib.contextmanager
def autocast_ctx() -> Iterator[None]:
    """Wrap inference in ``torch.autocast(cuda, bfloat16)`` when supported.

    No-op when CUDA or bf16 are unavailable. Fails open on any torch
    error so autocast itself never crashes inference.
    """
    if not use_bf16():
        yield
        return
    try:
        import torch  # type: ignore[import-not-found]
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
            yield
    except Exception:
        yield


# --- torch.compile gate ----------------------------------------------------

_TRUTHY_COMPILE = ("1", "true", "yes", "on")


def use_compile() -> bool:
    """True when the loaded SAM model should be wrapped in torch.compile."""
    if os.getenv("SAM_COMPILE", "0") not in _TRUTHY_COMPILE:
        return False
    try:
        import torch  # type: ignore[import-not-found]
        return torch.cuda.is_available()
    except Exception:
        return False


def maybe_compile(model: Any) -> Any:
    """Return ``torch.compile(model, mode="reduce-overhead")`` if enabled.

    Best-effort: log + return uncompiled when ``torch.compile`` raises.
    """
    if not use_compile():
        return model
    try:
        import torch  # type: ignore[import-not-found]
        compiled = torch.compile(model, mode="reduce-overhead")
        log.info("torch.compile enabled for SAM model")
        return compiled
    except Exception as exc:  # noqa: BLE001
        log.warning("torch.compile failed (%s); falling back to uncompiled model", exc)
        return model


# --- predictor protocol + injection types ---------------------------------


class SamPredictor(Protocol):
    """Duck type matching the parts of SAM2ImagePredictor we use."""

    def set_image(self, image: Any) -> None: ...

    def predict(
        self,
        point_coords: Any,
        point_labels: Any,
        multimask_output: bool = True,
    ) -> tuple[Any, Any, Any]: ...


# A SAM 3 text-prompt predictor accepts (image_b64, text, ...) and returns
# zero or more candidate masks in ``{counts, size, score, bbox}`` form.
TextPredictor = Callable[..., list[dict]]
BoxPredictor = Callable[..., list[dict]]
VisualPredictor = Any
# VLM-FO1 precision filter: ``(image, text, boxes) -> list[int]``.
VlmFo1Filter = Callable[..., list[int]]


# Legacy module-level test injection slots. Each setter installs/clears
# an impl on the manager's _LegacyTestVariant; the module globals are
# kept for tests that read them directly.
_TEST_PREDICTOR: SamPredictor | None = None
_TEXT_PREDICTOR_FACTORY: TextPredictor | None = None
_BOX_PREDICTOR_FACTORY: BoxPredictor | None = None
_VISUAL_PREDICTOR_FACTORY: VisualPredictor | None = None
_VLM_FO1_FILTER: VlmFo1Filter | None = None

DEFAULT_SAM_IDLE_TIMEOUT_S = 15 * 60  # 15 minutes


# --- PEP 562 fallback for legacy module globals ---------------------------


def __getattr__(name: str) -> Any:
    """Pre-v3.5 tests read ``p_mod._PREDICTOR`` / ``_PREDICTOR_LAST_USED``."""
    if name == "_PREDICTOR":
        v = _sam_manager._test_variant or _sam_manager._active
        if v is None:
            return None
        if isinstance(v, _LegacyTestVariant):
            return v._point_impl
        return getattr(v, "_adapter", v)
    if name == "_PREDICTOR_LAST_USED":
        return _sam_manager._last_used_at or 0.0
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- load-state shims ------------------------------------------------------


def get_load_state() -> Any:
    """Return the manager's LoadState (no progress_bytes/progress_total/job_id)."""
    return _sam_manager.status()


def _set_load_state(**kwargs: Any) -> Any:
    """Write a legacy-shape snapshot to the manager's state.

    Maps kind/variant/loaded_at/error onto the new LoadState. Unknown
    legacy fields (progress_bytes, progress_total, job_id) are dropped.
    """
    kind = kwargs.get("kind", "idle")
    variant = kwargs.get("variant")
    loaded_at = kwargs.get("loaded_at")
    error = kwargs.get("error")
    if kind == "idle":
        new = LoadState.idle()
    elif kind == "loading":
        new = LoadState.loading(variant or "", started_at=loaded_at or _now_iso())
    elif kind == "ready":
        new = LoadState.ready(variant or "", loaded_at=loaded_at or _now_iso())
    elif kind == "error":
        new = LoadState.error_(variant, error or "")
    else:
        new = LoadState(kind=kind, variant=variant, loaded_at=loaded_at, error=error)
    _sam_manager._state = new
    return new


def _reset_load_state() -> None:
    """Test helper: drop the load state machine back to idle."""
    _sam_manager._state = LoadState.idle()


def _set_load_progress(*args: Any, **kwargs: Any) -> None:
    """No-op shim — the manager doesn't track HF download progress.

    Adapters still call this during weight loading; /sam/status reports
    ``progress_bytes`` / ``progress_total`` as constant None (Task 3.6).
    """
    return None


# --- legacy session compat -------------------------------------------------
#
# Pre-Task 5.2 tests poked _set_test_session(predictor) / set_loaded_image
# / get_session() directly. We route through the manager's
# _LegacyTestVariant so those test fixtures keep working unchanged.


def _legacy_variant() -> _LegacyTestVariant:
    """Get or create the singleton _LegacyTestVariant installed on the manager."""
    v = _sam_manager._test_variant
    if not isinstance(v, _LegacyTestVariant):
        v = _LegacyTestVariant()
        _sam_manager.install_test_variant(v)
    return v


def _legacy_clear(op: str) -> None:
    """Clear one impl on the LegacyTestVariant; uninstall when all are None."""
    v = _sam_manager._test_variant
    if not isinstance(v, _LegacyTestVariant):
        return
    setattr(v, f"_{op}_impl", None)
    if all(
        getattr(v, f"_{o}_impl") is None
        for o in ("point", "text", "box", "visual")
    ):
        _sam_manager.install_test_variant(None)


def _clear_manager_image_state() -> bool:
    """Reset image-cache + refinement state on the manager's variants.

    Used by legacy eviction paths so subsequent ``/sam/decode`` returns
    409 instead of running inference against a stale embedding.
    """
    changed = False
    for v in (_sam_manager._active, _sam_manager._test_variant):
        if v is None:
            continue
        if getattr(v, "_cached_hash", None) is not None:
            v._cached_hash = None
            v._cached_shape = None
            v._prev_logits = None
            v._prev_n_points = 0
            changed = True
    return changed


def _set_test_session(predictor: Any, *, last_used_at: float | None = None) -> None:
    """Test-only helper: install a session with the given predictor.

    Routes through the manager's _LegacyTestVariant aggregator.
    """
    if predictor is None:
        v = _sam_manager._test_variant
        if isinstance(v, _LegacyTestVariant):
            _sam_manager.install_test_variant(None)
        _sam_manager._last_used_at = None
        return
    _legacy_variant()._point_impl = predictor
    _sam_manager._last_used_at = (
        time.monotonic() if last_used_at is None else last_used_at
    )


def get_session() -> Any:
    """Return a SimpleNamespace mirror of the legacy SamSession (or None)."""
    v = _sam_manager._test_variant or _sam_manager._active
    if v is None:
        return None
    if isinstance(v, _LegacyTestVariant):
        predictor: Any = v._point_impl
    else:
        predictor = getattr(v, "_adapter", v)
    shape = v.cached_image_shape()
    prev_logits, prev_n = v.get_prev_logits()
    return SimpleNamespace(
        predictor=predictor,
        loaded_hash=v.cached_image_hash(),
        loaded_shape=list(shape) if shape is not None else [],
        last_used_at=_sam_manager._last_used_at or 0.0,
        build_key=getattr(v, "build_key", None),
        prev_low_res_logits=prev_logits,
        prev_n_points=prev_n,
    )


def set_loaded_image(image_hash: str, shape: list[int]) -> None:
    """Record image hash + shape on the active variant's cache.

    Production routers no longer call this directly — the variant's
    ``set_image()`` populates the cache. Tests use it to fake an
    image-loaded state without running the encoder.
    """
    v = _sam_manager._test_variant or _sam_manager._active
    if v is None:
        raise RuntimeError("no active SAM session; call get_predictor() first")
    v._cached_hash = image_hash
    v._cached_shape = (int(shape[0]), int(shape[1])) if len(shape) >= 2 else None
    v._prev_logits = None
    v._prev_n_points = 0


def set_prev_logits(low_res_logits: Any | None, n_points: int) -> None:
    """Record the previous decode's low-res mask logits on the variant."""
    v = _sam_manager._test_variant or _sam_manager._active
    if v is None:
        return
    v.set_prev_logits(low_res_logits, n_points)


def touch_predictor() -> None:
    """Update the predictor's last-used timestamp. No-op when nothing is loaded."""
    if _sam_manager._active is not None or _sam_manager._test_variant is not None:
        _sam_manager._last_used_at = time.monotonic()


def _idle_timeout_s() -> int:
    """Return the configured idle timeout in seconds (0 disables eviction)."""
    raw = os.getenv("SAM_IDLE_TIMEOUT_S", str(DEFAULT_SAM_IDLE_TIMEOUT_S))
    try:
        v = int(raw)
        return max(0, v)
    except ValueError:
        return DEFAULT_SAM_IDLE_TIMEOUT_S


def evict_predictor_if_idle() -> bool:
    """Drop the active variant if idle > SAM_IDLE_TIMEOUT_S."""
    # Legacy test-mode path — manager.evict_if_idle short-circuits when
    # a test variant is installed, but legacy contract is that backdated
    # _last_used_at on a fake should evict.
    if isinstance(_sam_manager._test_variant, _LegacyTestVariant):
        timeout = _idle_timeout_s()
        if timeout == 0 or _sam_manager._last_used_at is None:
            return False
        if (time.monotonic() - _sam_manager._last_used_at) < timeout:
            return False
        _sam_manager.install_test_variant(None)
        _sam_manager._last_used_at = None
        _sam_manager._state = LoadState.idle()
        return True
    return _sam_manager.evict_if_idle()


def _gpu_used_bytes() -> int | None:
    """Best-effort current-process GPU memory (bytes), or None.

    Uses ``torch.cuda.memory_reserved`` — what the caching allocator
    holds from the driver, a truer eviction-effectiveness signal than
    ``memory_allocated``.
    """
    try:
        import torch  # type: ignore[import-not-found]
        if not torch.cuda.is_available():
            return None
        return int(torch.cuda.memory_reserved())
    except Exception:  # noqa: BLE001
        return None


def force_evict_predictor() -> bool:
    """Drop the active variant + run GPU cleanup. Returns True if anything freed.

    Routes through ``manager.force_unload()`` plus clears legacy test
    variant + factory closures so the compat surface matches the old
    semantics (force-evict drops everything inferenceable).
    """
    global _TEST_PREDICTOR, _TEXT_PREDICTOR_FACTORY, _BOX_PREDICTOR_FACTORY
    global _VISUAL_PREDICTOR_FACTORY

    something_freed = False

    if _sam_manager.force_unload():
        something_freed = True

    if _clear_manager_image_state():
        something_freed = True

    v = _sam_manager._test_variant
    if isinstance(v, _LegacyTestVariant):
        _sam_manager.install_test_variant(None)
        something_freed = True

    if _TEST_PREDICTOR is not None:
        _TEST_PREDICTOR = None
        something_freed = True
    if _TEXT_PREDICTOR_FACTORY is not None:
        _TEXT_PREDICTOR_FACTORY = None
        something_freed = True
    if _BOX_PREDICTOR_FACTORY is not None:
        _BOX_PREDICTOR_FACTORY = None
        something_freed = True
    if _VISUAL_PREDICTOR_FACTORY is not None:
        _VISUAL_PREDICTOR_FACTORY = None
        something_freed = True

    if _sam_manager._state.kind == "ready":
        _sam_manager._state = LoadState.idle()
    _sam_manager._last_used_at = None

    return something_freed


# --- public load + variant management --------------------------------------


def load_predictor(variant: str) -> None:
    """Switch the active SAM variant. Idempotent on the current variant.

    Delegates to ``manager.ensure_loaded`` in production. Test paths
    short-circuit through ``_TEST_PREDICTOR`` or ``_LegacyTestVariant``
    so existing fixtures keep working.
    """
    if variant not in ALLOWED_SAM_MODELS:
        raise ValueError(
            f"unknown SAM variant {variant!r}; "
            f"allowed: {', '.join(ALLOWED_SAM_MODELS)}"
        )

    # set_test_predictor path: high-level fake stays in place; just
    # clear the image cache and flip state to ``ready``.
    if _TEST_PREDICTOR is not None:
        os.environ["SAM_MODEL"] = variant
        _clear_manager_image_state()
        _sam_manager._state = LoadState.ready(variant, loaded_at=_now_iso())
        return

    # _set_test_session path: no _TEST_PREDICTOR but a _LegacyTestVariant
    # is installed. Same-variant is a no-op; cross-variant rebuilds via
    # _default_factory (tests stub that helper to avoid real weights).
    if isinstance(_sam_manager._test_variant, _LegacyTestVariant):
        current = get_sam_model()
        os.environ["SAM_MODEL"] = variant
        if variant == current:
            _sam_manager._state = LoadState.ready(variant, loaded_at=_now_iso())
            return
        _clear_manager_image_state()
        rebuilt = _default_factory()
        _legacy_variant()._point_impl = rebuilt
        _sam_manager._last_used_at = time.monotonic()
        _sam_manager._state = LoadState.ready(variant, loaded_at=_now_iso())
        return

    os.environ["SAM_MODEL"] = variant
    _sam_manager.ensure_loaded(variant)


def get_predictor() -> Any:
    """Return the active variant (or test-injected predictor).

    Production code should use ``manager.lease_or_load()`` directly. This
    helper exists for back-compat; raises ``RuntimeError`` when no
    predictor is loaded after a lazy-build attempt.
    """
    v = _sam_manager._test_variant or _sam_manager._active
    if v is None:
        load_predictor(get_sam_model())
        v = _sam_manager._active
    if v is None:
        raise RuntimeError(f"sam not ready: state={_sam_manager.status().kind}")
    _sam_manager._last_used_at = time.monotonic()
    if isinstance(v, _LegacyTestVariant):
        return v._point_impl
    return getattr(v, "_adapter", v)


def _default_factory() -> Any:
    """Production factory: load the configured SAM image predictor.

    Kept for tests that exercise the variant dispatch directly.
    Production paths now go through ``manager.ensure_loaded`` which
    builds the variant internally; this helper duplicates the env →
    adapter routing so existing tests keep working.
    """
    try:
        from carve_model import device_prefs
        from carve_model.devices import MIN_FREE_MB_DEFAULTS, resolve_device

        pref = device_prefs.get_pref("sam")
        resolved = resolve_device(
            pref, min_free_mb=MIN_FREE_MB_DEFAULTS["sam"]
        ).device
    except Exception:  # noqa: BLE001
        resolved = None

    sam_device: str | None = resolved
    # SAM adapters compare ``device == "cuda"`` to gate bf16 autocast;
    # the native sam3 builder expects bare "cuda"/"cpu", not "cuda:N".
    # Honour cuda:N by setting the default index + handing bare "cuda".
    if isinstance(resolved, str) and resolved.startswith("cuda:"):
        try:
            import torch  # type: ignore[import-not-found]
            idx = int(resolved.split(":", 1)[1])
            torch.cuda.set_device(idx)
            sam_device = "cuda"
        except Exception:  # noqa: BLE001
            log.warning("sam: could not set CUDA index from %s; passing through", resolved)
            sam_device = resolved

    model = get_sam_model()
    if model == "sam3.1":
        from carve_model.sam import sam3_adapter, sam3p1_adapter
        adapter = sam3p1_adapter.build_sam3p1_image_predictor(device=sam_device)
        set_visual_predictor(sam3_adapter.make_sam3_visual_predictor())
        return adapter
    if model == "sam3":
        from carve_model.sam import sam3_adapter
        adapter = sam3_adapter.build_sam3_image_predictor(device=sam_device)
        set_text_predictor(sam3_adapter.make_sam3_text_predictor())
        set_box_predictor(sam3_adapter.make_sam3_box_predictor())
        return adapter
    if model.startswith("sam2"):
        from carve_model.sam import sam2_adapter
        return sam2_adapter.build_sam2_image_predictor(model, device=sam_device)
    raise ValueError(
        f"unknown SAM model {model!r}; allowed: {', '.join(ALLOWED_SAM_MODELS)}"
    )


# --- test injection slot setters ------------------------------------------


def set_test_predictor(p: SamPredictor | None) -> None:
    """Inject a stub for tests; pass ``None`` to clear."""
    global _TEST_PREDICTOR
    if p is None:
        _legacy_clear("point")
        _TEST_PREDICTOR = None
        _reset_singleton()
        return
    _legacy_variant()._point_impl = p
    _TEST_PREDICTOR = p
    _reset_singleton()


def _reset_singleton() -> None:
    """Reset the load-state machine. Used by router's _reset_for_test.

    Manager state is left intact when a test variant is installed — the
    test relies on it staying readable.
    """
    if _sam_manager._test_variant is None:
        _sam_manager._state = LoadState.idle()
    _sam_manager._last_used_at = None


def set_text_predictor(fn: TextPredictor | None) -> None:
    """Register the SAM 3 text-prompt predictor factory (None clears)."""
    global _TEXT_PREDICTOR_FACTORY
    if fn is None:
        _legacy_clear("text")
        _TEXT_PREDICTOR_FACTORY = None
        return
    _legacy_variant()._text_impl = fn
    _TEXT_PREDICTOR_FACTORY = fn


def get_text_predictor() -> TextPredictor:
    """Return the registered SAM 3 text predictor; RuntimeError when unset."""
    if _TEXT_PREDICTOR_FACTORY is None:
        raise RuntimeError("text predictor not configured")
    return _TEXT_PREDICTOR_FACTORY


def reset_text_predictor() -> None:
    """Clear the text predictor factory. Used by tests."""
    global _TEXT_PREDICTOR_FACTORY
    _legacy_clear("text")
    _TEXT_PREDICTOR_FACTORY = None


def set_visual_predictor(factory: Any) -> None:
    """Register the SAM 3.1 visual-prompt predictor factory (None clears)."""
    global _VISUAL_PREDICTOR_FACTORY
    if factory is None:
        _legacy_clear("visual")
        _VISUAL_PREDICTOR_FACTORY = None
        return
    _legacy_variant()._visual_impl = factory
    _VISUAL_PREDICTOR_FACTORY = factory


def get_visual_predictor() -> Any:
    """Return the registered SAM 3.1 visual predictor; RuntimeError when unset."""
    if _VISUAL_PREDICTOR_FACTORY is None:
        raise RuntimeError("sam_visual_predictor_not_loaded")
    return _VISUAL_PREDICTOR_FACTORY


def _reset_visual_predictor_for_test() -> None:
    """Clear the visual predictor factory. Used by tests."""
    global _VISUAL_PREDICTOR_FACTORY
    _legacy_clear("visual")
    _VISUAL_PREDICTOR_FACTORY = None


def set_vlm_fo1_filter(fn: VlmFo1Filter | None) -> None:
    """Register the VLM-FO1 precision filter (None clears).

    Consulted at /sam/text-prompt time only when the request sets
    ``use_vlm_fo1=True`` and a filter is registered.
    """
    global _VLM_FO1_FILTER
    _VLM_FO1_FILTER = fn


def get_vlm_fo1_filter() -> VlmFo1Filter | None:
    """Return the registered VLM-FO1 filter, or None. Does NOT raise."""
    return _VLM_FO1_FILTER


def reset_vlm_fo1_filter() -> None:
    """Clear the VLM-FO1 filter slot. Used by tests."""
    global _VLM_FO1_FILTER
    _VLM_FO1_FILTER = None


def set_box_predictor(fn: BoxPredictor | None) -> None:
    """Register the SAM 3 box-prompt predictor factory (None clears)."""
    global _BOX_PREDICTOR_FACTORY
    if fn is None:
        _legacy_clear("box")
        _BOX_PREDICTOR_FACTORY = None
        return
    _legacy_variant()._box_impl = fn
    _BOX_PREDICTOR_FACTORY = fn


def get_box_predictor() -> BoxPredictor:
    """Return the registered SAM 3 box predictor; RuntimeError when unset."""
    if _BOX_PREDICTOR_FACTORY is None:
        raise RuntimeError("box predictor not configured")
    return _BOX_PREDICTOR_FACTORY


def reset_box_predictor() -> None:
    """Clear the box predictor factory. Used by tests."""
    global _BOX_PREDICTOR_FACTORY
    _legacy_clear("box")
    _BOX_PREDICTOR_FACTORY = None


def extract_embedding(predictor: Any) -> bytes | None:
    """Return the predictor's image embedding as float16 bytes, or None.

    Real SAM 2 predictors store features on ``_features['image_embed']``
    after ``set_image()`` runs; this helper casts to float16 CPU bytes
    for the browser-side ONNX decoder.

    Returns ``None`` when the predictor doesn't expose ``_features`` or
    the conversion fails — callers treat that as "fall back to
    server-side decode".
    """
    feats = getattr(predictor, "_features", None)
    if not isinstance(feats, dict):
        return None
    embed = feats.get("image_embed")
    if embed is None:
        return None
    try:
        import torch  # type: ignore[import-not-found]
        return embed.detach().to(dtype=torch.float16, device="cpu").numpy().tobytes()
    except Exception:
        try:
            arr = embed.detach().to(dtype="float16", device="cpu").numpy()
            return arr.tobytes()
        except Exception:
            return None
