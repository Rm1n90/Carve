"""SAM predictor singleton with test injection hook.

Production calls ``_get_predictor()`` lazily on first request. The default
factory imports SAM 2 and downloads the configured checkpoint, which is
deferred until then. Tests call ``set_test_predictor()`` to inject a stub
without ever importing SAM 2 or Torch.

The SAM 3 text-prompt predictor uses a separate, optional factory that the
operator wires at container start when ``SAM_MODEL=sam3`` (or the legacy
``SAM_VARIANT=sam3`` from Plan 08). The actual SAM 3 model is gated on
Hugging Face and is not loaded here — see ``apps/docs/admin.md`` for the
operator setup.
"""

import contextlib
import logging
import os
import threading
import time
from typing import Any, Callable, Iterator, Protocol

log = logging.getLogger(__name__)


# Allowed values for SAM_MODEL. Keep this in lockstep with the README and
# the .env.example. Order matches the size progression for readability.
ALLOWED_SAM_MODELS = (
    "sam2.1-tiny",
    "sam2.1-small",
    "sam2.1-base-plus",
    "sam2.1-large",
    "sam3",
)
DEFAULT_SAM_MODEL = "sam2.1-large"

# Hugging Face repo ids for each variant. The four sam2.1 entries follow
# the canonical naming on HF; sam3 is a separate (gated) repo whose
# weights are loaded by the operator-registered SAM 3 text predictor.
_HF_REPO_BY_MODEL = {
    "sam2.1-tiny":      "facebook/sam2.1-hiera-tiny",
    "sam2.1-small":     "facebook/sam2.1-hiera-small",
    "sam2.1-base-plus": "facebook/sam2.1-hiera-base-plus",
    "sam2.1-large":     "facebook/sam2.1-hiera-large",
    "sam3":             "facebook/sam3",
}


def get_sam_model() -> str:
    """Return the configured SAM model id.

    Reads ``SAM_MODEL`` first; falls back to the legacy ``SAM_VARIANT`` env
    (Plan 08) so existing operator setups don't break. Defaults to
    ``DEFAULT_SAM_MODEL``. Unknown values fall back to the default with a
    one-line warning.
    """
    raw = os.getenv("SAM_MODEL") or os.getenv("SAM_VARIANT") or DEFAULT_SAM_MODEL
    # Backward compat: SAM_VARIANT=sam2 (no size) → use the default size.
    if raw == "sam2":
        raw = DEFAULT_SAM_MODEL
    if raw not in ALLOWED_SAM_MODELS:
        log.warning("unknown SAM_MODEL=%r; falling back to %s", raw, DEFAULT_SAM_MODEL)
        return DEFAULT_SAM_MODEL
    return raw


def get_sam_variant() -> str:
    """Return ``"sam3"`` if SAM 3 is selected, otherwise ``"sam2"``.

    Preserves the Plan 08 contract used by the SAM 3 text-prompt 409 gate.
    """
    return "sam3" if get_sam_model() == "sam3" else "sam2"


# --- bf16 autocast gate -----------------------------------------------------
#
# Wrapping SAM forward passes in ``torch.autocast(cuda, bfloat16)`` roughly
# halves VRAM and ~doubles throughput on Ampere+ GPUs (RTX 30/40, A100,
# H100), with no measurable accuracy loss for SAM 2 (well-tested upstream).
# We gate on the env toggle + hardware capability so the wrap becomes a
# no-op when torch is missing (the model dev venv has no torch), CUDA
# isn't available, or the GPU pre-dates Ampere. The wrap also fails open
# on any torch error so autocast itself can never crash inference.

_TRUTHY_BF16 = ("1", "true", "yes", "on")


def use_bf16() -> bool:
    """Return True when bf16 autocast should be applied to SAM inference.

    Combines the ``SAM_BF16`` env toggle (default ``1`` = enabled) with
    runtime hardware capability. Operators set ``SAM_BF16=0`` to force
    fp32 for debugging.
    """
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

    No-op when CUDA or bf16 are unavailable. The context manager is safe
    to call from any thread; PyTorch's autocast is thread-local. Fails
    open on any torch error so autocast itself can never crash inference.
    """
    if not use_bf16():
        yield
        return
    try:
        import torch  # type: ignore[import-not-found]

        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
            yield
    except Exception:
        # Fail open — never break inference because autocast errored.
        yield


# --- torch.compile gate -----------------------------------------------------
#
# ``torch.compile(model, mode="reduce-overhead")`` traces the SAM forward
# pass through TorchInductor and yields ~1.3-2x speedups after a one-time
# 30-60s warmup. It requires CUDA + a working triton/inductor backend, so
# we gate it behind the env toggle and fail open at compile time on any
# error (some hardware/driver combinations don't support it). Default OFF
# because the warmup cost is not worth it for short dev sessions.

_TRUTHY_COMPILE = ("1", "true", "yes", "on")


def use_compile() -> bool:
    """Return True when the loaded SAM model should be wrapped in torch.compile."""
    if os.getenv("SAM_COMPILE", "0") not in _TRUTHY_COMPILE:
        return False
    try:
        import torch  # type: ignore[import-not-found]

        # torch.compile requires CUDA + a working triton/inductor backend.
        # We don't probe further — fail open at compile time.
        return torch.cuda.is_available()
    except Exception:
        return False


def maybe_compile(model: Any) -> Any:
    """Return ``torch.compile(model, mode="reduce-overhead")`` if enabled, else ``model``.

    Best-effort: if ``torch.compile`` raises (hardware/driver
    incompatibility, missing triton, etc.), log a warning and return the
    uncompiled model. The compiled model is a drop-in replacement at the
    call sites we use (``predict`` / ``propagate_in_video``).
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


class SamPredictor(Protocol):
    """Duck type matching the parts of SAM2ImagePredictor we use."""

    def set_image(self, image: Any) -> None: ...

    def predict(
        self,
        point_coords: Any,
        point_labels: Any,
        multimask_output: bool = True,
    ) -> tuple[Any, Any, Any]: ...


# A SAM 3 text-prompt predictor is any callable with this signature. It
# accepts a base64-encoded image plus a free-form text query and returns
# zero or more candidate masks in ``{counts, size, score, bbox}`` form.
TextPredictor = Callable[..., list[dict]]

# A SAM 3 box-prompt predictor is any callable that accepts a base64
# image plus boxes (xyxy floats), per-box labels (1=positive, 0=negative),
# and an optional text concept to combine with the boxes. Returns the
# same ``{counts, size, score, bbox}`` shape as the text predictor.
BoxPredictor = Callable[..., list[dict]]


_PREDICTOR: SamPredictor | None = None
_TEST_PREDICTOR: SamPredictor | None = None
_TEXT_PREDICTOR_FACTORY: TextPredictor | None = None
_BOX_PREDICTOR_FACTORY: BoxPredictor | None = None

# --- idle eviction state ----------------------------------------------------
#
# The SAM image predictor pins ~1-3 GB of GPU memory. When the operator
# steps away for a while, that memory should be released so other
# workloads (YOLO training, video encode jobs) can use the GPU. The
# sweep runs every 60s in main.py's lifespan thread.

_PREDICTOR_LAST_USED: float = 0.0  # epoch seconds (monotonic clock)
_PREDICTOR_LOCK = threading.Lock()

DEFAULT_SAM_IDLE_TIMEOUT_S = 15 * 60  # 15 minutes


def _idle_timeout_s() -> int:
    """Return the configured idle timeout in seconds (0 disables eviction).

    Reads ``SAM_IDLE_TIMEOUT_S``; falls back to ``DEFAULT_SAM_IDLE_TIMEOUT_S``
    on parse error. Negative values clamp to 0 (disabled).
    """
    raw = os.getenv("SAM_IDLE_TIMEOUT_S", str(DEFAULT_SAM_IDLE_TIMEOUT_S))
    try:
        v = int(raw)
        return max(0, v)
    except ValueError:
        return DEFAULT_SAM_IDLE_TIMEOUT_S


def touch_predictor() -> None:
    """Update the predictor's last-used timestamp. Called on every inference."""
    global _PREDICTOR_LAST_USED
    _PREDICTOR_LAST_USED = time.monotonic()


def _empty_cuda_cache() -> None:
    """Best-effort ``torch.cuda.empty_cache()`` — silent on failure.

    Torch is an optional dep in the model dev venv (used only when CUDA is
    actually available at runtime). All access is guarded so the eviction
    path never crashes when torch is absent.
    """
    try:
        import torch  # type: ignore[import-not-found]

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def evict_predictor_if_idle() -> bool:
    """Free the singleton + GPU memory if idle longer than ``SAM_IDLE_TIMEOUT_S``.

    Returns ``True`` when eviction happened. No-op when the predictor isn't
    loaded, the timeout is 0 (disabled), or the last-used timestamp is
    within the timeout window.
    """
    timeout = _idle_timeout_s()
    if timeout == 0:
        return False
    with _PREDICTOR_LOCK:
        global _PREDICTOR
        if _PREDICTOR is None:
            return False
        if (time.monotonic() - _PREDICTOR_LAST_USED) < timeout:
            return False
        _PREDICTOR = None
    _empty_cuda_cache()
    return True


def force_evict_predictor() -> bool:
    """Unconditionally free the singleton + GPU memory.

    Returns ``True`` when something was actually evicted, ``False`` when
    the predictor wasn't loaded (idempotent — safe to call repeatedly).
    """
    with _PREDICTOR_LOCK:
        global _PREDICTOR
        if _PREDICTOR is None:
            return False
        _PREDICTOR = None
    _empty_cuda_cache()
    return True


# --- runtime variant switching --------------------------------------------
#
# v3.0 Bug 7: operators (and end users with the right role) can swap SAM
# variants without restarting the model container. The flow is:
#
#   1. POST /sam/switch  →  load_predictor(variant)
#   2. evict the current predictor (if any) + free GPU memory
#   3. set ``SAM_MODEL`` in-process so ``_default_factory`` reads the new
#      variant on the next ``get_predictor()`` call
#   4. eagerly build the new predictor under ``_PREDICTOR_LOCK`` so we
#      surface load failures synchronously to the caller (5-30s).


def load_predictor(variant: str) -> None:
    """Switch the active SAM variant. Idempotent on the current variant.

    - Validates the variant against ``ALLOWED_SAM_MODELS``; raises ``ValueError``.
    - No-op when ``variant`` already matches the configured model AND a
      predictor is already loaded. (When no predictor is loaded yet but
      the env already matches, we still skip the eager build — the next
      inference call will lazy-build it.)
    - Otherwise: evicts the existing predictor, updates ``SAM_MODEL`` in
      ``os.environ`` so ``_default_factory()`` picks up the new value, and
      eagerly builds the new predictor so load failures surface to the
      caller (rather than to the next encode/decode request).

    Concurrent calls serialise on ``_PREDICTOR_LOCK``. Test-injected
    predictors are left untouched — switching during a test would clobber
    the fake the test registered.
    """
    if variant not in ALLOWED_SAM_MODELS:
        raise ValueError(
            f"unknown SAM variant {variant!r}; "
            f"allowed: {', '.join(ALLOWED_SAM_MODELS)}"
        )

    # Test-injected predictors take priority — switching is a no-op so
    # tests don't have to special-case this path. We still update
    # ``SAM_MODEL`` so ``get_sam_model()`` reflects the requested variant
    # for any subsequent assertions.
    if _TEST_PREDICTOR is not None:
        os.environ["SAM_MODEL"] = variant
        return

    current = get_sam_model()
    with _PREDICTOR_LOCK:
        global _PREDICTOR
        if variant == current and _PREDICTOR is not None:
            # Already on the requested variant with a loaded predictor.
            return
        # Drop the existing singleton; we'll rebuild below.
        _PREDICTOR = None

    # Free GPU memory outside the lock so other threads can read state.
    _empty_cuda_cache()

    # Update the env so ``_default_factory()`` and ``get_sam_model()``
    # reflect the new variant on subsequent calls. Legacy ``SAM_VARIANT``
    # is intentionally not touched — operators who set it explicitly keep
    # their override; ``SAM_MODEL`` wins in ``get_sam_model``.
    os.environ["SAM_MODEL"] = variant

    # Eagerly build the new predictor so load failures surface here
    # rather than on the next inference request.
    with _PREDICTOR_LOCK:
        _PREDICTOR = _default_factory()
        touch_predictor()


def set_test_predictor(p: SamPredictor | None) -> None:
    """Inject a stub for tests; pass None to clear."""
    global _TEST_PREDICTOR
    _TEST_PREDICTOR = p
    # Reset the production singleton too so subsequent tests don't see a stale state
    _reset_singleton()


def _reset_singleton() -> None:
    global _PREDICTOR
    _PREDICTOR = None


def _default_factory() -> SamPredictor:
    """Production factory: load the configured SAM image predictor.

    Imports torch + sam2/transformers lazily so the test path stays
    import-free. Pulls the HF repo id from ``get_sam_model()``. When
    ``SAM_MODEL=sam3`` is selected, builds the SAM 3 adapter via
    ``carve_model.sam.sam3_adapter`` and (as a side effect) registers the
    SAM 3 text predictor for ``/sam/text-prompt`` if the operator has not
    already supplied a custom one.

    For SAM 2.x variants the backend is selected by ``SAM2_BACKEND``:
    ``transformers`` routes through ``carve_model.sam.sam2_adapter``,
    while the default ``legacy`` keeps the existing ``sam2`` git package
    path. The flag exists so the new transformers-backed code path can
    soak in production behind a feature toggle before becoming default
    in v3.4 commit 5.
    """
    model = get_sam_model()
    if model == "sam3":
        from carve_model.sam import sam3_adapter

        adapter = sam3_adapter.build_sam3_image_predictor()
        # Side effect: ensure /sam/text-prompt has a working predictor.
        # If the operator pre-registered a custom one, leave it alone.
        if _TEXT_PREDICTOR_FACTORY is None:
            set_text_predictor(sam3_adapter.make_sam3_text_predictor())
        # Side effect: ensure /sam/box-prompt has a working predictor.
        # If the operator pre-registered a custom one, leave it alone.
        if _BOX_PREDICTOR_FACTORY is None:
            set_box_predictor(sam3_adapter.make_sam3_box_predictor())
        return adapter

    # SAM 2.x: opt in to the transformers adapter via SAM2_BACKEND.
    # Default ``legacy`` preserves the existing sam2 git package path.
    if model.startswith("sam2") and os.getenv("SAM2_BACKEND", "legacy") == "transformers":
        from carve_model.sam import sam2_adapter

        return sam2_adapter.build_sam2_image_predictor(model)

    repo = _HF_REPO_BY_MODEL[model]

    import torch  # type: ignore[import-not-found]
    from sam2.sam2_image_predictor import SAM2ImagePredictor  # type: ignore[import-not-found]

    p = SAM2ImagePredictor.from_pretrained(repo)
    p.model.to("cuda" if torch.cuda.is_available() else "cpu")
    p.model = maybe_compile(p.model)
    return p


def get_predictor() -> SamPredictor:
    """Return the active predictor: test-injected if set, otherwise the lazily
    loaded production singleton.

    Updates the last-used timestamp for the production path so the idle
    sweeper can decide when to evict. The test-injected predictor skips
    the touch — tests don't care about idle bookkeeping.
    """
    if _TEST_PREDICTOR is not None:
        return _TEST_PREDICTOR
    with _PREDICTOR_LOCK:
        global _PREDICTOR
        if _PREDICTOR is None:
            _PREDICTOR = _default_factory()
        touch_predictor()
        return _PREDICTOR


def set_text_predictor(fn: TextPredictor | None) -> None:
    """Register the SAM 3 text-prompt predictor factory.

    Pass ``None`` to clear (used by tests). The operator calls this once at
    container start when ``SAM_VARIANT=sam3``; tests pass a fake.
    """
    global _TEXT_PREDICTOR_FACTORY
    _TEXT_PREDICTOR_FACTORY = fn


def get_text_predictor() -> TextPredictor:
    """Return the registered SAM 3 text predictor.

    Raises ``RuntimeError`` if no factory was registered. Callers should
    convert this into a 503 ``sam3_predictor_not_loaded`` HTTP error.
    """
    if _TEXT_PREDICTOR_FACTORY is None:
        raise RuntimeError("text predictor not configured")
    return _TEXT_PREDICTOR_FACTORY


def reset_text_predictor() -> None:
    """Clear the text predictor factory. Used by tests."""
    global _TEXT_PREDICTOR_FACTORY
    _TEXT_PREDICTOR_FACTORY = None


def set_box_predictor(fn: BoxPredictor | None) -> None:
    """Register the SAM 3 box-prompt predictor factory.

    Pass ``None`` to clear (used by tests). The operator wires this
    automatically via ``_default_factory()`` when ``SAM_MODEL=sam3``;
    tests inject a fake.
    """
    global _BOX_PREDICTOR_FACTORY
    _BOX_PREDICTOR_FACTORY = fn


def get_box_predictor() -> BoxPredictor:
    """Return the registered SAM 3 box predictor.

    Raises ``RuntimeError`` if no factory was registered. Callers should
    convert this into a 503 ``sam3_box_predictor_not_loaded`` HTTP error.
    """
    if _BOX_PREDICTOR_FACTORY is None:
        raise RuntimeError("box predictor not configured")
    return _BOX_PREDICTOR_FACTORY


def reset_box_predictor() -> None:
    """Clear the box predictor factory. Used by tests."""
    global _BOX_PREDICTOR_FACTORY
    _BOX_PREDICTOR_FACTORY = None


def extract_embedding(predictor: Any) -> bytes | None:
    """Return the predictor's image embedding as float16 bytes, or None.

    Real SAM 2 predictors store the encoded image features on
    ``_features["image_embed"]`` (a torch.Tensor) after ``set_image()`` runs.
    This helper extracts that tensor, casts it to float16 on CPU, and
    returns its raw bytes. The browser-side ONNX decoder consumes those
    bytes directly via ``Float16Array``.

    Returns ``None`` when the predictor doesn't expose ``_features`` (e.g.
    the test fake) or when the tensor cannot be converted (e.g. torch
    unavailable). Callers treat ``None`` as "fall back to server-side
    decode".
    """
    feats = getattr(predictor, "_features", None)
    if not isinstance(feats, dict):
        return None
    embed = feats.get("image_embed")
    if embed is None:
        return None
    try:
        # torch is only required when a real predictor is loaded; the
        # conditional import keeps test predictors torch-free.
        import torch  # type: ignore[import-not-found]

        return embed.detach().to(dtype=torch.float16, device="cpu").numpy().tobytes()
    except Exception:
        # Best-effort fallback for predictors whose tensor mimics the API
        # but doesn't need torch (used by tests).
        try:
            arr = embed.detach().to(dtype="float16", device="cpu").numpy()
            return arr.tobytes()
        except Exception:
            return None
