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
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterator, Literal, Protocol

log = logging.getLogger(__name__)


# Allowed values for SAM_MODEL. Keep this in lockstep with the README and
# the .env.example. Order matches the size progression for readability.
ALLOWED_SAM_MODELS = (
    "sam2.1-tiny",
    "sam2.1-small",
    "sam2.1-base-plus",
    "sam2.1-large",
    "sam3",
    "sam3.1",
)
DEFAULT_SAM_MODEL = "sam2.1-large"

# Hugging Face repo ids for each variant. The four sam2.1 entries follow
# the canonical naming on HF; sam3 / sam3.1 are gated repos. The
# ``facebook/sam3.1`` repo is checkpoint-only (single multiplex .pt; no
# transformers safetensors), so the IMAGE-side path keeps using the
# transformers-loadable ``facebook/sam3`` weights — image segmentation
# quality is unchanged between sam3 and sam3.1. The video-side multiplex
# tracker reads its own checkpoint via the native ``sam3`` git package
# (Plan 11 Track B); see ``tracker._default_factory``'s sam3.1 branch.
_HF_REPO_BY_MODEL = {
    "sam2.1-tiny":      "facebook/sam2.1-hiera-tiny",
    "sam2.1-small":     "facebook/sam2.1-hiera-small",
    "sam2.1-base-plus": "facebook/sam2.1-hiera-base-plus",
    "sam2.1-large":     "facebook/sam2.1-hiera-large",
    "sam3":             "facebook/sam3",
    "sam3.1":           "facebook/sam3",
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
    return "sam3" if get_sam_model() in ("sam3", "sam3.1") else "sam2"


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


# --- SamSession ------------------------------------------------------------
#
# v3.5 Phase A1 — the SAM image predictor + the metadata for the most
# recently encoded image (hash + shape) live together in a single
# ``SamSession`` object. Lifecycle ops (evict, force-evict, variant
# switch) replace ``_SESSION`` atomically, so the loaded_hash field is
# guaranteed to clear whenever the predictor is reset. Previously the
# predictor was a module global and ``_LOADED_HASH`` lived in router.py
# as a separate global; that split caused the v3.4 desync where
# ``/sam/decode`` passed the hash gate but called a fresh predictor whose
# ``set_image`` had not been called yet — a 500 with
# ``set_image must be called before predict``.
#
# ``_PREDICTOR`` and ``_PREDICTOR_LAST_USED`` are kept as compatibility
# shims for existing tests that poke them directly; both proxy through
# the session via the ``_get_predictor_compat`` / ``_set_predictor_compat``
# pair below.


@dataclass
class SamSession:
    """Atomic bundle of (predictor, encoded-image metadata, last-used clock).

    A single session represents "the SAM image predictor with this image
    loaded into it". Replacing the session — eviction, idle sweep,
    variant switch — drops both the predictor reference and any
    associated image-hash bookkeeping in one step, eliminating the v3.4
    desync where the router believed an image was loaded but the
    predictor's internal ``_raw_image`` had been cleared.
    """

    predictor: Any
    loaded_hash: str | None = None
    loaded_shape: list[int] = field(default_factory=list)
    last_used_at: float = 0.0
    # v3.4.1 Plan 11 Task 2 — build key captures (model_name, dtype, attn_impl)
    # at predictor construction so the cache can detect env-driven drift and
    # rebuild on the next get_predictor() call.
    build_key: tuple[str, str, str] | None = None
    # v3.22 — SAM 2 iterative refinement state. ``prev_low_res_logits``
    # is a torch tensor of shape ``[1, 1, 1, 256, 256]`` (the chosen
    # mask channel from the previous /sam/decode call) that the router
    # feeds back as ``input_masks`` so a multi-click chain refines the
    # SAME mask instead of producing 3 fresh interpretations on each
    # call. ``prev_n_points`` lets the router detect undo (point-count
    # decreased → drop the prev so the new prompt is a fresh start).
    # Both reset on /sam/encode (a new image starts a fresh chain).
    prev_low_res_logits: Any | None = None
    prev_n_points: int = 0


# A VLM-FO1 precision filter is any callable matching the
# ``carve_model.vlm_fo1.adapter.VlmFo1Filter`` Protocol — accepts
# ``(image, text, boxes)`` and returns a list of indexes into ``boxes``
# that the model judges to match ``text``. Stored as a plain Callable
# here to avoid pulling the vlm_fo1 module into predictor's import
# graph (the dev path stays import-clean).
VlmFo1Filter = Callable[..., list[int]]


_SESSION: SamSession | None = None
_TEST_PREDICTOR: SamPredictor | None = None
_TEXT_PREDICTOR_FACTORY: TextPredictor | None = None
_BOX_PREDICTOR_FACTORY: BoxPredictor | None = None
# v3.28 — visual prompt predictor (sam3p1 only). See spec §5.7.
VisualPredictor = Any  # callable: (*, target_b64, refer_b64, regions) -> list[dict]
_VISUAL_PREDICTOR_FACTORY: VisualPredictor | None = None
# v3.21+ — VLM-FO1 precision filter slot. ``None`` means the operator
# has not opted in (or the feature gate is off). The text predictor
# closure reads this at call time, only consulted when the request
# carries ``use_vlm_fo1=True``.
_VLM_FO1_FILTER: VlmFo1Filter | None = None


# --- load-state machine (v3.5 Phase C) -------------------------------------
#
# Surfaces "is the SAM predictor loading right now?" to the editor UI so
# users see a progress overlay during the 5-30s HF weight download / build.
# The state is a small dataclass mutated by ``get_predictor`` (lazy build),
# ``load_predictor`` (variant switch), and ``force_evict_predictor`` (drop).
# The router exposes a snapshot via ``GET /sam/status``; the API service
# proxies it via ``GET /models/sam-status`` for the frontend.

LoadStateKind = Literal["idle", "loading", "ready", "error"]


@dataclass
class LoadState:
    """Snapshot of the predictor's current load lifecycle.

    States:
      idle    — no predictor loaded, no load in progress
      loading — predictor is being initialised (HF download or build)
      ready   — predictor loaded; ``loaded_at`` is the ISO8601 timestamp
      error   — last load attempt failed; ``error`` carries the detail
    """

    kind: LoadStateKind = "idle"
    variant: str | None = None
    progress_bytes: int | None = None
    progress_total: int | None = None
    loaded_at: str | None = None
    error: str | None = None
    job_id: str | None = None


_LOAD_STATE: LoadState = LoadState()
_LOAD_STATE_LOCK = threading.Lock()


def get_load_state() -> LoadState:
    """Return a snapshot of the current load state.

    Callers (router) should treat the return value as read-only. Mutate
    via ``_set_load_state`` only — it serialises on ``_LOAD_STATE_LOCK``.
    """
    return _LOAD_STATE


def _set_load_state(**kwargs: Any) -> LoadState:
    """Replace ``_LOAD_STATE`` with a new ``LoadState`` carrying ``kwargs``.

    Any field not passed defaults to the dataclass default, NOT the
    previous value — callers should pass the full intended snapshot.
    Returns the new state for convenience.
    """
    global _LOAD_STATE
    with _LOAD_STATE_LOCK:
        _LOAD_STATE = LoadState(**kwargs)
        return _LOAD_STATE


def _reset_load_state() -> None:
    """Test helper: drop the load state machine back to idle."""
    global _LOAD_STATE
    with _LOAD_STATE_LOCK:
        _LOAD_STATE = LoadState()


def _set_load_progress(
    progress_bytes: int | None,
    progress_total: int | None,
) -> None:
    """Patch only the progress fields on the current ``_LOAD_STATE``.

    Unlike ``_set_load_state``, callers don't need to pass the full
    snapshot — kind/variant/job_id/etc. are preserved. Used by the SAM 2
    / SAM 3 adapters at the start and end of ``from_pretrained`` so the
    overlay can show a "downloading" indicator.

    v3.6 MVP: we set the indeterminate sentinel (``progress_bytes=0`` +
    ``progress_total=-1``) at the start of a build and clear both back
    to ``None`` when the build completes. The overlay treats
    ``progress_total <= 0`` as "indeterminate", so the shimmer keeps
    going without claiming a fake percentage. Real byte progress can
    replace this once a HF tqdm callback hook is wired in (see C3 audit
    note in the v3.6 ship summary).
    """
    global _LOAD_STATE
    with _LOAD_STATE_LOCK:
        current = _LOAD_STATE
        _LOAD_STATE = LoadState(
            kind=current.kind,
            variant=current.variant,
            progress_bytes=progress_bytes,
            progress_total=progress_total,
            loaded_at=current.loaded_at,
            error=current.error,
            job_id=current.job_id,
        )

# --- idle eviction state ----------------------------------------------------
#
# The SAM image predictor pins ~1-3 GB of GPU memory. When the operator
# steps away for a while, that memory should be released so other
# workloads (YOLO training, video encode jobs) can use the GPU. The
# sweep runs every 60s in main.py's lifespan thread.

_PREDICTOR_LOCK = threading.Lock()


def get_session() -> SamSession | None:
    """Return the current session, or ``None`` if no predictor is loaded.

    Used by the router to read the loaded image's hash and shape. The
    return value is the live session — callers should treat it as
    read-only. Mutate session metadata via ``set_loaded_image`` only.
    """
    return _SESSION


def _set_test_session(predictor: Any, *, last_used_at: float | None = None) -> None:
    """Test-only helper: install a session with the given predictor.

    Replaces the ``_PREDICTOR = object()`` pattern that the pre-v3.5
    tests used. Allows callers to override ``last_used_at`` for idle
    eviction tests.
    """
    global _SESSION
    if predictor is None:
        _SESSION = None
        return
    _SESSION = SamSession(
        predictor=predictor,
        last_used_at=time.monotonic() if last_used_at is None else last_used_at,
    )


def __getattr__(name: str) -> Any:
    """Backward-compat read access to the legacy module globals.

    The pre-v3.5 tests inspect ``p_mod._PREDICTOR`` and
    ``p_mod._PREDICTOR_LAST_USED`` directly. Reads still work via this
    fallback hook (PEP 562) — writes go through ``_set_test_session``.
    """
    if name == "_PREDICTOR":
        return _SESSION.predictor if _SESSION is not None else None
    if name == "_PREDICTOR_LAST_USED":
        return _SESSION.last_used_at if _SESSION is not None else 0.0
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def set_loaded_image(image_hash: str, shape: list[int]) -> None:
    """Record the image hash + shape on the active session.

    Called by ``/sam/encode`` after ``predictor.set_image`` succeeds, so
    a subsequent ``/sam/decode`` can verify the cached hash matches.
    Raises ``RuntimeError`` if no session is active (caller bug — encode
    must have built the session via ``get_predictor()`` first).

    Preserves ``last_used_at`` — encode is itself an inference touch
    (``get_predictor`` already updated the clock); resetting again here
    would break the idle eviction tests that backdate the timestamp.

    v3.22 — drops ``prev_low_res_logits`` / ``prev_n_points`` because a
    new image starts a fresh refinement chain (the previous logits are
    spatial — they're tied to the old image's coordinates).
    """
    global _SESSION
    if _SESSION is None:
        raise RuntimeError("no active SAM session; call get_predictor() first")
    _SESSION = SamSession(
        predictor=_SESSION.predictor,
        loaded_hash=image_hash,
        loaded_shape=list(shape),
        last_used_at=_SESSION.last_used_at,
    )


def set_prev_logits(low_res_logits: Any | None, n_points: int) -> None:
    """Record the previous decode's low-res mask logits on the session.

    Called by ``/sam/decode`` after a successful predict, so the next
    refinement click feeds these logits as ``input_masks`` to the
    SAM 2 forward — matching the official SAM 2 / CVAT click chain.
    No-op when no session is active (defensive).

    ``low_res_logits`` is expected as a torch tensor of shape
    ``[1, 1, 1, 256, 256]`` (already sliced to the chosen channel).
    Pass ``None`` to clear (e.g. on undo).
    """
    global _SESSION
    if _SESSION is None:
        return
    _SESSION = SamSession(
        predictor=_SESSION.predictor,
        loaded_hash=_SESSION.loaded_hash,
        loaded_shape=list(_SESSION.loaded_shape),
        last_used_at=_SESSION.last_used_at,
        build_key=_SESSION.build_key,
        prev_low_res_logits=low_res_logits,
        prev_n_points=int(n_points),
    )

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
    """Update the predictor's last-used timestamp. Called on every inference.

    No-op when no session is loaded. The session is replaced with a copy
    that has a fresh ``last_used_at`` so the idle sweeper can decide
    when to evict.
    """
    global _SESSION
    if _SESSION is None:
        return
    _SESSION = SamSession(
        predictor=_SESSION.predictor,
        loaded_hash=_SESSION.loaded_hash,
        loaded_shape=list(_SESSION.loaded_shape),
        last_used_at=time.monotonic(),
    )


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
    """Free the session + GPU memory if idle longer than ``SAM_IDLE_TIMEOUT_S``.

    Returns ``True`` when eviction happened. No-op when no session is
    loaded, the timeout is 0 (disabled), or the last-used timestamp is
    within the timeout window. Clearing the session drops the predictor
    AND the loaded-image bookkeeping in one atomic step (Phase A1).
    """
    timeout = _idle_timeout_s()
    if timeout == 0:
        return False
    with _PREDICTOR_LOCK:
        global _SESSION
        if _SESSION is None:
            return False
        if (time.monotonic() - _SESSION.last_used_at) < timeout:
            return False
        _SESSION = None
    _empty_cuda_cache()
    _set_load_state()
    return True


def _gpu_used_bytes() -> int | None:
    """Best-effort current-process GPU memory (bytes), or None.

    Uses ``torch.cuda.memory_reserved`` because that's what the caching
    allocator actually holds from the driver — a much truer signal for
    eviction effectiveness than ``memory_allocated``.
    """
    try:
        import torch  # type: ignore[import-not-found]

        if not torch.cuda.is_available():
            return None
        return int(torch.cuda.memory_reserved())
    except Exception:  # noqa: BLE001
        return None


def force_evict_predictor() -> bool:
    """Scorched-earth GPU cleanup. Returns True if anything was freed.

    The original implementation only cleared ``_SESSION`` (the SAM image
    predictor). v3.22+ also drops:

      * ``_TEXT_PREDICTOR_FACTORY`` — closure-private ``Sam3Model`` /
        ``Sam3Processor`` cached after the first /sam/text-prompt call.
        Without dropping this the ~6 GB transformers SAM 3 weights stay
        resident even after every other "unload" path runs.
      * ``_BOX_PREDICTOR_FACTORY`` — same shape, used by /sam/box-prompt.
      * The sam3.1 native module-level singleton
        ``sam3p1_adapter._NATIVE_IMAGE_PREDICTOR`` — holds the multiplex
        ~5 GB checkpoint after the first /sam/encode + /sam/text-prompt.

    Then runs ``gc.collect()`` (forces Python to drop refs to the now-
    orphaned closures), ``torch.cuda.empty_cache()`` (returns memory to
    the allocator), and ``torch.cuda.ipc_collect()``. The next
    prompt/encode call rebuilds lazily.

    Resets the load-state machine to ``idle`` so ``GET /sam/status``
    reflects the unload.
    """
    import gc

    something_freed = False

    with _PREDICTOR_LOCK:
        global _SESSION, _TEXT_PREDICTOR_FACTORY, _BOX_PREDICTOR_FACTORY
        if _SESSION is not None:
            _SESSION = None
            something_freed = True
        if _TEXT_PREDICTOR_FACTORY is not None:
            _TEXT_PREDICTOR_FACTORY = None
            something_freed = True
        if _BOX_PREDICTOR_FACTORY is not None:
            _BOX_PREDICTOR_FACTORY = None
            something_freed = True

    # Drop the sam3.1 native singleton too (held outside _PREDICTOR_LOCK
    # by sam3p1_adapter — its own module-level state).
    try:
        from carve_model.sam.sam3p1_adapter import reset_native_image_predictor
        if reset_native_image_predictor():
            something_freed = True
    except Exception:  # noqa: BLE001 — sam3p1 import optional in test env
        pass

    # Force Python to actually drop references to the now-orphaned
    # closures so the underlying torch tensors become collectable. The
    # caching allocator sometimes needs multiple cycles to release a
    # segment back to the driver — circular refs (closure ↔ state-dict)
    # need a second gc pass, and the allocator's per-stream pools
    # benefit from a synchronize before each empty_cache so in-flight
    # kernels don't pin memory we just dropped.
    try:
        import torch  # type: ignore[import-not-found]
        cuda_available = torch.cuda.is_available()
    except Exception:  # noqa: BLE001
        torch = None  # type: ignore[assignment]
        cuda_available = False

    for _ in range(3):
        gc.collect()
        if cuda_available and torch is not None:
            try:
                torch.cuda.synchronize()
                torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001
                pass

    # Release any compile / dynamo caches the previous variant set up.
    # No-op when ``torch._dynamo`` isn't loaded (e.g. SAM_COMPILE=false).
    if torch is not None:
        try:
            import torch._dynamo  # type: ignore[import-not-found]
            torch._dynamo.reset()
        except Exception:  # noqa: BLE001
            pass

    # ipc_collect closes any IPC handles; cheap when none exist.
    if cuda_available and torch is not None:
        try:
            torch.cuda.ipc_collect()
        except Exception:  # noqa: BLE001
            pass

    if _LOAD_STATE.kind == "ready":
        _set_load_state()

    return something_freed


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
    global _SESSION
    if _TEST_PREDICTOR is not None:
        os.environ["SAM_MODEL"] = variant
        # Clear any prior session so the test fake's loaded-image state
        # doesn't leak across switches.
        with _PREDICTOR_LOCK:
            _SESSION = None
        # Reflect the test-fake "switch complete" in the status machine
        # so frontend polling tests see a ready state.
        _set_load_state(
            kind="ready",
            variant=variant,
            loaded_at=datetime.now(timezone.utc).isoformat(),
        )
        return

    current = get_sam_model()
    with _PREDICTOR_LOCK:
        if variant == current and _SESSION is not None:
            # Already on the requested variant with a loaded session.
            _set_load_state(
                kind="ready",
                variant=variant,
                loaded_at=datetime.now(timezone.utc).isoformat(),
            )
            return

    # v3.22 — variant change: scorched-earth eviction of the OLD variant
    # before bringing the new one up. Without this, switching sam3 →
    # sam3.1 left the sam3 transformers Sam3Model (~6 GB) cached in the
    # text-predictor closure AND loaded the sam3.1 multiplex (~5 GB) on
    # top, OOM-ing a 24 GB card with FO1 also resident.
    #
    # Two SAM variants must NEVER coexist on the GPU. ``force_evict_predictor``
    # drops _SESSION + _TEXT_PREDICTOR_FACTORY + _BOX_PREDICTOR_FACTORY +
    # the sam3.1 native module-level singleton, then runs gc.collect() +
    # empty_cache() + ipc_collect().
    force_evict_predictor()

    # Update the env so ``_default_factory()`` and ``get_sam_model()``
    # reflect the new variant on subsequent calls. Legacy ``SAM_VARIANT``
    # is intentionally not touched — operators who set it explicitly keep
    # their override; ``SAM_MODEL`` wins in ``get_sam_model``.
    os.environ["SAM_MODEL"] = variant

    # Flip the status machine to "loading" before the (potentially long)
    # build. The router-side worker thread also flips this — but doing it
    # here as well covers direct in-process callers (tests, internal
    # helpers) and keeps the contract idempotent.
    _set_load_state(kind="loading", variant=variant)

    # Eagerly build the new predictor so load failures surface here
    # rather than on the next inference request.
    try:
        with _PREDICTOR_LOCK:
            _SESSION = SamSession(
                predictor=_default_factory(),
                last_used_at=time.monotonic(),
            )
    except Exception as exc:
        _set_load_state(kind="error", variant=variant, error=str(exc))
        raise

    _set_load_state(
        kind="ready",
        variant=variant,
        loaded_at=datetime.now(timezone.utc).isoformat(),
    )


def set_test_predictor(p: SamPredictor | None) -> None:
    """Inject a stub for tests; pass None to clear."""
    global _TEST_PREDICTOR
    _TEST_PREDICTOR = p
    # Reset the production session too so subsequent tests don't see a
    # stale predictor or stale loaded-image state.
    _reset_singleton()


def _reset_singleton() -> None:
    """Reset the production session. Used by tests."""
    global _SESSION
    _SESSION = None
    _reset_load_state()


def _default_factory() -> SamPredictor:
    """Production factory: load the configured SAM image predictor.

    Imports torch + transformers lazily so the test path stays
    import-free. Pulls the HF repo id from ``get_sam_model()``.

    v3.25 — the device passed to each adapter comes from the central
    device manager: it reads the user's SAM preference (or "auto") and
    resolves it against the live probe so OOM / unavailable devices
    fall back transparently. Calling ``/devices/sam/reload`` after
    changing the preference triggers a fresh build on the new device.
    """
    # Lazy-import the device manager so the test path (no torch installed)
    # stays cheap; ``resolve_device`` itself degrades to "cpu" when torch
    # is absent.
    try:
        from carve_model import device_prefs
        from carve_model.devices import MIN_FREE_MB_DEFAULTS, resolve_device

        pref = device_prefs.get_pref("sam")
        resolved = resolve_device(
            pref, min_free_mb=MIN_FREE_MB_DEFAULTS["sam"]
        ).device
    except Exception:  # noqa: BLE001 — never block model load on resolver
        resolved = None

    # v3.25.3 — the SAM adapters (sam2, sam3, sam3p1 native) compare
    # ``self._device == "cuda"`` to gate the bf16 autocast block, AND
    # the native sam3 package's ``build_sam3_image_model(device=...)``
    # accepts plain "cuda" / "cpu" rather than "cuda:N". To honour a
    # ``cuda:1`` preference without touching every adapter, we:
    #   1) set the default CUDA device to N via ``torch.cuda.set_device``
    #      so all subsequent ``.cuda()`` calls and ``device="cuda"``
    #      strings land on cuda:N
    #   2) hand the adapters the bare "cuda" string they expect.
    # A "cpu" / "mps" / None pref passes through unchanged.
    sam_device: str | None = resolved
    if isinstance(resolved, str) and resolved.startswith("cuda:"):
        try:
            import torch  # type: ignore[import-not-found]

            idx = int(resolved.split(":", 1)[1])
            torch.cuda.set_device(idx)
            sam_device = "cuda"
        except Exception:  # noqa: BLE001
            log.warning(
                "sam: could not set CUDA index from %s; passing through",
                resolved,
            )
            sam_device = resolved

    model = get_sam_model()
    if model == "sam3.1":
        # Plan 12: native sam3 image predictor (point + box + text).
        from carve_model.sam import sam3_adapter, sam3p1_adapter

        adapter = sam3p1_adapter.build_sam3p1_image_predictor(device=sam_device)
        set_text_predictor(sam3p1_adapter.make_sam3p1_text_predictor())
        set_box_predictor(sam3p1_adapter.make_sam3p1_box_predictor())
        # v3.28 — visual prompt requires the native sam3p1 image adapter.
        # The factory lives in sam3_adapter.py because it composes both
        # variants' decode/RLE helpers; it builds its own sam3p1 adapter
        # internally for the encode pass.
        set_visual_predictor(sam3_adapter.make_sam3_visual_predictor())
        return adapter

    if model == "sam3":
        from carve_model.sam import sam3_adapter

        adapter = sam3_adapter.build_sam3_image_predictor(device=sam_device)
        set_text_predictor(sam3_adapter.make_sam3_text_predictor())
        set_box_predictor(sam3_adapter.make_sam3_box_predictor())
        # v3.28 — sam3 (transformers) variant does not expose the
        # backbone-features API the visual prompt factory needs. The
        # /sam/visual-prompt endpoint will 409 sam3p1_not_enabled if hit.
        return adapter

    if model.startswith("sam2"):
        from carve_model.sam import sam2_adapter

        return sam2_adapter.build_sam2_image_predictor(model, device=sam_device)

    raise ValueError(
        f"unknown SAM model {model!r}; "
        f"allowed: {', '.join(ALLOWED_SAM_MODELS)}"
    )


def _current_build_key() -> tuple[str, str, str]:
    """Return the current ``(model_name, str(dtype), attn_impl)`` cache key.

    Reads ``perf.get_dtype()`` and ``perf.get_attn_impl()`` lazily so the
    test path (no torch installed) doesn't import torch on module load.
    Falls back to a torch-free key when ``perf`` cannot be imported (e.g.
    in the dev venv with no torch / numpy).
    """
    model_name = get_sam_model()
    try:
        from carve_model.sam import perf

        return (model_name, str(perf.get_dtype()), perf.get_attn_impl())
    except Exception:
        return (model_name, "fp32", "sdpa")


def get_predictor() -> SamPredictor:
    """Return the active predictor: test-injected if set, otherwise the lazily
    loaded production singleton.

    Always ensures ``_SESSION`` reflects the active predictor so the
    router can read/write session metadata (the loaded image hash) via
    ``get_session`` / ``set_loaded_image`` regardless of whether we're
    in a test (with ``_TEST_PREDICTOR``) or production code path.

    Updates the last-used timestamp on the session so the idle sweeper
    can decide when to evict.
    """
    global _SESSION
    if _TEST_PREDICTOR is not None:
        # Make the session reflect the test predictor so the router's
        # set_loaded_image / get_session calls work uniformly.
        if _SESSION is None or _SESSION.predictor is not _TEST_PREDICTOR:
            _SESSION = SamSession(
                predictor=_TEST_PREDICTOR,
                last_used_at=time.monotonic(),
            )
            # The test path bypasses the load machinery, so make sure
            # the status machine still reads "ready" so
            # ``GET /sam/status`` callers see a consistent picture.
            _set_load_state(
                kind="ready",
                variant=get_sam_model(),
                loaded_at=datetime.now(timezone.utc).isoformat(),
            )
        return _TEST_PREDICTOR
    with _PREDICTOR_LOCK:
        # v3.4.1 Plan 11 Task 2 — drop a stale session when the active
        # build key (model, dtype, attn_impl) drifted out from under us
        # (operator changed SAM_DTYPE / SAM_ATTN_IMPL in-process). The
        # next branch then rebuilds via _default_factory().
        current_build_key = _current_build_key()
        if (
            _SESSION is not None
            and _SESSION.build_key is not None
            and _SESSION.build_key != current_build_key
        ):
            log.info(
                "SAM build key changed (%s -> %s); rebuilding predictor",
                _SESSION.build_key,
                current_build_key,
            )
            _SESSION = None
            _empty_cuda_cache()
        if _SESSION is None:
            # Lazy first build — flip the status to "loading" so the UI
            # can poll it. Releasing the lock before set_load_state would
            # leave a brief window where two threads race to build, but
            # the lock already prevents that — the second waiter spins
            # here and reads the freshly-built session.
            current_variant = get_sam_model()
            _set_load_state(kind="loading", variant=current_variant)
            try:
                _SESSION = SamSession(
                    predictor=_default_factory(),
                    last_used_at=time.monotonic(),
                    build_key=current_build_key,
                )
            except Exception as exc:
                _set_load_state(
                    kind="error",
                    variant=current_variant,
                    error=str(exc),
                )
                raise
            _set_load_state(
                kind="ready",
                variant=current_variant,
                loaded_at=datetime.now(timezone.utc).isoformat(),
            )
        else:
            _SESSION = SamSession(
                predictor=_SESSION.predictor,
                loaded_hash=_SESSION.loaded_hash,
                loaded_shape=list(_SESSION.loaded_shape),
                last_used_at=time.monotonic(),
            )
        return _SESSION.predictor


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


def set_visual_predictor(factory) -> None:
    """Register the SAM 3.1 visual-prompt predictor factory.

    Pass ``None`` to clear (used by tests). The operator calls this once at
    container start when ``SAM_MODEL=sam3.1``; tests pass a fake.
    """
    global _VISUAL_PREDICTOR_FACTORY
    _VISUAL_PREDICTOR_FACTORY = factory


def get_visual_predictor():
    """Return the registered SAM 3.1 visual predictor.

    Raises ``RuntimeError`` if no factory was registered. Callers should
    convert this into a 503 ``sam_visual_predictor_not_loaded`` HTTP error.
    """
    if _VISUAL_PREDICTOR_FACTORY is None:
        raise RuntimeError("sam_visual_predictor_not_loaded")
    return _VISUAL_PREDICTOR_FACTORY


def _reset_visual_predictor_for_test() -> None:
    """Clear the visual predictor factory. Used by tests."""
    global _VISUAL_PREDICTOR_FACTORY
    _VISUAL_PREDICTOR_FACTORY = None


def set_vlm_fo1_filter(fn: VlmFo1Filter | None) -> None:
    """Register the VLM-FO1 precision filter.

    Pass ``None`` to clear (used by tests). The operator wires this in
    ``carve_model.main:_lifespan`` when ``VLM_FO1_AVAILABLE=1`` —
    feature is OFF by default. The text predictor closure consults
    this at call time only when the request carries ``use_vlm_fo1=True``.
    """
    global _VLM_FO1_FILTER
    _VLM_FO1_FILTER = fn


def get_vlm_fo1_filter() -> VlmFo1Filter | None:
    """Return the registered VLM-FO1 filter, or ``None`` if unset.

    Unlike ``get_text_predictor`` this does NOT raise — VLM-FO1 is
    opt-in and absent-by-default; callers degrade to passthrough rather
    than failing the request.
    """
    return _VLM_FO1_FILTER


def reset_vlm_fo1_filter() -> None:
    """Clear the VLM-FO1 filter slot. Used by tests."""
    global _VLM_FO1_FILTER
    _VLM_FO1_FILTER = None


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
