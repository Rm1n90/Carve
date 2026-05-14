# SAM Lifecycle Manager — Design Spec

**Date:** 2026-05-14
**Status:** Approved (design); awaiting implementation plan
**Authors:** Armin Mehri, ECC pair session
**Scope:** `apps/model` (Carve model service) — image-side SAM lifecycle only

---

## 1. Context

The model service supports three SAM families: `sam2.1-*` (point/box only), `sam3` (transformers, text+point as two separate models), and `sam3.1` (native, all four modes in one model). Today the lifecycle of these models is spread across **three independent module-level singletons** in `apps/model/src/carve_model/sam/`:

| Singleton | Location | Used by | Cleared by idle sweeper? |
|---|---|---|---|
| `_SESSION.predictor` | `predictor.py:262` | `/sam/encode`, `/sam/decode` (point) via `get_predictor()` | ✅ yes |
| `_NATIVE_IMAGE_PREDICTOR` | `sam3p1_adapter.py:1217` | `/sam/text-prompt`, `/sam/box-prompt`, `/sam/visual-prompt` for sam3.1 | ❌ **no** |
| `_TEXT_PREDICTOR_FACTORY` / `_BOX_PREDICTOR_FACTORY` | `predictor.py:270-271` | Router closure registry, lazily builds `Sam3Model` for sam3 text | ❌ **no** |

These singletons are not aware of each other. For `sam3.1` they are *literally the same model class* loaded into two `Sam3p1NativeImagePredictorAdapter` instances (~5 GB each). On a 12 GB RTX 4070, doing auto-annotate (text) then a Smart-tool click (point) loads both copies → CUDA OOM.

### Bugs observed in production

1. **OOM on text→point on sam3.1.** `make_sam3p1_text_predictor()` (sam3p1_adapter.py:1335) calls `_get_or_build_native_image_predictor()`, creating a second sam3.1 instance alongside `_SESSION.predictor`.

2. **Memory not released after idle.** `evict_predictor_if_idle()` (predictor.py:533) only nulls `_SESSION`. The text/box factory closures and `_NATIVE_IMAGE_PREDICTOR` stay forever. Only the explicit `/sam/unload` (which runs `force_evict_predictor()`) clears them.

3. **Last-used clock never ticks for text/box paths.** Only `get_predictor()` calls `touch_predictor()`. A user who exclusively uses auto-annotate via `/sam/text-prompt` keeps `_SESSION.last_used_at` frozen — irrelevant only because that path doesn't use `_SESSION` at all.

4. **No "switch" atomicity across all singletons.** `load_predictor(variant)` calls `force_evict_predictor()` then builds new, but the inference paths each lazily build their own singleton with no cross-awareness. The variant in `os.environ["SAM_MODEL"]` is one source of truth; the resident models are another.

## 2. Goals

1. **At most one SAM variant resident on the GPU at any moment.** Switching variants drops the old completely before building the new.
2. **Idempotent reuse.** If the requested variant is already loaded, calls do nothing. If a different variant is requested, the old is fully unloaded + GPU memory released + new built.
3. **Idle eviction releases everything.** When the idle sweeper fires past timeout, all SAM weights and caches are dropped, gc runs, `torch.cuda.empty_cache()` + `ipc_collect` + `dynamo.reset` run. Same cleanup as today's manual `/sam/unload`.
4. **Strict serialization of inference.** Only one inference call at a time; concurrent requests queue. Eliminates the latent race on `Sam3p1NativeImagePredictorAdapter._state`.
5. **Single source of truth.** One manager object owns "which variant is loaded, when was it last used, what's its state." All routers, all background threads, all tests read/write through it.
6. **No HTTP contract changes.** `/sam/encode`, `/sam/decode`, `/sam/text-prompt`, `/sam/box-prompt`, `/sam/visual-prompt`, `/sam/status`, `/sam/unload`, `/sam/switch`, `/models/sam-active`, `/models/sam-status` keep their existing request/response shapes.

## 3. Non-goals

- Tracking sessions (`track_session.py`) — separate lifecycle, separate timeout, separate sweeper hook. Untouched.
- VLM-FO1 sidecar — separate container, separate GPU consumer. Untouched.
- YOLOE registry — already has its own correct idle eviction. Untouched.
- Cross-tool GPU budget coordinator — out of scope; future work if needed.
- Persisting variant state across container restarts — not needed; cold start is fast.
- A "warmup ping" from the UI to keep idle eviction at bay — explicit non-goal; rely on the 15-minute default and the lazy rebuild path.

## 4. Architectural decisions

| Decision | Choice | Rationale |
|---|---|---|
| Variants supported | `sam2.1-tiny`, `sam2.1-small`, `sam2.1-base-plus`, `sam2.1-large`, `sam3.1` | Drop `sam3` (transformers). It's the only variant that inherently requires two model instances on GPU. `sam3.1` supersedes it (same accuracy, single model). `SAM_MODEL=sam3` env value is auto-remapped to `sam3.1` with a deprecation warning. |
| Concurrency model | Strict serialization | One inference at a time. Fixes the `_state` race on the native adapter and matches the office workload (single user, sequential batch). |
| Loading mode | Synchronous from caller's perspective | The 202 `/sam/switch` endpoint dispatches `manager.ensure_loaded()` in a background thread; status polling reflects progress. First-inference-after-idle blocks (status-quo UX). |
| Idle eviction policy | One global last-used clock | When SAM is idle past timeout, the entire stack drops together. Same `SAM_IDLE_TIMEOUT_S` env var (default 900s; `0` disables). |
| Module structure | New `lifecycle.py`; `predictor.py` becomes a compat facade | Keeps existing imports working; manager is a clean new abstraction. |
| Test injection | Single seam: `manager.install_test_variant(SamVariant)` | Replaces six current injection points. Back-compat shims preserve existing test code. |
| Lazy rebuild after idle eviction | Status quo — first inference blocks 5–15s | Background pre-warm is a future UX improvement; not required for this PR. |

## 5. Architecture

### 5.1 `SamVariant` protocol

```python
class SamCapabilityError(Exception): pass
class SamNotReadyError(Exception):
    def __init__(self, state: str): self.state = state
class SamLoadError(Exception): pass

class SamVariant(Protocol):
    """One SAM model variant. Owns its weights, image cache, and the
    four inference paths. The manager holds at most one of these."""

    name: str                       # e.g. "sam2.1-large", "sam3.1"
    device: str | None              # "cuda", "cpu", or None when unloaded
    build_key: tuple[str, str, str] # (name, dtype, attn_impl)

    # ---- lifecycle (called only by the manager, under _inference_lock) ----
    def load(self, device: str | None) -> None: ...
    def unload(self) -> None: ...

    # ---- image cache ----
    def set_image(self, image: "np.ndarray") -> str: ...
    def cached_image_hash(self) -> str | None: ...
    def cached_image_shape(self) -> tuple[int, int] | None: ...
    def extract_embedding(self) -> bytes | None: ...

    # ---- iterative-refinement state (point path) ----
    def set_prev_logits(self, low_res_logits: Any | None, n_points: int) -> None: ...
    def get_prev_logits(self) -> tuple[Any | None, int]: ...

    # ---- inference ----
    def predict_point(self, *, point_coords, point_labels,
                      box=None, mask_input=None,
                      multimask_output=True) -> tuple[masks, scores, logits]: ...
    def predict_text(self, *, image_b64, text,
                     threshold=None, use_vlm_fo1=False) -> list[dict]: ...
    def predict_box(self, *, image_b64, boxes, box_labels,
                    text=None) -> list[dict]: ...
    def predict_visual(self, *, image_b64, prompt_image_b64,
                       prompt_box, threshold=None) -> list[dict]: ...

    # ---- capability flags ----
    @property
    def supports_text(self) -> bool: ...
    @property
    def supports_box(self) -> bool: ...
    @property
    def supports_visual(self) -> bool: ...
```

### 5.2 Concrete variants

**`Sam2Variant`** — wraps one `sam2_adapter.build_sam2_image_predictor(name, device=...)` instance.

- `predict_point` delegates to the adapter's `.predict()`.
- `predict_text`, `predict_box`, `predict_visual` raise `SamCapabilityError("sam2 does not support <op>")`.
- `supports_text = supports_box = supports_visual = False`.
- `extract_embedding()` delegates to the adapter's existing extractor.

**`Sam3p1Variant`** — wraps **one** `Sam3p1NativeImagePredictorAdapter` instance (the critical unification).

- `load()` builds the adapter via `sam3p1_adapter.build_sam3p1_image_predictor(device=...)`. Stores it on `self._adapter`. **No more `_NATIVE_IMAGE_PREDICTOR` module global.**
- `set_image(image_np)` delegates to `self._adapter.set_image(image_np)` and caches the sha256.
- `predict_point(...)` calls `self._adapter.predict(...)`.
- `predict_text(image_b64=, text=, ...)` decodes b64 → numpy → calls `self._adapter.set_image(...)` (updates hash) → runs `processor.set_text_prompt` (with bf16 autocast on CUDA) → extracts detections → post-text GPU-hygiene cleanup → optional VLM-FO1 filter pass → returns rows. **Same adapter instance as `predict_point`; no second model.**
- `predict_box(...)` — same pattern, body moved from `make_sam3p1_box_predictor`.
- `predict_visual(...)` — body moved from `sam3_adapter.make_sam3_visual_predictor`; reuses `self._adapter`.
- `supports_text = supports_box = supports_visual = True`.
- `extract_embedding()` returns `None` (native processor has no serializable embedding).

### 5.3 `SamLifecycleManager`

```python
class LoadState(NamedTuple):
    kind: Literal["idle", "loading", "ready", "error"]
    variant: str | None
    loaded_at: str | None   # ISO timestamp; populated when kind == "ready"
    started_at: str | None  # ISO timestamp of last load attempt
    error: str | None       # populated when kind == "error"

class SamLifecycleManager:
    # --- fields ---
    _active: SamVariant | None
    _test_variant: SamVariant | None        # injection seam
    _state: LoadState
    _last_used_at: float | None             # monotonic clock
    _remembered_variant: str | None         # for lazy rebuild after idle
    _inference_lock: threading.Lock         # serialization
    _load_lock: threading.Lock              # state-field mutex

    # --- public API ---
    def ensure_loaded(self, variant: str, *, device: str | None = None) -> None
    @contextmanager
    def lease(self) -> Iterator[SamVariant]
    @contextmanager
    def lease_or_load(self) -> Iterator[SamVariant]
    def force_unload(self) -> bool
    def evict_if_idle(self) -> bool
    def status(self) -> LoadState
    def install_test_variant(self, v: SamVariant | None) -> None
    def remembered_variant(self) -> str | None
    def _reset_for_tests(self) -> None
```

**Lock invariants:**

- `_load_lock` is only ever held for short critical sections (state-field mutation). Never held during model build or inference.
- `_inference_lock` is held during the entire load operation and during each inference call. Acquired before `_load_lock` if both are needed (always: outer → inner ordering, no deadlock potential).
- All `variant.load()` / `variant.unload()` / `variant.predict_*()` / `variant.set_image()` calls happen with `_inference_lock` held.

### 5.4 State machine

```
       ensure_loaded(v)
   idle ─────────────────► loading
                              │
                  load success│            load failure
                              ▼                 ▼
                            ready ◄──        error
                              │  │ ensure_loaded(other) / force_unload / evict_if_idle
                              │  │
                              ▼  ▼
                            (back to idle, possibly loading new)
```

Transitions:

- **idle → loading** — `ensure_loaded(v)` called from idle.
- **ready → loading** — `ensure_loaded(other)` for a different variant.
- **loading → ready** — load completed; `_active` populated; `loaded_at` set.
- **loading → error** — `load()` raised. `_active = None`. `_remembered_variant = v` so retry knows what to try. GPU cleanup ran.
- **ready → idle** — `force_unload()` or `evict_if_idle()` past timeout.
- **error → loading** — next `ensure_loaded()` clears `error` and tries again.

Transition assertions (debug-mode only):

| Transition | Invariant |
|---|---|
| → loading | caller holds `_inference_lock` |
| → ready | `_active is not None` AND `_active.name == _state.variant` |
| → idle | `_active is None` AND `_last_used_at is None` |
| → error | `_active is None` AND `_state.error is not None` |

## 6. Operation flows

### 6.1 `ensure_loaded(variant)`

```
1. Apply LEGACY_VARIANT_REMAP first: variant == "sam3" → "sam3.1" (warn-log once, idempotent).
2. Validate (remapped) variant ∈ ALLOWED_SAM_MODELS (after Commit 6 this excludes "sam3").
3. Fast-path under _load_lock:
     if state == "ready" AND active.name == variant:
         update _remembered_variant; return.
4. Acquire _inference_lock (waits for in-flight inference).
5. Re-check (concurrent caller may have completed):
     under _load_lock: state == "ready" AND active.name == variant → return.
6. Under _load_lock: set state = "loading", variant = <new>, started_at = now.
7. If _active is not None:
     _try_unload_locked(_active)       # logs and swallows exceptions
     _active = None
     _run_cuda_cleanup()                # 3x gc + sync + empty_cache + ipc_collect + dynamo.reset
8. Resolve device via device_prefs.get_pref("sam") → resolve_device(...).
9. Build: new_variant = Sam2Variant(name) or Sam3p1Variant().
10. new_variant.load(device=resolved_device).
11. Under _load_lock: _active = new_variant, state = "ready",
    loaded_at = now, _last_used_at = now, _remembered_variant = variant.
12. Release _inference_lock.

On exception in 9-10:
   _try_unload_locked(new_variant)      # drops partial allocations
   _run_cuda_cleanup()
   under _load_lock: state = "error",
                     error = short_repr(exc),
                     _active = None,
                     _remembered_variant = variant.
   re-raise as SamLoadError.
```

### 6.2 `lease()`

```python
@contextmanager
def lease(self) -> Iterator[SamVariant]:
    if self._test_variant is not None:
        # Test bypass — no lock, no state check
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
                self._run_cuda_cleanup_light()  # empty_cache only
                log.warning("inference OOM in %s: %s", active.name, exc)
            raise
    finally:
        with self._load_lock:
            self._last_used_at = time.monotonic()
        self._inference_lock.release()
```

### 6.3 `lease_or_load()` (router-facing)

```python
@contextmanager
def lease_or_load(self) -> Iterator[SamVariant]:
    """Lease the current variant; lazily load if idle. Canonical router entry."""
    try:
        with self.lease() as sam:
            yield sam
    except SamNotReadyError as e:
        if e.state == "idle":
            variant = self._remembered_variant or self._env_default_variant()
            self.ensure_loaded(variant)
            with self.lease() as sam:
                yield sam
        else:
            raise   # "loading", "error" → router maps to 503
```

### 6.4 `force_unload()`

```
1. Acquire _inference_lock.
2. Under _load_lock: if _active is None and state == "idle": return False.
3. old = _active; under _load_lock: _active = None.
4. _try_unload_locked(old).
5. _run_cuda_cleanup().
6. Under _load_lock: state = "idle", variant = None, last_used = None.
7. Release _inference_lock; return True.
```

### 6.5 `evict_if_idle()` (sweeper)

```
1. Cheap pre-check (no locks):
     if _active is None or _last_used_at is None: return False.
     if (now - _last_used_at) < timeout: return False.
2. Acquire _inference_lock.
3. Re-check under _load_lock (in-flight inference may have ticked clock):
     same checks as step 1.
4. Same body as force_unload() steps 3-7.
5. Log "evicted_on_idle" with gpu memory delta.
```

### 6.6 Idle clock ticks

| Event | `_last_used_at` |
|---|---|
| `ensure_loaded()` success | `time.monotonic()` |
| `lease()` enter | `time.monotonic()` |
| `lease()` exit (success or exception) | `time.monotonic()` |
| Load failure (`state → error`) | unchanged |
| `force_unload()` / `evict_if_idle()` success | `None` |

## 7. Error handling

| Class | Path | Resulting state | Cleanup |
|---|---|---|---|
| Load failure (OOM / HF auth / network) | `ensure_loaded` exception | `error` with short_repr | `_try_unload_locked` on partial variant + `_run_cuda_cleanup` |
| Unload failure (`variant.unload()` raises) | `_try_unload_locked` swallows + logs | Caller continues | `_run_cuda_cleanup` always runs |
| Inference failure (general) | bubbles to router | `ready` (unchanged) | none |
| Inference CUDA OOM | caught in `lease()` | `ready` (unchanged) | `_run_cuda_cleanup_light` (empty_cache) |
| Container shutdown | sweeper stopped via `_SWEEPER_STOP.set()` | (process exit) | OS reclaims GPU; no explicit unload |

HTTP error mapping:

| Exception | Code | Detail |
|---|---|---|
| `SamLoadError` (async, via background thread) | (status reflected on `/sam/status`) | `kind=error, error=<msg>` |
| `SamNotReadyError("loading")` | 503 | `sam_loading` |
| `SamNotReadyError("idle")` | 503 | `sam_not_loaded` |
| `SamNotReadyError("error")` | 503 | `sam_load_failed: <error>` |
| `SamCapabilityError` | 409 | `<op>_not_supported_for_variant` |
| `torch.cuda.OutOfMemoryError` (inference) | 500 | `sam_inference_oom` |
| `RuntimeError("set_image must be called before predict")` | 422 | `image_not_cached` |
| Other inference exception | 500 | `sam_inference_error: <msg>` |

`_run_cuda_cleanup()` centralizes the three-pass cleanup that lives in `force_evict_predictor()` today (predictor.py:635–658):

```python
def _run_cuda_cleanup(self) -> None:
    import gc
    for _ in range(3):
        gc.collect()
        if _torch_available():
            try:
                torch.cuda.synchronize()
                torch.cuda.empty_cache()
            except Exception:
                pass
    try:
        import torch._dynamo
        torch._dynamo.reset()
    except Exception:
        pass
    if _torch_available():
        try:
            torch.cuda.ipc_collect()
        except Exception:
            pass
```

## 8. Test seams

Single new injection point:

```python
manager.install_test_variant(v: SamVariant | None)
```

When set, `lease()` yields the fake without acquiring locks or checking state. `ensure_loaded`/`force_unload`/`evict_if_idle` become no-ops.

Existing tests are preserved via back-compat shims in `predictor.py`:

```python
def set_test_predictor(p): _legacy_install(point=p)
def set_text_predictor(fn): _legacy_install(text=fn)
def set_box_predictor(fn): _legacy_install(box=fn)
def set_visual_predictor(fn): _legacy_install(visual=fn)
def reset_text_predictor(): _legacy_clear("text")
# etc.
```

These build/update a `_LegacyTestVariant` (a `SamVariant` implementation) and call `manager.install_test_variant(legacy)`. Aggregating multiple legacy injections onto one variant matches the existing test semantics (a test that injects both `set_test_predictor` and `set_text_predictor` ends up with both wired).

**Test pytest fixture (new):**

```python
@pytest.fixture
def fake_sam():
    from carve_model.sam.lifecycle import manager
    fake = FakeSamVariant()
    manager.install_test_variant(fake)
    try:
        yield fake
    finally:
        manager.install_test_variant(None)
        manager._reset_for_tests()
```

**Required new test coverage (Commit 1):**

- `test_ensure_loaded_idempotent` — second call with same variant is a no-op
- `test_ensure_loaded_switches_unloads_first` — switching variant evicts old before loading new
- `test_ensure_loaded_load_failure_sets_error_state` — OOM during load → state=error, `_active is None`, gc ran
- `test_lease_blocks_when_not_ready` — lease during state=loading raises `SamNotReadyError`
- `test_lease_serializes_two_threads` — second thread waits for first
- `test_force_unload_waits_for_inflight` — concurrent inference must finish before unload
- `test_evict_if_idle_respects_timeout` — recent use prevents eviction
- `test_evict_if_idle_releases_memory` — past timeout drops the variant
- `test_evict_if_idle_rechecks_under_lock` — inference between pre-check and lock acquire aborts the eviction
- `test_sam2_variant_rejects_text` — `SamCapabilityError` from `predict_text`
- `test_sam3p1_text_and_point_share_adapter` — `id(adapter)` consistent across the two predict paths
- `test_lease_or_load_rebuilds_after_idle` — after eviction, next inference auto-loads
- `test_status_reflects_state_machine` — each transition visible to `status()`

**Required new integration test (Commit 3):**

- `test_text_then_point_no_double_load` (GPU-required, marked) — exercises the original bug. Asserts `torch.cuda.memory_allocated()` after `/sam/text-prompt` followed by `/sam/encode` does not grow by a second model's worth of bytes.
- `test_switch_unloads_old_completely` (GPU-required) — load sam3.1, switch to sam2.1-large, assert VRAM drops by ~5 GB before the new model loads.

**Required new integration test (Commit 4):**

- `test_sweeper_evicts_after_idle` (GPU-required, slow) — `SAM_IDLE_TIMEOUT_S=2`; load sam3.1; observe `torch.cuda.memory_allocated()` returns to baseline after 3 seconds + one sweep tick.

## 9. Module layout

| File | Change |
|---|---|
| `apps/model/src/carve_model/sam/lifecycle.py` | **NEW** — manager, protocol, variants, exceptions, `_LegacyTestVariant`, `LoadState` |
| `apps/model/src/carve_model/sam/predictor.py` | Shrinks from ~1100 to ~250 lines. Becomes a compat facade: `ALLOWED_SAM_MODELS`, `get_sam_model`, `is_sam3_family` (renamed from `get_sam_variant`), env remap for `SAM_MODEL=sam3`, and shim wrappers for each pre-existing public function delegating to the manager. |
| `apps/model/src/carve_model/sam/sam2_adapter.py` | Unchanged (the variant class wraps it). |
| `apps/model/src/carve_model/sam/sam3p1_adapter.py` | `Sam3p1NativeImagePredictorAdapter` class kept (with new `set_prev_logits` / `get_prev_logits` attrs). Deleted: `_NATIVE_IMAGE_PREDICTOR`, `_get_or_build_native_image_predictor`, `_set_native_image_predictor_for_tests`, `reset_native_image_predictor`, `make_sam3p1_text_predictor`, `make_sam3p1_box_predictor`. |
| `apps/model/src/carve_model/sam/sam3_adapter.py` | **Deleted entirely.** Visual-prompt helpers (RLE/polygon composition) move to `codec.py` or `polygonize.py` as needed. |
| `apps/model/src/carve_model/sam/router.py` | All endpoints rewritten to use `manager.lease_or_load()`, `manager.ensure_loaded()`, `manager.force_unload()`, `manager.status()`. |
| `apps/model/src/carve_model/main.py` | `_sweep_loop()` calls `manager.evict_if_idle()`. Adds deprecation warning for `SAM_MODEL=sam3`. |

## 10. Migration plan — 6 commits, single PR

| # | Title | Touches | Production behavior |
|---|---|---|---|
| 1 | Foundation: `lifecycle.py` skeleton + unit tests | `lifecycle.py` (new), `tests/sam/test_lifecycle.py` (new) | Unchanged — nothing imports the new module yet |
| 2 | Variant body migration (still no production callers) | `lifecycle.py` (fill in `Sam3p1Variant` methods) | Unchanged — routers still use old factories |
| 3 | Router migration + test back-compat shims | `router.py`, `predictor.py` (facade), `sam3p1_adapter.py` (prev_logits attrs) | **The behavioral fix** — manager owns production lifecycle |
| 4 | Sweeper migration | `main.py` | Idle eviction now uses full cleanup path |
| 5 | Dead code removal | `predictor.py` (shrink), `sam3p1_adapter.py` (delete singletons) | Code-only; runtime unchanged |
| 6 | Drop sam3 | `sam3_adapter.py` (delete), `predictor.py` (remove from allowed list + env remap), `main.py` | `SAM_MODEL=sam3` auto-remaps to `sam3.1` with deprecation warning |

Each commit's CI must be green. Commit 3 is the one where production behavior changes; all earlier commits are additive and all later commits are dead-code deletion.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Breaking existing test injections | Back-compat shims (`set_test_predictor` et al.) preserve every existing test seam through Commit 3 |
| `lease_or_load()` lazy rebuild causes first-inference latency after idle | Documented status-quo behavior; matches today's router-side try/rebuild fallback. Future UX improvement: background pre-warm on next status poll |
| Switch-while-batch-running blocks for current image's duration | Acceptable for office workload (single user). Documented in code |
| sam3 operator surprised by auto-remap | Deprecation warning at startup; PR description mentions it |
| Hidden caller of removed module globals (e.g. `_NATIVE_IMAGE_PREDICTOR`) | `grep` audit during Commit 5; tests would catch the rest. The `__getattr__` PEP 562 fallback in current `predictor.py` is removed in Commit 5 — any reader of `_PREDICTOR` etc. would surface as an AttributeError immediately, easy to spot |
| `_run_cuda_cleanup` masking real bugs by aggressive gc | Each failure path also logs the exception; gc just prevents leaks downstream |

## 12. Acceptance criteria

1. **No OOM regression:** the integration tests `test_text_then_point_no_double_load` and `test_switch_unloads_old_completely` both pass on the office RTX 4070 (12 GB).
2. **Idle eviction works:** `test_sweeper_evicts_after_idle` passes with `SAM_IDLE_TIMEOUT_S=2`.
3. **HTTP contract preserved:** existing API integration tests pass unchanged.
4. **Back-compat shims work:** existing unit tests in `apps/model/tests/sam/` pass unchanged.
5. **One variant resident at a time:** logged GPU memory before/after each `ensure_loaded` switch shows the old variant's footprint drops before the new variant's is allocated.
6. **sam3 deprecation:** `SAM_MODEL=sam3` startup with the new code logs a single WARN line and the manager actually loads sam3.1.

## 13. Out of scope (future work)

- Background pre-warm of SAM after idle eviction: on the next `/sam/status` poll after eviction, the router kicks off `ensure_loaded()` in a background thread so the user's next inference request finds the model already loading or ready. Would eliminate the 5–15 s first-inference latency. Excluded from this PR — the manager's contract supports it without changes; the trigger is a router-side concern.
- Cross-tool GPU budget coordinator (YOLOE + SAM + FO1 awareness).
- Per-image session caches keyed by image hash so concurrent users on different images don't serialize.
- Replacing the back-compat shims with first-class test fixtures (next PR).
- Renaming or removing the `predictor.py` compat facade once external callers are audited.

## 14. References

- Original predictor module: `apps/model/src/carve_model/sam/predictor.py`
- SAM 3.1 native adapter: `apps/model/src/carve_model/sam/sam3p1_adapter.py`
- SAM 3 transformers adapter (to delete): `apps/model/src/carve_model/sam/sam3_adapter.py`
- Sweeper: `apps/model/src/carve_model/main.py:30-51`
- Idle timeout constant: `apps/model/src/carve_model/sam/predictor.py:482`
- Current force-evict cleanup sequence (model for `_run_cuda_cleanup`): `apps/model/src/carve_model/sam/predictor.py:635-658`
