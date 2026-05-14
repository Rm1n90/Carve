# SAM Lifecycle Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify SAM model lifecycle in `apps/model` so at most one SAM variant is GPU-resident at any time, idle eviction releases all SAM state (not just `_SESSION`), inference is strictly serialized through one lock, and the OOM caused by loading both a sam3.1 point-predictor and a sam3.1 text-predictor instance is structurally impossible.

**Architecture:** New `apps/model/src/carve_model/sam/lifecycle.py` containing a `SamLifecycleManager` (state machine + two locks) and a `SamVariant` strategy protocol with concrete `Sam2Variant` and `Sam3p1Variant` classes. Existing `predictor.py` shrinks to a compat facade. `sam3` (transformers) family is dropped; `SAM_MODEL=sam3` auto-remaps to `sam3.1`. Lands in 6 logical phases inside one PR.

**Tech Stack:** Python 3.12, pytest 8.3.4, FastAPI (model service), PyTorch with CUDA, threading (stdlib), `Sam3p1NativeImagePredictorAdapter` from existing `sam3p1_adapter.py`.

**Spec:** `docs/superpowers/specs/2026-05-14-sam-lifecycle-manager-design.md`

**Test runner:** `pytest` from `apps/model/` (tests in `apps/model/tests/`).

---

## Phase 1 — Foundation (`lifecycle.py` skeleton + unit tests)

**Phase goal:** A working `SamLifecycleManager` and `SamVariant` protocol with full unit test coverage. No production code uses it yet. All existing tests still pass.

### Task 1.1: Create exceptions module

**Files:**
- Create: `apps/model/src/carve_model/sam/lifecycle.py` (initial skeleton)
- Test: `apps/model/tests/sam/test_lifecycle_exceptions.py`

- [ ] **Step 1: Write the failing test**

```python
# apps/model/tests/sam/test_lifecycle_exceptions.py
from carve_model.sam.lifecycle import (
    SamCapabilityError,
    SamNotReadyError,
    SamLoadError,
)


def test_sam_not_ready_carries_state():
    e = SamNotReadyError("loading")
    assert e.state == "loading"
    assert "loading" in str(e)


def test_sam_capability_error_is_exception():
    assert issubclass(SamCapabilityError, Exception)


def test_sam_load_error_chains_cause():
    try:
        try:
            raise RuntimeError("inner")
        except RuntimeError as inner:
            raise SamLoadError("sam3.1", inner) from inner
    except SamLoadError as e:
        assert e.variant == "sam3.1"
        assert e.__cause__ is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_exceptions.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'carve_model.sam.lifecycle'`

- [ ] **Step 3: Create skeleton with the three exception classes**

```python
# apps/model/src/carve_model/sam/lifecycle.py
"""SAM lifecycle manager — unified ownership of the one resident SAM variant.

Replaces the three-singleton sprawl (_SESSION, _NATIVE_IMAGE_PREDICTOR,
_TEXT_PREDICTOR_FACTORY) with one state machine + one strategy protocol.
See docs/superpowers/specs/2026-05-14-sam-lifecycle-manager-design.md.
"""
from __future__ import annotations

__all__ = [
    "SamCapabilityError",
    "SamNotReadyError",
    "SamLoadError",
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_exceptions.py -v`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/lifecycle.py \
        apps/model/tests/sam/test_lifecycle_exceptions.py
git commit -m "feat(sam-lifecycle): add exception classes (foundation skeleton)"
```

---

### Task 1.2: Add `LoadState` dataclass

**Files:**
- Modify: `apps/model/src/carve_model/sam/lifecycle.py`
- Test: `apps/model/tests/sam/test_lifecycle_state.py`

- [ ] **Step 1: Write the failing test**

```python
# apps/model/tests/sam/test_lifecycle_state.py
from carve_model.sam.lifecycle import LoadState


def test_load_state_defaults_to_idle():
    s = LoadState.idle()
    assert s.kind == "idle"
    assert s.variant is None
    assert s.loaded_at is None
    assert s.started_at is None
    assert s.error is None


def test_load_state_loading_constructor():
    s = LoadState.loading("sam3.1", started_at="2026-05-14T10:00:00Z")
    assert s.kind == "loading"
    assert s.variant == "sam3.1"
    assert s.started_at == "2026-05-14T10:00:00Z"


def test_load_state_ready_constructor():
    s = LoadState.ready("sam2.1-large", loaded_at="2026-05-14T10:00:05Z")
    assert s.kind == "ready"
    assert s.variant == "sam2.1-large"
    assert s.loaded_at == "2026-05-14T10:00:05Z"


def test_load_state_error_constructor():
    s = LoadState.error_("sam3.1", "CUDA out of memory")
    assert s.kind == "error"
    assert s.variant == "sam3.1"
    assert s.error == "CUDA out of memory"


def test_load_state_is_immutable():
    import dataclasses
    s = LoadState.idle()
    assert dataclasses.is_dataclass(s)
    try:
        s.kind = "ready"  # type: ignore[misc]
    except dataclasses.FrozenInstanceError:
        return
    raise AssertionError("LoadState should be frozen")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_state.py -v`
Expected: FAIL — `LoadState` not defined.

- [ ] **Step 3: Add `LoadState` to `lifecycle.py`**

Append to `lifecycle.py`:

```python
from dataclasses import dataclass
from typing import Literal


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
```

Add `"LoadState"` and `"LoadStateKind"` to `__all__`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_state.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/lifecycle.py \
        apps/model/tests/sam/test_lifecycle_state.py
git commit -m "feat(sam-lifecycle): add LoadState immutable snapshot"
```

---

### Task 1.3: Declare `SamVariant` Protocol

**Files:**
- Modify: `apps/model/src/carve_model/sam/lifecycle.py`
- Test: `apps/model/tests/sam/test_lifecycle_protocol.py`

- [ ] **Step 1: Write the failing test**

```python
# apps/model/tests/sam/test_lifecycle_protocol.py
from carve_model.sam.lifecycle import SamVariant, SamCapabilityError


class MinimalVariant:
    """Smallest object that satisfies the SamVariant protocol."""
    name = "fake"
    device = None
    build_key = ("fake", "fp32", "sdpa")
    supports_text = False
    supports_box = False
    supports_visual = False

    def load(self, device): pass
    def unload(self): pass
    def set_image(self, image): return "h"
    def cached_image_hash(self): return "h"
    def cached_image_shape(self): return (1, 1)
    def extract_embedding(self): return None
    def set_prev_logits(self, low_res_logits, n_points): pass
    def get_prev_logits(self): return (None, 0)
    def predict_point(self, **kw): return (None, None, None)
    def predict_text(self, **kw): raise SamCapabilityError("nope")
    def predict_box(self, **kw): raise SamCapabilityError("nope")
    def predict_visual(self, **kw): raise SamCapabilityError("nope")


def test_minimal_object_satisfies_protocol():
    v: SamVariant = MinimalVariant()  # type: ignore[assignment]
    assert v.name == "fake"
    assert v.supports_text is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_protocol.py -v`
Expected: FAIL — `SamVariant` not defined.

- [ ] **Step 3: Add `SamVariant` Protocol**

Append to `lifecycle.py`:

```python
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
```

Add `"SamVariant"` to `__all__`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_protocol.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/lifecycle.py \
        apps/model/tests/sam/test_lifecycle_protocol.py
git commit -m "feat(sam-lifecycle): declare SamVariant Protocol"
```

---

### Task 1.4: `Sam2Variant` — full implementation

**Files:**
- Modify: `apps/model/src/carve_model/sam/lifecycle.py`
- Test: `apps/model/tests/sam/test_lifecycle_sam2_variant.py`

- [ ] **Step 1: Write the failing tests**

```python
# apps/model/tests/sam/test_lifecycle_sam2_variant.py
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from carve_model.sam.lifecycle import SamCapabilityError, Sam2Variant


@pytest.fixture
def fake_adapter():
    adapter = MagicMock()
    adapter.predict.return_value = (
        np.zeros((1, 4, 4), dtype=bool),
        np.array([0.9]),
        np.zeros((1, 256, 256), dtype=np.float32),
    )
    adapter.extract_embedding.return_value = b"emb"
    return adapter


def test_sam2_variant_load_builds_adapter(fake_adapter):
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=fake_adapter,
    ) as build:
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
        build.assert_called_once_with("sam2.1-large", device="cuda")
        assert v.name == "sam2.1-large"
        assert v.device == "cuda"


def test_sam2_variant_unload_drops_adapter(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam2_adapter", return_value=fake_adapter):
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
        v.unload()
        assert v.cached_image_hash() is None


def test_sam2_variant_set_image_returns_hash(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam2_adapter", return_value=fake_adapter):
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
        img = np.zeros((10, 10, 3), dtype=np.uint8)
        h = v.set_image(img)
        assert isinstance(h, str) and len(h) == 64
        assert v.cached_image_hash() == h
        assert v.cached_image_shape() == (10, 10)
        fake_adapter.set_image.assert_called_once()


def test_sam2_variant_predict_point_delegates(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam2_adapter", return_value=fake_adapter):
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
        v.set_image(np.zeros((10, 10, 3), dtype=np.uint8))
        masks, scores, logits = v.predict_point(
            point_coords=np.array([[5, 5]]),
            point_labels=np.array([1]),
        )
        assert masks.shape == (1, 4, 4)
        fake_adapter.predict.assert_called_once()


def test_sam2_variant_extract_embedding_delegates(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam2_adapter", return_value=fake_adapter):
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
        assert v.extract_embedding() == b"emb"


def test_sam2_variant_rejects_text(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam2_adapter", return_value=fake_adapter):
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
        with pytest.raises(SamCapabilityError):
            v.predict_text(image_b64="", text="hat")


def test_sam2_variant_rejects_box(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam2_adapter", return_value=fake_adapter):
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
        with pytest.raises(SamCapabilityError):
            v.predict_box(image_b64="", boxes=[[0, 0, 1, 1]], box_labels=[1])


def test_sam2_variant_rejects_visual(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam2_adapter", return_value=fake_adapter):
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
        with pytest.raises(SamCapabilityError):
            v.predict_visual(
                image_b64="", prompt_image_b64="", prompt_box=[0, 0, 1, 1]
            )


def test_sam2_variant_capability_flags():
    v = Sam2Variant("sam2.1-large")
    assert v.supports_text is False
    assert v.supports_box is False
    assert v.supports_visual is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_sam2_variant.py -v`
Expected: FAIL — `Sam2Variant` not defined.

- [ ] **Step 3: Implement `Sam2Variant`**

Append to `lifecycle.py`:

```python
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
```

Add `"Sam2Variant"` to `__all__`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_sam2_variant.py -v`
Expected: PASS — all 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/lifecycle.py \
        apps/model/tests/sam/test_lifecycle_sam2_variant.py
git commit -m "feat(sam-lifecycle): add Sam2Variant (point only)"
```

---

### Task 1.5: `Sam3p1Variant` — skeleton (load / unload / set_image / predict_point)

The other three predict methods (text/box/visual) get filled in during Phase 2. For now they raise `NotImplementedError`; supports_* flags are `True` so the manager knows the variant will support them once Phase 2 lands.

**Files:**
- Modify: `apps/model/src/carve_model/sam/lifecycle.py`
- Test: `apps/model/tests/sam/test_lifecycle_sam3p1_variant.py`

- [ ] **Step 1: Write the failing tests**

```python
# apps/model/tests/sam/test_lifecycle_sam3p1_variant.py
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from carve_model.sam.lifecycle import Sam3p1Variant


@pytest.fixture
def fake_adapter():
    adapter = MagicMock()
    adapter._state = {}
    adapter._device = "cuda"
    adapter.predict.return_value = (
        np.zeros((1, 4, 4), dtype=bool),
        np.array([0.9]),
        np.zeros((1, 256, 256), dtype=np.float32),
    )
    return adapter


def test_sam3p1_variant_load_builds_adapter(fake_adapter):
    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=fake_adapter,
    ) as build:
        v = Sam3p1Variant()
        v.load(device="cuda")
        build.assert_called_once_with(device="cuda")
        assert v.name == "sam3.1"
        assert v.device == "cuda"


def test_sam3p1_variant_unload_drops_adapter_refs(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam3p1_adapter", return_value=fake_adapter):
        v = Sam3p1Variant()
        v.load(device="cuda")
        v.unload()
        assert v.cached_image_hash() is None
        assert fake_adapter._state is None
        assert fake_adapter._model is None
        assert fake_adapter._processor is None


def test_sam3p1_variant_set_image_caches_hash(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam3p1_adapter", return_value=fake_adapter):
        v = Sam3p1Variant()
        v.load(device="cuda")
        img = np.zeros((10, 10, 3), dtype=np.uint8)
        h = v.set_image(img)
        assert isinstance(h, str) and len(h) == 64
        assert v.cached_image_hash() == h
        assert v.cached_image_shape() == (10, 10)
        fake_adapter.set_image.assert_called_once()


def test_sam3p1_variant_predict_point_delegates(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam3p1_adapter", return_value=fake_adapter):
        v = Sam3p1Variant()
        v.load(device="cuda")
        v.set_image(np.zeros((10, 10, 3), dtype=np.uint8))
        masks, scores, logits = v.predict_point(
            point_coords=np.array([[5, 5]]),
            point_labels=np.array([1]),
        )
        assert masks.shape == (1, 4, 4)
        fake_adapter.predict.assert_called_once()


def test_sam3p1_variant_capability_flags_all_true():
    v = Sam3p1Variant()
    assert v.supports_text is True
    assert v.supports_box is True
    assert v.supports_visual is True


def test_sam3p1_variant_text_box_visual_not_implemented_yet(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam3p1_adapter", return_value=fake_adapter):
        v = Sam3p1Variant()
        v.load(device="cuda")
        with pytest.raises(NotImplementedError):
            v.predict_text(image_b64="", text="hat")
        with pytest.raises(NotImplementedError):
            v.predict_box(image_b64="", boxes=[[0, 0, 1, 1]], box_labels=[1])
        with pytest.raises(NotImplementedError):
            v.predict_visual(image_b64="", prompt_image_b64="", prompt_box=[0, 0, 1, 1])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_sam3p1_variant.py -v`
Expected: FAIL — `Sam3p1Variant` not defined.

- [ ] **Step 3: Implement `Sam3p1Variant` skeleton**

Append to `lifecycle.py`:

```python
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
```

Add `"Sam3p1Variant"` to `__all__`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_sam3p1_variant.py -v`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/lifecycle.py \
        apps/model/tests/sam/test_lifecycle_sam3p1_variant.py
git commit -m "feat(sam-lifecycle): add Sam3p1Variant skeleton (point only; text/box/visual deferred to Phase 2)"
```

---

### Task 1.6: `SamLifecycleManager.__init__` + `status` + `install_test_variant` + `_reset_for_tests` + stub `lease`

**Files:**
- Modify: `apps/model/src/carve_model/sam/lifecycle.py`
- Test: `apps/model/tests/sam/test_lifecycle_manager_init.py`

- [ ] **Step 1: Write the failing tests**

```python
# apps/model/tests/sam/test_lifecycle_manager_init.py
import pytest

from carve_model.sam.lifecycle import (
    SamLifecycleManager,
    SamNotReadyError,
)


class StubVariant:
    name = "stub"
    device = None
    build_key = ("stub", "fp32", "sdpa")
    supports_text = False
    supports_box = False
    supports_visual = False

    def load(self, device): pass
    def unload(self): pass
    def set_image(self, image): return "h"
    def cached_image_hash(self): return "h"
    def cached_image_shape(self): return (1, 1)
    def extract_embedding(self): return None
    def set_prev_logits(self, low_res_logits, n_points): pass
    def get_prev_logits(self): return (None, 0)
    def predict_point(self, **kw): return (None, None, None)
    def predict_text(self, **kw): raise NotImplementedError
    def predict_box(self, **kw): raise NotImplementedError
    def predict_visual(self, **kw): raise NotImplementedError


def test_manager_initial_state_is_idle():
    mgr = SamLifecycleManager()
    s = mgr.status()
    assert s.kind == "idle"
    assert s.variant is None


def test_manager_install_test_variant_overrides_lease():
    mgr = SamLifecycleManager()
    stub = StubVariant()
    mgr.install_test_variant(stub)  # type: ignore[arg-type]
    with mgr.lease() as sam:
        assert sam is stub


def test_manager_install_test_variant_none_clears():
    mgr = SamLifecycleManager()
    mgr.install_test_variant(StubVariant())  # type: ignore[arg-type]
    mgr.install_test_variant(None)
    with pytest.raises(SamNotReadyError):
        with mgr.lease():
            pass


def test_manager_reset_for_tests_clears_everything():
    mgr = SamLifecycleManager()
    mgr.install_test_variant(StubVariant())  # type: ignore[arg-type]
    mgr._reset_for_tests()
    assert mgr.status().kind == "idle"
    with pytest.raises(SamNotReadyError):
        with mgr.lease():
            pass


def test_remembered_variant_initially_none():
    mgr = SamLifecycleManager()
    assert mgr.remembered_variant() is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_manager_init.py -v`
Expected: FAIL — `SamLifecycleManager` not defined.

- [ ] **Step 3: Implement `SamLifecycleManager.__init__`, `status`, `install_test_variant`, `remembered_variant`, `_reset_for_tests`, and a stub `lease`**

Append to `lifecycle.py`:

```python
import threading
from contextlib import contextmanager


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

    @contextmanager
    def lease(self):
        """Stub — replaced in Task 1.8 with full implementation."""
        if self._test_variant is not None:
            yield self._test_variant
            return
        raise SamNotReadyError(self._state.kind)
        yield  # unreachable; satisfies the generator protocol
```

Add `"SamLifecycleManager"` to `__all__`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_manager_init.py -v`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/lifecycle.py \
        apps/model/tests/sam/test_lifecycle_manager_init.py
git commit -m "feat(sam-lifecycle): add SamLifecycleManager init + status + test injection"
```

---

### Task 1.7: CUDA cleanup helpers + variant factory

**Files:**
- Modify: `apps/model/src/carve_model/sam/lifecycle.py`
- Test: `apps/model/tests/sam/test_lifecycle_cuda_cleanup.py`

- [ ] **Step 1: Write the failing tests**

```python
# apps/model/tests/sam/test_lifecycle_cuda_cleanup.py
from unittest.mock import MagicMock, patch

import pytest

from carve_model.sam.lifecycle import (
    SamLifecycleManager,
    Sam2Variant,
    Sam3p1Variant,
    _build_variant,
)


def test_run_cuda_cleanup_runs_gc_three_times():
    mgr = SamLifecycleManager()
    with patch("carve_model.sam.lifecycle.gc.collect") as collect:
        mgr._run_cuda_cleanup()
        assert collect.call_count == 3


def test_run_cuda_cleanup_swallows_torch_errors():
    mgr = SamLifecycleManager()
    fake_torch = MagicMock()
    fake_torch.cuda.is_available.return_value = True
    fake_torch.cuda.synchronize.side_effect = RuntimeError("boom")
    fake_torch.cuda.empty_cache.side_effect = RuntimeError("boom")
    fake_torch.cuda.ipc_collect.side_effect = RuntimeError("boom")
    with patch("carve_model.sam.lifecycle._import_torch", return_value=fake_torch):
        mgr._run_cuda_cleanup()  # must not raise


def test_run_cuda_cleanup_light_only_empty_cache():
    mgr = SamLifecycleManager()
    fake_torch = MagicMock()
    fake_torch.cuda.is_available.return_value = True
    with patch("carve_model.sam.lifecycle._import_torch", return_value=fake_torch):
        mgr._run_cuda_cleanup_light()
        fake_torch.cuda.empty_cache.assert_called_once()
        fake_torch.cuda.ipc_collect.assert_not_called()


def test_build_variant_sam2():
    v = _build_variant("sam2.1-large")
    assert isinstance(v, Sam2Variant)
    assert v.name == "sam2.1-large"


def test_build_variant_sam3p1():
    v = _build_variant("sam3.1")
    assert isinstance(v, Sam3p1Variant)
    assert v.name == "sam3.1"


def test_build_variant_rejects_unknown():
    with pytest.raises(ValueError, match="unknown SAM variant"):
        _build_variant("sam999")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_cuda_cleanup.py -v`
Expected: FAIL — helpers not defined.

- [ ] **Step 3: Implement cleanup helpers + variant factory**

Insert into `lifecycle.py` (module level, plus methods on `SamLifecycleManager`):

```python
import gc


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
```

Add to the existing `SamLifecycleManager` class:

```python
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
```

Add `"_build_variant"` to `__all__`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_cuda_cleanup.py -v`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/lifecycle.py \
        apps/model/tests/sam/test_lifecycle_cuda_cleanup.py
git commit -m "feat(sam-lifecycle): add cuda cleanup helpers + variant factory"
```

---

### Task 1.8: Full `lease()` — happy path, state check, last_used tick, OOM cleanup, serialization

**Files:**
- Modify: `apps/model/src/carve_model/sam/lifecycle.py`
- Test: `apps/model/tests/sam/test_lifecycle_lease.py`

- [ ] **Step 1: Write the failing tests**

```python
# apps/model/tests/sam/test_lifecycle_lease.py
import threading
import time
from unittest.mock import patch

import pytest

from carve_model.sam.lifecycle import (
    LoadState,
    SamLifecycleManager,
    SamNotReadyError,
)


class StubVariant:
    name = "stub"
    device = None
    build_key = ("stub", "fp32", "sdpa")
    supports_text = False
    supports_box = False
    supports_visual = False

    def load(self, device): pass
    def unload(self): pass
    def set_image(self, image): return "h"
    def cached_image_hash(self): return "h"
    def cached_image_shape(self): return (1, 1)
    def extract_embedding(self): return None
    def set_prev_logits(self, low_res_logits, n_points): pass
    def get_prev_logits(self): return (None, 0)
    def predict_point(self, **kw): return (None, None, None)
    def predict_text(self, **kw): raise NotImplementedError
    def predict_box(self, **kw): raise NotImplementedError
    def predict_visual(self, **kw): raise NotImplementedError


def _force_ready(mgr: SamLifecycleManager, variant: StubVariant) -> None:
    """Inject a variant directly into production-mode state."""
    with mgr._load_lock:
        mgr._active = variant  # type: ignore[assignment]
        mgr._state = LoadState.ready("stub", loaded_at="2026-05-14T00:00:00Z")
        mgr._last_used_at = time.monotonic()


def test_lease_yields_active_variant_when_ready():
    mgr = SamLifecycleManager()
    v = StubVariant()
    _force_ready(mgr, v)
    with mgr.lease() as sam:
        assert sam is v


def test_lease_raises_when_idle():
    mgr = SamLifecycleManager()
    with pytest.raises(SamNotReadyError) as exc:
        with mgr.lease():
            pass
    assert exc.value.state == "idle"


def test_lease_raises_when_loading():
    mgr = SamLifecycleManager()
    with mgr._load_lock:
        mgr._state = LoadState.loading("sam3.1", started_at="2026-05-14T00:00:00Z")
    with pytest.raises(SamNotReadyError) as exc:
        with mgr.lease():
            pass
    assert exc.value.state == "loading"


def test_lease_raises_when_error():
    mgr = SamLifecycleManager()
    with mgr._load_lock:
        mgr._state = LoadState.error_("sam3.1", "out of memory")
    with pytest.raises(SamNotReadyError) as exc:
        with mgr.lease():
            pass
    assert exc.value.state == "error"


def test_lease_ticks_last_used_on_enter_and_exit():
    mgr = SamLifecycleManager()
    _force_ready(mgr, StubVariant())
    with mgr._load_lock:
        mgr._last_used_at = 0.0
    with mgr.lease():
        with mgr._load_lock:
            t_inside = mgr._last_used_at
        assert t_inside > 0.0
    with mgr._load_lock:
        t_after = mgr._last_used_at
    assert t_after >= t_inside


def test_lease_serializes_two_threads():
    mgr = SamLifecycleManager()
    _force_ready(mgr, StubVariant())
    entered = threading.Event()
    release = threading.Event()
    result = []

    def worker_a():
        with mgr.lease():
            entered.set()
            release.wait()
        result.append("a-done")

    def worker_b():
        entered.wait()
        start = time.monotonic()
        with mgr.lease():
            elapsed = time.monotonic() - start
            result.append(("b-got-lock", elapsed))

    ta = threading.Thread(target=worker_a)
    tb = threading.Thread(target=worker_b)
    ta.start()
    tb.start()
    time.sleep(0.2)
    release.set()
    ta.join(timeout=2)
    tb.join(timeout=2)
    assert result[0] == "a-done"
    label, elapsed = result[1]
    assert label == "b-got-lock"
    assert elapsed >= 0.15


def test_lease_oom_runs_light_cleanup():
    mgr = SamLifecycleManager()
    _force_ready(mgr, StubVariant())
    cleaned = []
    with patch.object(
        mgr, "_run_cuda_cleanup_light", side_effect=lambda: cleaned.append(True)
    ):
        class FakeOOM(RuntimeError):
            pass

        with patch(
            "carve_model.sam.lifecycle._is_cuda_oom", return_value=True
        ):
            with pytest.raises(FakeOOM):
                with mgr.lease():
                    raise FakeOOM("CUDA out of memory")
    assert cleaned == [True]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_lease.py -v`
Expected: FAIL — stub `lease()` raises unconditionally; the happy-path and serialization tests fail.

- [ ] **Step 3: Replace stub `lease()` and add `_is_cuda_oom`**

In `lifecycle.py`, add imports near the top:

```python
import logging
import time

log = logging.getLogger(__name__)


def _is_cuda_oom(exc: BaseException) -> bool:
    """Best-effort detection of torch.cuda.OutOfMemoryError without importing torch."""
    cls_name = type(exc).__name__
    if "OutOfMemory" in cls_name:
        return True
    msg = str(exc).lower()
    return "out of memory" in msg or "cuda oom" in msg
```

Replace the stub `SamLifecycleManager.lease` with:

```python
    @contextmanager
    def lease(self):
        """Acquire exclusive use of the active variant.

        Yields the SamVariant. Acquires _inference_lock; ticks _last_used_at
        on enter and exit. Raises SamNotReadyError when not 'ready'.
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_lease.py -v`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/lifecycle.py \
        apps/model/tests/sam/test_lifecycle_lease.py
git commit -m "feat(sam-lifecycle): implement lease() with serialization + OOM handling"
```

---

### Task 1.9: `ensure_loaded` — idempotent, switching, load failure

**Files:**
- Modify: `apps/model/src/carve_model/sam/lifecycle.py`
- Test: `apps/model/tests/sam/test_lifecycle_ensure_loaded.py`

- [ ] **Step 1: Write the failing tests**

```python
# apps/model/tests/sam/test_lifecycle_ensure_loaded.py
from unittest.mock import MagicMock, patch

import pytest

from carve_model.sam.lifecycle import (
    SamLifecycleManager,
    SamLoadError,
)


def test_ensure_loaded_idle_to_ready():
    with patch("carve_model.sam.lifecycle._build_sam2_adapter", return_value=MagicMock()):
        mgr = SamLifecycleManager()
        mgr.ensure_loaded("sam2.1-large")
        s = mgr.status()
        assert s.kind == "ready"
        assert s.variant == "sam2.1-large"
        assert mgr.remembered_variant() == "sam2.1-large"


def test_ensure_loaded_idempotent_same_variant():
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=MagicMock(),
    ) as build:
        mgr = SamLifecycleManager()
        mgr.ensure_loaded("sam2.1-large")
        first_loaded_at = mgr.status().loaded_at
        mgr.ensure_loaded("sam2.1-large")
        assert mgr.status().loaded_at == first_loaded_at
        assert build.call_count == 1


def test_ensure_loaded_switches_unloads_first():
    sam2_adapter = MagicMock()
    sam3p1_adapter = MagicMock()
    sam3p1_adapter._state = {}
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=sam2_adapter,
    ):
        with patch(
            "carve_model.sam.lifecycle._build_sam3p1_adapter",
            return_value=sam3p1_adapter,
        ):
            mgr = SamLifecycleManager()
            mgr.ensure_loaded("sam3.1")
            mgr.ensure_loaded("sam2.1-large")
            assert mgr.status().variant == "sam2.1-large"
            assert sam3p1_adapter._state is None
            assert sam3p1_adapter._model is None
            assert sam3p1_adapter._processor is None


def test_ensure_loaded_failure_sets_error_state():
    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        side_effect=RuntimeError("CUDA out of memory"),
    ):
        mgr = SamLifecycleManager()
        with pytest.raises(SamLoadError):
            mgr.ensure_loaded("sam3.1")
        s = mgr.status()
        assert s.kind == "error"
        assert s.variant == "sam3.1"
        assert "out of memory" in s.error.lower()
        assert mgr._active is None
        assert mgr.remembered_variant() == "sam3.1"


def test_ensure_loaded_rejects_unknown_variant():
    mgr = SamLifecycleManager()
    with pytest.raises(ValueError, match="unknown SAM variant"):
        mgr.ensure_loaded("sam999")


def test_ensure_loaded_runs_cleanup_on_failure():
    cleaned = []
    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        side_effect=RuntimeError("oom"),
    ):
        mgr = SamLifecycleManager()
        with patch.object(mgr, "_run_cuda_cleanup", side_effect=lambda: cleaned.append(True)):
            try:
                mgr.ensure_loaded("sam3.1")
            except SamLoadError:
                pass
    assert cleaned, "cleanup must run on load failure"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_ensure_loaded.py -v`
Expected: FAIL — `ensure_loaded` not defined.

- [ ] **Step 3: Implement `ensure_loaded` + supporting helpers**

At the top of `lifecycle.py`, add imports and module-level constants:

```python
from datetime import datetime, timezone


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
```

Add to the existing `SamLifecycleManager` class:

```python
    def ensure_loaded(self, variant: str, *, device: str | None = None) -> None:
        """Switch the manager to `variant`. Idempotent if already loaded.

        Synchronous. Callers that need a 202-style endpoint should run this
        in a background thread.

        Raises ValueError for unknown variants, SamLoadError on load failure.
        """
        if self._test_variant is not None:
            return

        if variant not in _ALLOWED_VARIANTS:
            raise ValueError(f"unknown SAM variant: {variant!r}")

        with self._load_lock:
            if (
                self._state.kind == "ready"
                and self._active is not None
                and self._active.name == variant
            ):
                self._remembered_variant = variant
                return

        self._inference_lock.acquire()
        try:
            with self._load_lock:
                if (
                    self._state.kind == "ready"
                    and self._active is not None
                    and self._active.name == variant
                ):
                    self._remembered_variant = variant
                    return
                self._state = LoadState.loading(variant, started_at=_now_iso())

            if self._active is not None:
                self._try_unload_locked(self._active)
                self._active = None
                self._run_cuda_cleanup()

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_ensure_loaded.py -v`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/lifecycle.py \
        apps/model/tests/sam/test_lifecycle_ensure_loaded.py
git commit -m "feat(sam-lifecycle): implement ensure_loaded with switch + failure cleanup"
```

---

### Task 1.10: `force_unload` + `evict_if_idle`

**Files:**
- Modify: `apps/model/src/carve_model/sam/lifecycle.py`
- Test: `apps/model/tests/sam/test_lifecycle_unload_evict.py`

- [ ] **Step 1: Write the failing tests**

```python
# apps/model/tests/sam/test_lifecycle_unload_evict.py
import threading
import time
from unittest.mock import MagicMock, patch

from carve_model.sam.lifecycle import SamLifecycleManager


def _load_sam2(mgr: SamLifecycleManager) -> MagicMock:
    adapter = MagicMock()
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=adapter,
    ):
        mgr.ensure_loaded("sam2.1-large")
    return adapter


def test_force_unload_drops_active():
    mgr = SamLifecycleManager()
    _load_sam2(mgr)
    assert mgr.force_unload() is True
    s = mgr.status()
    assert s.kind == "idle"
    assert mgr._active is None
    assert mgr._last_used_at is None


def test_force_unload_idle_returns_false():
    mgr = SamLifecycleManager()
    assert mgr.force_unload() is False


def test_force_unload_waits_for_inflight_inference():
    mgr = SamLifecycleManager()
    _load_sam2(mgr)
    inside_lease = threading.Event()
    release = threading.Event()
    unload_started = threading.Event()
    unload_done = threading.Event()

    def worker_lease():
        with mgr.lease():
            inside_lease.set()
            release.wait()

    def worker_unload():
        inside_lease.wait()
        unload_started.set()
        mgr.force_unload()
        unload_done.set()

    tl = threading.Thread(target=worker_lease)
    tu = threading.Thread(target=worker_unload)
    tl.start()
    tu.start()
    unload_started.wait()
    time.sleep(0.1)
    assert not unload_done.is_set(), "unload must wait for inflight lease"
    release.set()
    tl.join(timeout=2)
    tu.join(timeout=2)
    assert unload_done.is_set()
    assert mgr.status().kind == "idle"


def test_evict_if_idle_respects_timeout():
    mgr = SamLifecycleManager()
    _load_sam2(mgr)
    with patch.object(mgr, "_idle_timeout_s", return_value=60):
        assert mgr.evict_if_idle() is False
    assert mgr.status().kind == "ready"


def test_evict_if_idle_drops_when_past_timeout():
    mgr = SamLifecycleManager()
    _load_sam2(mgr)
    with mgr._load_lock:
        mgr._last_used_at = time.monotonic() - 1000.0
    with patch.object(mgr, "_idle_timeout_s", return_value=60):
        assert mgr.evict_if_idle() is True
    assert mgr.status().kind == "idle"


def test_evict_if_idle_rechecks_under_lock():
    mgr = SamLifecycleManager()
    _load_sam2(mgr)
    with mgr._load_lock:
        mgr._last_used_at = time.monotonic() - 1000.0

    original_acquire = mgr._inference_lock.acquire

    def slow_acquire(*args, **kw):
        with mgr._load_lock:
            mgr._last_used_at = time.monotonic()
        return original_acquire(*args, **kw)

    with patch.object(mgr, "_idle_timeout_s", return_value=60):
        with patch.object(mgr._inference_lock, "acquire", side_effect=slow_acquire):
            assert mgr.evict_if_idle() is False
    assert mgr.status().kind == "ready"


def test_evict_if_idle_disabled_when_timeout_zero():
    mgr = SamLifecycleManager()
    _load_sam2(mgr)
    with mgr._load_lock:
        mgr._last_used_at = time.monotonic() - 1e9
    with patch.object(mgr, "_idle_timeout_s", return_value=0):
        assert mgr.evict_if_idle() is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_unload_evict.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement `force_unload`, `evict_if_idle`, `_idle_timeout_s`**

Add to `SamLifecycleManager`:

```python
    DEFAULT_IDLE_TIMEOUT_S = 15 * 60  # 15 minutes

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_unload_evict.py -v`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/lifecycle.py \
        apps/model/tests/sam/test_lifecycle_unload_evict.py
git commit -m "feat(sam-lifecycle): implement force_unload + evict_if_idle"
```

---

### Task 1.11: `lease_or_load` — lazy rebuild after idle

**Files:**
- Modify: `apps/model/src/carve_model/sam/lifecycle.py`
- Test: `apps/model/tests/sam/test_lifecycle_lease_or_load.py`

- [ ] **Step 1: Write the failing tests**

```python
# apps/model/tests/sam/test_lifecycle_lease_or_load.py
import os
from unittest.mock import MagicMock, patch

import pytest

from carve_model.sam.lifecycle import (
    LoadState,
    SamLifecycleManager,
    SamNotReadyError,
)


def test_lease_or_load_uses_existing_when_ready():
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=MagicMock(),
    ):
        mgr = SamLifecycleManager()
        mgr.ensure_loaded("sam2.1-large")
        with mgr.lease_or_load() as sam:
            assert sam.name == "sam2.1-large"


def test_lease_or_load_rebuilds_after_idle_eviction():
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        side_effect=[MagicMock(), MagicMock()],
    ):
        mgr = SamLifecycleManager()
        mgr.ensure_loaded("sam2.1-large")
        mgr.force_unload()
        assert mgr.status().kind == "idle"
        with mgr.lease_or_load() as sam:
            assert sam.name == "sam2.1-large"
        assert mgr.status().kind == "ready"


def test_lease_or_load_falls_back_to_env_default(monkeypatch):
    monkeypatch.setenv("SAM_MODEL", "sam2.1-large")
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=MagicMock(),
    ):
        mgr = SamLifecycleManager()
        with mgr.lease_or_load() as sam:
            assert sam.name == "sam2.1-large"


def test_lease_or_load_propagates_loading_state():
    mgr = SamLifecycleManager()
    with mgr._load_lock:
        mgr._state = LoadState.loading("sam3.1", started_at="2026-05-14T00:00:00Z")
    with pytest.raises(SamNotReadyError) as exc:
        with mgr.lease_or_load():
            pass
    assert exc.value.state == "loading"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_lease_or_load.py -v`
Expected: FAIL — `lease_or_load` not implemented.

- [ ] **Step 3: Implement `lease_or_load` + `_env_default_variant`**

Add to `SamLifecycleManager`:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_lease_or_load.py -v`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/lifecycle.py \
        apps/model/tests/sam/test_lifecycle_lease_or_load.py
git commit -m "feat(sam-lifecycle): implement lease_or_load (lazy rebuild after idle)"
```

---

### Task 1.12: Module-level singleton + Phase 1 integration sanity

**Files:**
- Modify: `apps/model/src/carve_model/sam/lifecycle.py`
- Test: `apps/model/tests/sam/test_lifecycle_singleton.py`

- [ ] **Step 1: Write the failing test**

```python
# apps/model/tests/sam/test_lifecycle_singleton.py
def test_module_exposes_manager_singleton():
    from carve_model.sam.lifecycle import manager, SamLifecycleManager
    assert isinstance(manager, SamLifecycleManager)


def test_manager_is_consistent_across_imports():
    from carve_model.sam.lifecycle import manager as a
    from carve_model.sam.lifecycle import manager as b
    assert a is b
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_singleton.py -v`
Expected: FAIL — no `manager` symbol exported.

- [ ] **Step 3: Add module-level singleton**

At the bottom of `lifecycle.py`:

```python
# Module-level singleton — the production manager.
manager = SamLifecycleManager()
```

Add `"manager"` to `__all__`.

- [ ] **Step 4: Run all Phase 1 tests**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_*.py -v`
Expected: PASS — every Phase 1 test green.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/lifecycle.py \
        apps/model/tests/sam/test_lifecycle_singleton.py
git commit -m "feat(sam-lifecycle): export module-level manager singleton (Phase 1 complete)"
```

---

## Phase 2 — Variant body migration

**Phase goal:** Move the bodies of `make_sam3p1_text_predictor`, `make_sam3p1_box_predictor`, and the sam3.1-using parts of `make_sam3_visual_predictor` into `Sam3p1Variant.predict_text/predict_box/predict_visual`. The old factories stay in place until Phase 5. After Phase 2, the variant is fully functional but no production code calls it yet.

### Task 2.1: `Sam3p1Variant.predict_text` body migration

**Files:**
- Modify: `apps/model/src/carve_model/sam/lifecycle.py`
- Read for reference: `apps/model/src/carve_model/sam/sam3p1_adapter.py` (search for `def make_sam3p1_text_predictor`)
- Test: `apps/model/tests/sam/test_lifecycle_predict_text.py`

- [ ] **Step 1: Write the failing tests**

```python
# apps/model/tests/sam/test_lifecycle_predict_text.py
"""Verify Sam3p1Variant.predict_text uses the variant's own adapter — not a
second _NATIVE_IMAGE_PREDICTOR singleton. This is the structural fix for
the double-load OOM bug."""
from unittest.mock import MagicMock, patch

import numpy as np

from carve_model.sam.lifecycle import Sam3p1Variant


def _b64_zero_image() -> str:
    import base64
    from io import BytesIO
    from PIL import Image
    pil = Image.fromarray(np.zeros((4, 4, 3), dtype=np.uint8))
    buf = BytesIO()
    pil.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _build_fake_adapter():
    adapter = MagicMock()
    adapter._device = "cuda"

    def fake_set_image(image):
        adapter._state = {
            "original_height": int(image.shape[0]),
            "original_width": int(image.shape[1]),
        }
    adapter.set_image.side_effect = fake_set_image

    def fake_set_text(text, state):
        state["masks"] = MagicMock()
        state["masks_logits"] = MagicMock()
        state["boxes"] = MagicMock()
        state["scores"] = MagicMock()
    adapter._processor.set_text_prompt.side_effect = fake_set_text
    adapter._processor.confidence_threshold = 0.5
    return adapter


def test_predict_text_reuses_same_adapter_as_point_no_double_load():
    """The critical assertion: predict_text and predict_point share the same
    underlying adapter instance."""
    fake_adapter = _build_fake_adapter()
    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=fake_adapter,
    ) as build:
        v = Sam3p1Variant()
        v.load(device="cuda")
        with patch(
            "carve_model.sam.lifecycle._extract_text_detections",
            return_value=[],
        ):
            v.predict_text(image_b64=_b64_zero_image(), text="hat")
        v.predict_point(
            point_coords=np.array([[2, 2]]),
            point_labels=np.array([1]),
        )
        assert build.call_count == 1


def test_predict_text_threshold_restored_after_call():
    fake_adapter = _build_fake_adapter()
    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=fake_adapter,
    ):
        v = Sam3p1Variant()
        v.load(device="cuda")
        with patch(
            "carve_model.sam.lifecycle._extract_text_detections",
            return_value=[],
        ):
            v.predict_text(image_b64=_b64_zero_image(), text="hat", threshold=0.2)
        assert fake_adapter._processor.set_confidence_threshold.call_count == 2


def test_predict_text_returns_rows_in_score_order():
    fake_adapter = _build_fake_adapter()
    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=fake_adapter,
    ):
        v = Sam3p1Variant()
        v.load(device="cuda")
        with patch(
            "carve_model.sam.lifecycle._extract_text_detections",
            return_value=[
                (np.zeros((4, 4), dtype=np.uint8), 0.4),
                (np.zeros((4, 4), dtype=np.uint8), 0.9),
            ],
        ):
            with patch(
                "carve_model.sam.lifecycle.encode_mask_rle",
                return_value=("rle", [4, 4]),
            ):
                with patch(
                    "carve_model.sam.lifecycle.mask_to_polygon",
                    return_value=[],
                ):
                    with patch(
                        "carve_model.sam.lifecycle.to_numpy_safe",
                        return_value=np.array([[0, 0, 1, 1], [0, 0, 2, 2]]),
                    ):
                        out = v.predict_text(
                            image_b64=_b64_zero_image(), text="hat"
                        )
        assert len(out) == 2
        assert out[0]["score"] == 0.9
        assert out[1]["score"] == 0.4
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_predict_text.py -v`
Expected: FAIL — `predict_text` still raises `NotImplementedError`.

- [ ] **Step 3: Add helper wrappers + migrate `predict_text`**

In `lifecycle.py`, add near the top (after the existing imports):

```python
import base64


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
```

Replace the `Sam3p1Variant.predict_text` stub with the migrated body. The body is essentially the current `make_sam3p1_text_predictor()._predict_from_text(...)` (in `sam3p1_adapter.py` around lines 1316-1478), with `_get_or_build_native_image_predictor()` replaced by `self._adapter`. Full body:

```python
    def predict_text(
        self,
        *,
        image_b64: str,
        text: str,
        threshold: float | None = None,
        use_vlm_fo1: bool = False,
    ) -> list[dict]:
        if self._adapter is None:
            raise RuntimeError("Sam3p1Variant.predict_text called before load()")

        torch = _import_torch()

        adapter = self._adapter
        image_np = _decode_image_b64_to_numpy(image_b64)
        adapter.set_image(image_np)
        self._cached_hash = _hash_image(image_np)
        self._cached_shape = (int(image_np.shape[0]), int(image_np.shape[1]))

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_predict_text.py -v`
Expected: PASS — all 3 tests green. The "shared adapter" test is the critical one.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/lifecycle.py \
        apps/model/tests/sam/test_lifecycle_predict_text.py
git commit -m "feat(sam-lifecycle): migrate Sam3p1Variant.predict_text body (unified adapter)"
```

---

### Task 2.2: `Sam3p1Variant.predict_box` body migration

**Files:**
- Modify: `apps/model/src/carve_model/sam/lifecycle.py`
- Read for reference: `apps/model/src/carve_model/sam/sam3p1_adapter.py` (search for `def make_sam3p1_box_predictor`)
- Test: `apps/model/tests/sam/test_lifecycle_predict_box.py`

- [ ] **Step 1: Write the failing test**

```python
# apps/model/tests/sam/test_lifecycle_predict_box.py
from unittest.mock import MagicMock, patch

import numpy as np

from carve_model.sam.lifecycle import Sam3p1Variant


def _b64_zero_image():
    import base64
    from io import BytesIO
    from PIL import Image
    pil = Image.fromarray(np.zeros((4, 4, 3), dtype=np.uint8))
    buf = BytesIO()
    pil.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def test_predict_box_uses_same_adapter():
    """Box prompts share the adapter with point + text."""
    adapter = MagicMock()
    adapter._device = "cuda"
    adapter._state = None

    def fake_set_image(image):
        adapter._state = {"original_height": 4, "original_width": 4}

    adapter.set_image.side_effect = fake_set_image

    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=adapter,
    ) as build:
        v = Sam3p1Variant()
        v.load(device="cuda")
        with patch.object(v, "_run_box_predict_inst", return_value=[]):
            v.predict_box(
                image_b64=_b64_zero_image(),
                boxes=[[0, 0, 1, 1]],
                box_labels=[1],
            )
        v.predict_point(
            point_coords=np.array([[2, 2]]),
            point_labels=np.array([1]),
        )
        assert build.call_count == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_predict_box.py -v`
Expected: FAIL — `predict_box` still raises `NotImplementedError`.

- [ ] **Step 3: Migrate `predict_box` body**

Read the existing `make_sam3p1_box_predictor` body in `sam3p1_adapter.py`. Replace `Sam3p1Variant.predict_box` with the migrated body, using the same pattern as `predict_text`:

- Replace `_get_or_build_native_image_predictor()` with `self._adapter`.
- Decode image_b64 → numpy → `self._adapter.set_image(...)` → update `self._cached_hash` / `self._cached_shape`.
- Factor the inner `_model.predict_inst(...)` call into a `self._run_box_predict_inst(**kw)` method so tests can stub it without bringing in torch.
- Return the same `[{counts, size, score, bbox, polygon}, ...]` shape as today.

(The exact body is ~80 lines and lives in `sam3p1_adapter.py` — copy verbatim, swapping the adapter source.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_predict_box.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/lifecycle.py \
        apps/model/tests/sam/test_lifecycle_predict_box.py
git commit -m "feat(sam-lifecycle): migrate Sam3p1Variant.predict_box body"
```

---

### Task 2.3: `Sam3p1Variant.predict_visual` body migration

**Files:**
- Modify: `apps/model/src/carve_model/sam/lifecycle.py`
- Read for reference: `apps/model/src/carve_model/sam/sam3_adapter.py` (search for `def make_sam3_visual_predictor`)
- Test: `apps/model/tests/sam/test_lifecycle_predict_visual.py`

- [ ] **Step 1: Write the failing test**

```python
# apps/model/tests/sam/test_lifecycle_predict_visual.py
from unittest.mock import MagicMock, patch

import numpy as np

from carve_model.sam.lifecycle import Sam3p1Variant


def _b64_zero_image():
    import base64
    from io import BytesIO
    from PIL import Image
    pil = Image.fromarray(np.zeros((4, 4, 3), dtype=np.uint8))
    buf = BytesIO()
    pil.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def test_predict_visual_uses_same_adapter():
    adapter = MagicMock()
    adapter._device = "cuda"
    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=adapter,
    ) as build:
        v = Sam3p1Variant()
        v.load(device="cuda")
        with patch.object(v, "_run_visual_inference", return_value=[]):
            v.predict_visual(
                image_b64=_b64_zero_image(),
                prompt_image_b64=_b64_zero_image(),
                prompt_box=[0, 0, 1, 1],
            )
        assert build.call_count == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_predict_visual.py -v`
Expected: FAIL.

- [ ] **Step 3: Migrate `predict_visual` body**

Read `make_sam3_visual_predictor` in `sam3_adapter.py` and locate the parts that build a sam3.1 adapter internally for the encode pass. Replace `Sam3p1Variant.predict_visual` with the migrated body:

- The internally-built sam3p1 adapter becomes `self._adapter`.
- Decode both image_b64 inputs to numpy.
- Factor the inner forward pass into `self._run_visual_inference(**kw)` so tests can stub.
- Return the existing `[{counts, size, score, bbox, polygon, concept}, ...]` shape.

(The body is ~150 lines — copy verbatim with the adapter swap.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_predict_visual.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/lifecycle.py \
        apps/model/tests/sam/test_lifecycle_predict_visual.py
git commit -m "feat(sam-lifecycle): migrate Sam3p1Variant.predict_visual body"
```

---

### Task 2.4: Phase 2 sanity check

- [ ] **Step 1: Run the entire SAM test suite**

Run: `cd apps/model && pytest tests/sam/ -v --tb=short`
Expected: PASS — all pre-existing tests green; new Phase 1 + Phase 2 tests green.

- [ ] **Step 2: If anything fails, reconcile the migrated body with the original**

The bodies in Tasks 2.1-2.3 are copies of the originals. A test failure means the copy drifted — diff against the original (`sam3p1_adapter.py` / `sam3_adapter.py`) and reconcile.

- [ ] **Step 3: Commit any reconciliation**

```bash
# Only if reconciliation was needed
git add apps/model/src/carve_model/sam/lifecycle.py
git commit -m "fix(sam-lifecycle): reconcile variant bodies with parity tests"
```

---

## Phase 3 — Router migration + test back-compat shims

**Phase goal:** Production code now goes through the manager. All 8 router endpoints rewritten. Test injection points (`set_test_predictor` and friends) preserved via back-compat shims. After this phase, the OOM bug is fixed.

### Task 3.1: `_LegacyTestVariant`

**Files:**
- Modify: `apps/model/src/carve_model/sam/lifecycle.py`
- Test: `apps/model/tests/sam/test_lifecycle_legacy_shim.py`

- [ ] **Step 1: Write the failing tests**

```python
# apps/model/tests/sam/test_lifecycle_legacy_shim.py
import numpy as np
import pytest

from carve_model.sam.lifecycle import (
    SamCapabilityError,
    _LegacyTestVariant,
)


def test_legacy_variant_with_only_point_impl():
    lv = _LegacyTestVariant()

    class FakePoint:
        def predict(self, **kw): return ("masks", "scores", "logits")

    lv._point_impl = FakePoint()
    masks, scores, logits = lv.predict_point(point_coords=None, point_labels=None)
    assert masks == "masks"
    with pytest.raises(SamCapabilityError):
        lv.predict_text(image_b64="", text="")


def test_legacy_variant_aggregates_multiple_impls():
    lv = _LegacyTestVariant()

    class FakePoint:
        def predict(self, **kw): return ("masks", "scores", "logits")

    lv._point_impl = FakePoint()
    lv._text_impl = lambda **kw: [{"score": 1.0}]
    assert lv.predict_text(image_b64="", text="hat") == [{"score": 1.0}]
    assert lv.predict_point(point_coords=None, point_labels=None)[0] == "masks"


def test_legacy_variant_capability_flags_track_impls():
    lv = _LegacyTestVariant()
    assert lv.supports_text is False
    lv._text_impl = lambda **kw: []
    assert lv.supports_text is True


def test_legacy_variant_set_image_returns_dummy_hash():
    lv = _LegacyTestVariant()
    h = lv.set_image(np.zeros((1, 1, 3), dtype=np.uint8))
    assert isinstance(h, str)
    assert lv.cached_image_hash() == h
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_legacy_shim.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement `_LegacyTestVariant`**

Append to `lifecycle.py`:

```python
class _LegacyTestVariant:
    """Aggregator that wraps the four old test-injection callables into one
    SamVariant. Used by predictor.py back-compat shims."""

    name = "legacy-test"
    device = None
    build_key = ("legacy-test", "fp32", "sdpa")

    def __init__(self) -> None:
        self._point_impl: Any | None = None
        self._text_impl: Any | None = None
        self._box_impl: Any | None = None
        self._visual_impl: Any | None = None
        self._cached_hash: str | None = None
        self._cached_shape: tuple[int, int] | None = None
        self._prev_logits: Any | None = None
        self._prev_n_points: int = 0

    @property
    def supports_text(self) -> bool: return self._text_impl is not None
    @property
    def supports_box(self) -> bool: return self._box_impl is not None
    @property
    def supports_visual(self) -> bool: return self._visual_impl is not None

    def load(self, device): pass
    def unload(self): pass

    def set_image(self, image: Any) -> str:
        h = _hash_image(image)
        self._cached_hash = h
        self._cached_shape = (int(image.shape[0]), int(image.shape[1]))
        if self._point_impl is not None and hasattr(self._point_impl, "set_image"):
            self._point_impl.set_image(image)
        return h

    def cached_image_hash(self) -> str | None: return self._cached_hash
    def cached_image_shape(self) -> tuple[int, int] | None: return self._cached_shape

    def extract_embedding(self) -> bytes | None:
        if self._point_impl is None:
            return None
        getter = getattr(self._point_impl, "extract_embedding", None)
        return getter() if getter is not None else None

    def set_prev_logits(self, low_res_logits, n_points):
        self._prev_logits = low_res_logits
        self._prev_n_points = int(n_points)

    def get_prev_logits(self):
        return (self._prev_logits, self._prev_n_points)

    def predict_point(self, **kw):
        if self._point_impl is None:
            raise SamCapabilityError("legacy variant: no point impl injected")
        if callable(self._point_impl):
            return self._point_impl(**kw)
        return self._point_impl.predict(**kw)

    def predict_text(self, **kw):
        if self._text_impl is None:
            raise SamCapabilityError("legacy variant: no text impl injected")
        return self._text_impl(**kw)

    def predict_box(self, **kw):
        if self._box_impl is None:
            raise SamCapabilityError("legacy variant: no box impl injected")
        return self._box_impl(**kw)

    def predict_visual(self, **kw):
        if self._visual_impl is None:
            raise SamCapabilityError("legacy variant: no visual impl injected")
        return self._visual_impl(**kw)
```

Add `"_LegacyTestVariant"` to `__all__`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_legacy_shim.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/lifecycle.py \
        apps/model/tests/sam/test_lifecycle_legacy_shim.py
git commit -m "feat(sam-lifecycle): add _LegacyTestVariant aggregator for back-compat shims"
```

---

### Task 3.2: Route `set_test_predictor` / `set_text_predictor` / `set_box_predictor` / `set_visual_predictor` through manager

**Files:**
- Modify: `apps/model/src/carve_model/sam/predictor.py`
- Test: `apps/model/tests/sam/test_lifecycle_legacy_shim_routes.py`

- [ ] **Step 1: Write the failing test**

```python
# apps/model/tests/sam/test_lifecycle_legacy_shim_routes.py
"""set_test_predictor / set_text_predictor must route through manager via
the _LegacyTestVariant aggregator."""
import pytest

from carve_model.sam.lifecycle import manager


@pytest.fixture(autouse=True)
def reset():
    yield
    manager._reset_for_tests()


def test_set_test_predictor_installs_legacy_variant():
    from carve_model.sam.predictor import set_test_predictor

    class FakePoint:
        def set_image(self, image): pass
        def predict(self, **kw): return ("m", "s", "l")
        def extract_embedding(self): return b"e"

    set_test_predictor(FakePoint())
    with manager.lease() as sam:
        m, s, l = sam.predict_point(point_coords=None, point_labels=None)
        assert m == "m"


def test_set_text_predictor_adds_text_impl():
    from carve_model.sam.predictor import set_test_predictor, set_text_predictor

    class FakePoint:
        def predict(self, **kw): return ("m", "s", "l")

    set_test_predictor(FakePoint())
    set_text_predictor(lambda **kw: [{
        "counts": "c", "size": [1, 1], "score": 0.5,
        "bbox": [0, 0, 1, 1], "polygon": []
    }])
    with manager.lease() as sam:
        rows = sam.predict_text(image_b64="b", text="t")
        assert rows[0]["score"] == 0.5


def test_set_test_predictor_none_clears():
    from carve_model.sam.predictor import set_test_predictor
    from carve_model.sam.lifecycle import SamCapabilityError, SamNotReadyError

    set_test_predictor(object())
    set_test_predictor(None)
    # Test variant cleared — lease now sees production state (idle)
    with pytest.raises(SamNotReadyError):
        with manager.lease() as sam:
            sam.predict_point(point_coords=None, point_labels=None)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_legacy_shim_routes.py -v`
Expected: FAIL — current `set_test_predictor` still mutates `_SESSION`.

- [ ] **Step 3: Rewrite the test-shim section of `predictor.py`**

In `apps/model/src/carve_model/sam/predictor.py`, locate the existing `set_test_predictor`, `set_text_predictor`, `set_box_predictor`, `set_visual_predictor`, `reset_text_predictor`, `reset_box_predictor`, `_reset_visual_predictor_for_test` functions. Replace their bodies:

```python
# Add to imports at the top of predictor.py
from carve_model.sam.lifecycle import (
    _LegacyTestVariant,
    manager as _sam_manager,
)


def _legacy_variant() -> _LegacyTestVariant:
    """Get or create the singleton _LegacyTestVariant installed on the manager."""
    v = _sam_manager._test_variant
    if not isinstance(v, _LegacyTestVariant):
        v = _LegacyTestVariant()
        _sam_manager.install_test_variant(v)
    return v


def _legacy_clear(op: str) -> None:
    v = _sam_manager._test_variant
    if not isinstance(v, _LegacyTestVariant):
        return
    setattr(v, f"_{op}_impl", None)
    if all(
        getattr(v, f"_{o}_impl") is None
        for o in ("point", "text", "box", "visual")
    ):
        _sam_manager.install_test_variant(None)


def set_test_predictor(p) -> None:
    if p is None:
        _legacy_clear("point")
        return
    _legacy_variant()._point_impl = p


def set_text_predictor(fn) -> None:
    if fn is None:
        _legacy_clear("text")
        return
    _legacy_variant()._text_impl = fn


def set_box_predictor(fn) -> None:
    if fn is None:
        _legacy_clear("box")
        return
    _legacy_variant()._box_impl = fn


def set_visual_predictor(fn) -> None:
    if fn is None:
        _legacy_clear("visual")
        return
    _legacy_variant()._visual_impl = fn


def reset_text_predictor() -> None: _legacy_clear("text")
def reset_box_predictor() -> None: _legacy_clear("box")
def _reset_visual_predictor_for_test() -> None: _legacy_clear("visual")
```

(Leave the other predictor.py functions like `get_predictor`, `load_predictor`, etc. with their original bodies for now — they'll be migrated piecewise in Tasks 3.3-3.6 and removed in Phase 5.)

- [ ] **Step 4: Run the new test plus the full SAM test suite**

Run: `cd apps/model && pytest tests/sam/ -v --tb=short`
Expected: PASS — new shim test green; existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/predictor.py \
        apps/model/tests/sam/test_lifecycle_legacy_shim_routes.py
git commit -m "feat(sam-lifecycle): route test seams through manager via _LegacyTestVariant"
```

---

### Task 3.3: Migrate `/sam/encode` and `/sam/decode` to `manager.lease_or_load()`

**Files:**
- Modify: `apps/model/src/carve_model/sam/router.py` (encode + decode endpoints)
- Modify: `apps/model/tests/sam/conftest.py` (add `fake_sam_with_point` fixture)
- Test: `apps/model/tests/sam/test_router.py`

- [ ] **Step 1: Add the new test and fixture**

Append to `apps/model/tests/sam/conftest.py`:

```python
import numpy as np
import pytest

from carve_model.sam.lifecycle import manager


@pytest.fixture
def fake_sam_with_point():
    """Install a point predictor via the legacy shim."""
    from carve_model.sam.predictor import set_test_predictor

    class FakePoint:
        def set_image(self, image): pass
        def predict(self, **kw):
            return (
                np.zeros((1, 4, 4), dtype=bool),
                np.array([0.9]),
                np.zeros((1, 256, 256), dtype=np.float32),
            )
        def extract_embedding(self): return b"emb"

    set_test_predictor(FakePoint())
    try:
        yield
    finally:
        set_test_predictor(None)
        manager._reset_for_tests()
```

Append to `apps/model/tests/sam/test_router.py`:

```python
def test_decode_uses_manager_lease(client, fake_sam_with_point):
    """End-to-end check that /sam/encode + /sam/decode go through manager.lease_or_load."""
    import base64
    import numpy as np
    from io import BytesIO
    from PIL import Image
    pil = Image.fromarray(np.zeros((4, 4, 3), dtype=np.uint8))
    buf = BytesIO()
    pil.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    r = client.post("/sam/encode", json={"image_b64": b64})
    assert r.status_code == 200
    image_hash = r.json()["image_hash"]
    r2 = client.post("/sam/decode", json={
        "image_hash": image_hash,
        "point_coords": [[2, 2]],
        "point_labels": [1],
    })
    assert r2.status_code == 200
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/model && pytest tests/sam/test_router.py::test_decode_uses_manager_lease -v`
Expected: FAIL — endpoints still use the old path.

- [ ] **Step 3: Rewrite `/sam/encode` and `/sam/decode` in `router.py`**

In `apps/model/src/carve_model/sam/router.py`, replace the bodies of the two route handlers. Keep their response schemas and helper imports unchanged. Skeleton:

```python
# /sam/encode
@router.post("/encode", response_model=EncodeOut)
def sam_encode(payload: EncodeIn) -> dict:
    import base64
    import numpy as np
    from io import BytesIO
    from PIL import Image

    from carve_model.sam.lifecycle import manager, SamNotReadyError

    img_bytes = base64.b64decode(payload.image_b64)
    pil = Image.open(BytesIO(img_bytes)).convert("RGB")
    image_np = np.asarray(pil, dtype="uint8")

    try:
        with admit(CostClass.SAM_ENCODE):
            with manager.lease_or_load() as sam:
                image_hash = sam.set_image(image_np)
                embedding = sam.extract_embedding()
    except SamNotReadyError as e:
        raise HTTPException(status_code=503, detail=f"sam_{e.state}") from e
    return {
        "image_hash": image_hash,
        "shape": [int(image_np.shape[0]), int(image_np.shape[1])],
        "embedding_b64": (
            base64.b64encode(embedding).decode("ascii") if embedding else None
        ),
    }


# /sam/decode
@router.post("/decode", response_model=DecodeOut)
def sam_decode(payload: DecodeIn) -> dict:
    import numpy as np

    from carve_model.sam.lifecycle import manager, SamNotReadyError

    try:
        with admit(CostClass.SAM_DECODE):
            with manager.lease_or_load() as sam:
                cached = sam.cached_image_hash()
                if cached != payload.image_hash:
                    raise HTTPException(
                        status_code=422,
                        detail="image_not_cached",
                    )
                prev_logits, prev_n = sam.get_prev_logits()
                mask_input = prev_logits if prev_n > 0 else None

                point_coords = (
                    np.array(payload.point_coords, dtype=np.float32)
                    if payload.point_coords else None
                )
                point_labels = (
                    np.array(payload.point_labels, dtype=np.int32)
                    if payload.point_labels else None
                )
                masks, scores, logits = sam.predict_point(
                    point_coords=point_coords,
                    point_labels=point_labels,
                    box=None,
                    mask_input=mask_input,
                    multimask_output=payload.multimask_output,
                )
                if logits is not None and scores is not None:
                    import numpy as _np
                    best = int(_np.argmax(scores))
                    sam.set_prev_logits(
                        logits[best:best + 1],
                        int(point_labels.shape[0]) if point_labels is not None else 0,
                    )
    except SamNotReadyError as e:
        raise HTTPException(status_code=503, detail=f"sam_{e.state}") from e
    return _build_decode_response(masks, scores, logits)
```

If `_build_decode_response` (or equivalent) doesn't already exist as a helper, keep the existing response-construction code inline.

- [ ] **Step 4: Run the tests**

Run: `cd apps/model && pytest tests/sam/test_router.py -v`
Expected: PASS — old tests still green; new test green.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/router.py \
        apps/model/tests/sam/test_router.py \
        apps/model/tests/sam/conftest.py
git commit -m "refactor(sam): route /sam/encode and /sam/decode through manager.lease_or_load"
```

---

### Task 3.4: Migrate `/sam/text-prompt`, `/sam/box-prompt`, `/sam/visual-prompt` to manager

**Files:**
- Modify: `apps/model/src/carve_model/sam/router.py`
- Modify: `apps/model/tests/sam/conftest.py` (add fake_sam_with_text fixture)
- Test: New `apps/model/tests/sam/test_router_manager.py` plus existing text/box/visual tests

- [ ] **Step 1: Add fixture and write tests**

Append to `apps/model/tests/sam/conftest.py`:

```python
@pytest.fixture
def fake_sam_with_text():
    from carve_model.sam.predictor import set_text_predictor
    set_text_predictor(lambda **kw: [{
        "counts": "c", "size": [4, 4], "score": 0.7,
        "bbox": [0, 0, 1, 1], "polygon": [],
    }])
    try:
        yield
    finally:
        set_text_predictor(None)
        from carve_model.sam.lifecycle import manager
        manager._reset_for_tests()
```

Create `apps/model/tests/sam/test_router_manager.py`:

```python
import base64
from io import BytesIO

import numpy as np
import pytest
from PIL import Image


def _b64():
    pil = Image.fromarray(np.zeros((4, 4, 3), dtype=np.uint8))
    buf = BytesIO()
    pil.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def test_text_prompt_uses_manager(client, fake_sam_with_text):
    r = client.post("/sam/text-prompt", json={"image_b64": _b64(), "text": "hat"})
    assert r.status_code == 200
    rows = r.json()
    assert rows[0]["score"] == 0.7


def test_text_prompt_returns_409_when_variant_unsupported(client):
    """A variant with no text impl (sam2-flavored stub) → 409."""
    from carve_model.sam.predictor import set_test_predictor

    class FakePoint:
        def predict(self, **kw): return (None, None, None)
        def extract_embedding(self): return None

    set_test_predictor(FakePoint())
    try:
        r = client.post("/sam/text-prompt", json={"image_b64": _b64(), "text": "hat"})
        assert r.status_code == 409
        assert "not_supported" in r.json()["detail"]
    finally:
        set_test_predictor(None)
        from carve_model.sam.lifecycle import manager
        manager._reset_for_tests()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/model && pytest tests/sam/test_router_manager.py -v`
Expected: FAIL — endpoints still use the old factory path.

- [ ] **Step 3: Rewrite text/box/visual endpoints in `router.py`**

```python
@router.post("/text-prompt", response_model=list[TextPromptOut])
def sam_text_prompt(payload: TextPromptIn) -> list[dict]:
    from carve_model.sam.lifecycle import manager, SamNotReadyError

    try:
        with manager.lease_or_load() as sam:
            if not sam.supports_text:
                raise HTTPException(
                    status_code=409,
                    detail="text_prompt_not_supported_for_variant",
                )
            with admit(CostClass.SAM_TEXT):
                kwargs: dict = {"image_b64": payload.image_b64, "text": payload.text}
                if payload.use_vlm_fo1:
                    kwargs["use_vlm_fo1"] = True
                if payload.threshold is not None:
                    kwargs["threshold"] = payload.threshold
                return sam.predict_text(**kwargs)
    except SamNotReadyError as e:
        raise HTTPException(status_code=503, detail=f"sam_{e.state}") from e


@router.post("/box-prompt", response_model=list[BoxPromptOut])
def sam_box_prompt(payload: BoxPromptIn) -> list[dict]:
    from carve_model.sam.lifecycle import manager, SamNotReadyError

    if len(payload.boxes) != len(payload.box_labels):
        raise HTTPException(422, "boxes and box_labels must have equal length")
    if any(l not in (0, 1) for l in payload.box_labels):
        raise HTTPException(422, "box_labels must be 0 or 1")
    try:
        with manager.lease_or_load() as sam:
            if not sam.supports_box:
                raise HTTPException(409, "box_prompt_not_supported_for_variant")
            with admit(CostClass.SAM_BOX):
                return sam.predict_box(
                    image_b64=payload.image_b64,
                    boxes=payload.boxes,
                    box_labels=payload.box_labels,
                    text=payload.text,
                )
    except SamNotReadyError as e:
        raise HTTPException(status_code=503, detail=f"sam_{e.state}") from e


@router.post("/visual-prompt", response_model=list[VisualPromptOut])
def sam_visual_prompt(payload: VisualPromptIn) -> list[dict]:
    from carve_model.sam.lifecycle import manager, SamNotReadyError

    try:
        with manager.lease_or_load() as sam:
            if not sam.supports_visual:
                raise HTTPException(409, "visual_prompt_not_supported_for_variant")
            with admit(CostClass.SAM_VISUAL):
                return sam.predict_visual(
                    image_b64=payload.image_b64,
                    prompt_image_b64=payload.prompt_image_b64,
                    prompt_box=payload.prompt_box,
                    threshold=payload.threshold,
                )
    except SamNotReadyError as e:
        raise HTTPException(status_code=503, detail=f"sam_{e.state}") from e
```

- [ ] **Step 4: Run all router tests**

Run: `cd apps/model && pytest tests/sam/test_text_router.py tests/sam/test_box_router.py tests/sam/test_visual_predictor_factory.py tests/sam/test_router_manager.py -v --tb=short`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/router.py \
        apps/model/tests/sam/conftest.py \
        apps/model/tests/sam/test_router_manager.py
git commit -m "refactor(sam): route /sam/{text,box,visual}-prompt through manager"
```

---

### Task 3.5: Migrate `/sam/status` and `/sam/unload`

**Files:**
- Modify: `apps/model/src/carve_model/sam/router.py`
- Test: `apps/model/tests/sam/test_status_endpoint.py`, `test_unload_router.py` must still pass

- [ ] **Step 1: Confirm existing tests pass on the old path**

Run: `cd apps/model && pytest tests/sam/test_status_endpoint.py tests/sam/test_unload_router.py -v`
Expected: PASS (currently passing).

- [ ] **Step 2: Rewrite the endpoints**

```python
@router.get("/status", response_model=StatusOut)
def sam_status() -> dict:
    from carve_model.sam.lifecycle import manager
    s = manager.status()
    payload: dict = {
        "state": s.kind,
        "variant": s.variant,
        "loaded_at": s.loaded_at,
        "started_at": s.started_at,
        "error": s.error,
    }
    payload.update(_gpu_memory_snapshot())
    return payload


@router.post("/unload", response_model=UnloadOut)
def sam_unload(payload: UnloadIn = Body(default_factory=UnloadIn)) -> dict:
    from carve_model.sam.lifecycle import manager
    freed = manager.force_unload()
    return {"freed": freed, "state": manager.status().kind}
```

(`_gpu_memory_snapshot()` already exists in the current router; keep it as-is.)

- [ ] **Step 3: Run the tests**

Run: `cd apps/model && pytest tests/sam/test_status_endpoint.py tests/sam/test_unload_router.py -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/model/src/carve_model/sam/router.py
git commit -m "refactor(sam): route /sam/status and /sam/unload through manager"
```

---

### Task 3.6: Migrate `/sam/switch` (and `/models/sam-active` if present)

**Files:**
- Modify: `apps/model/src/carve_model/sam/router.py` (or wherever the switch endpoint lives)
- Test: `apps/model/tests/sam/test_switch.py` must still pass

- [ ] **Step 1: Confirm existing test passes**

Run: `cd apps/model && pytest tests/sam/test_switch.py -v`
Expected: PASS.

- [ ] **Step 2: Rewrite endpoint**

```python
@router.post("/switch", response_model=SwitchOut)
def sam_switch(payload: SwitchIn) -> dict:
    """Switch active SAM variant. Returns 202 immediately; load happens in
    a background thread; client polls /sam/status."""
    import threading
    from carve_model.sam.lifecycle import manager

    def _do_load():
        try:
            manager.ensure_loaded(payload.variant)
        except Exception:
            log.exception("sam_switch background load failed")

    t = threading.Thread(target=_do_load, daemon=True)
    t.start()
    return {"accepted": True, "target_variant": payload.variant}
```

If `/models/sam-active` is in a separate router (e.g. `models_router.py`), apply the same pattern there.

- [ ] **Step 3: Run the test**

Run: `cd apps/model && pytest tests/sam/test_switch.py -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/model/src/carve_model/sam/router.py
git commit -m "refactor(sam): route /sam/switch through manager (202 + bg load)"
```

---

### Task 3.7: Phase 3 integration test — text→point with no double-load

**Files:**
- Test: `apps/model/tests/sam/test_lifecycle_no_double_load.py`

This is the headline test that proves the OOM bug is fixed.

- [ ] **Step 1: Write the test**

```python
# apps/model/tests/sam/test_lifecycle_no_double_load.py
"""Integration test for the original OOM bug: auto-annotate (text) followed
by an interactive click (point) must reuse the SAME sam3.1 model instance."""
import base64
from io import BytesIO
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
from PIL import Image

from carve_model.sam.lifecycle import manager


def _b64_image():
    pil = Image.fromarray(np.zeros((4, 4, 3), dtype=np.uint8))
    buf = BytesIO()
    pil.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


@pytest.fixture(autouse=True)
def reset():
    yield
    manager._reset_for_tests()


def test_text_then_point_no_second_adapter_build(client):
    """Critical: predict_text and predict_point share the adapter."""
    adapter = MagicMock()
    adapter._device = "cuda"
    adapter._state = None
    adapter.predict.return_value = (
        np.zeros((1, 4, 4), dtype=bool),
        np.array([0.9]),
        np.zeros((1, 256, 256), dtype=np.float32),
    )

    def fake_set_image(image):
        adapter._state = {"original_height": 4, "original_width": 4}

    adapter.set_image.side_effect = fake_set_image

    import os
    os.environ["SAM_MODEL"] = "sam3.1"

    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=adapter,
    ) as build:
        manager.ensure_loaded("sam3.1")

        with patch(
            "carve_model.sam.lifecycle._extract_text_detections",
            return_value=[(np.zeros((4, 4), dtype=np.uint8), 0.7)],
        ):
            with patch(
                "carve_model.sam.lifecycle.encode_mask_rle",
                return_value=("rle", [4, 4]),
            ):
                with patch(
                    "carve_model.sam.lifecycle.mask_to_polygon",
                    return_value=[],
                ):
                    with patch(
                        "carve_model.sam.lifecycle.to_numpy_safe",
                        return_value=np.array([[0, 0, 1, 1]]),
                    ):
                        r = client.post(
                            "/sam/text-prompt",
                            json={"image_b64": _b64_image(), "text": "hat"},
                        )
                        assert r.status_code == 200

        r2 = client.post("/sam/encode", json={"image_b64": _b64_image()})
        assert r2.status_code == 200
        image_hash = r2.json()["image_hash"]
        r3 = client.post("/sam/decode", json={
            "image_hash": image_hash,
            "point_coords": [[2, 2]],
            "point_labels": [1],
        })
        assert r3.status_code == 200

        assert build.call_count == 1, (
            f"_build_sam3p1_adapter called {build.call_count} times — "
            "the bug is back. text-prompt and point-prompt must share one adapter."
        )
```

- [ ] **Step 2: Run the test**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_no_double_load.py -v`
Expected: PASS — `build.call_count == 1`.

- [ ] **Step 3: Commit**

```bash
git add apps/model/tests/sam/test_lifecycle_no_double_load.py
git commit -m "test(sam-lifecycle): integration test for no-double-load (Phase 3 complete)"
```

---

## Phase 4 — Sweeper migration

**Phase goal:** The idle sweeper calls `manager.evict_if_idle()` instead of the legacy `evict_predictor_if_idle()`. Full SAM stack drops together on idle.

### Task 4.1: Switch the sweeper in `main.py`

**Files:**
- Modify: `apps/model/src/carve_model/main.py`
- Test: `apps/model/tests/sam/test_lifecycle_sweeper.py` (new)

- [ ] **Step 1: Write the test**

```python
# apps/model/tests/sam/test_lifecycle_sweeper.py
"""Sweeper integration: _sweep_loop calls manager.evict_if_idle on each tick."""
from unittest.mock import patch

from carve_model.sam.lifecycle import manager


def test_sweep_iteration_calls_manager_evict_if_idle():
    """Simulate one sweep loop iteration and verify it drives the manager."""
    called = []
    with patch.object(
        manager, "evict_if_idle", side_effect=lambda: called.append(True) or False
    ):
        # Run one iteration of _sweep_loop's body manually
        try:
            manager.evict_if_idle()
            from carve_model.sam.track_session import evict_idle_sessions
            evict_idle_sessions()
        except Exception:
            pass
    assert called == [True]
```

- [ ] **Step 2: Run test to verify it fails (or passes if main.py already routes this way)**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_sweeper.py -v`
Expected: PASS (the test asserts the call pattern; the actual integration is in Step 3).

Actually, the test above passes regardless of `main.py` state — what we need is to verify `_sweep_loop` itself uses the manager. Let's expand:

```python
def test_main_sweep_loop_imports_manager():
    """The _sweep_loop function in main.py must import manager from lifecycle."""
    import inspect
    from carve_model import main as main_mod
    src = inspect.getsource(main_mod._sweep_loop)
    assert "sam_manager.evict_if_idle" in src or "manager.evict_if_idle" in src, (
        "_sweep_loop must call manager.evict_if_idle (not the legacy "
        "evict_predictor_if_idle)"
    )
```

Run: `cd apps/model && pytest tests/sam/test_lifecycle_sweeper.py -v`
Expected: FAIL — `_sweep_loop` still calls the legacy function.

- [ ] **Step 3: Update `main.py`**

In `apps/model/src/carve_model/main.py`, locate `_sweep_loop` (around line 37). Change imports + body:

```python
# Update imports
from carve_model.sam.lifecycle import manager as sam_manager

# Update body
def _sweep_loop() -> None:
    """Idle-eviction loop. Swallows all exceptions so it never crashes the app."""
    while not _SWEEPER_STOP.wait(_SWEEP_INTERVAL_S):
        try:
            sam_manager.evict_if_idle()
            from carve_model.sam.track_session import evict_idle_sessions as _evict_track
            _evict_track()
            _YOLOE_REGISTRY.evict_idle()
        except Exception:
            log.exception("sam idle sweeper iteration failed")
```

Remove the obsolete `from carve_model.sam.predictor import evict_predictor_if_idle` import.

- [ ] **Step 4: Run the test plus existing eviction tests**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_sweeper.py tests/sam/test_eviction.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/main.py \
        apps/model/tests/sam/test_lifecycle_sweeper.py
git commit -m "refactor(sam): sweeper calls manager.evict_if_idle (Phase 4 complete)"
```

---

## Phase 5 — Dead code removal

**Phase goal:** Delete unused state and helpers from `predictor.py` and `sam3p1_adapter.py`. No behavior change.

### Task 5.1: Audit and delete `_NATIVE_IMAGE_PREDICTOR` family in `sam3p1_adapter.py`

**Files:**
- Modify: `apps/model/src/carve_model/sam/sam3p1_adapter.py`
- Test: Full SAM test suite

- [ ] **Step 1: Audit who still imports these symbols**

Run:
```bash
cd apps/model && grep -rn "_NATIVE_IMAGE_PREDICTOR\|_get_or_build_native_image_predictor\|_set_native_image_predictor_for_tests\|reset_native_image_predictor\|make_sam3p1_text_predictor\|make_sam3p1_box_predictor" src/ tests/
```

Expected: only the definitions in `sam3p1_adapter.py` itself, and possibly references in `apps/model/tests/sam/test_sam3p1_*.py`. If any *production* callsites remain in `predictor.py` or `router.py`, fix them first by routing through the manager. Test files that directly call `make_sam3p1_text_predictor` should be updated to inject via the manager fixture or removed if they're now redundant with Phase 1-2 tests.

- [ ] **Step 2: Delete the dead code**

In `apps/model/src/carve_model/sam/sam3p1_adapter.py`, remove:

- `_NATIVE_IMAGE_PREDICTOR` module global
- `_get_or_build_native_image_predictor()` function
- `_set_native_image_predictor_for_tests()` function
- `reset_native_image_predictor()` function
- `make_sam3p1_text_predictor()` function
- `make_sam3p1_box_predictor()` function

Keep: `Sam3p1NativeImagePredictorAdapter` class, `build_sam3p1_image_predictor`, `_extract_text_detections`, `_decode_image_b64_to_numpy`, and any other utility called by `lifecycle.py`.

- [ ] **Step 3: Update any tests that referenced the deleted symbols**

For each file flagged by the audit (Step 1) that exercised the deleted factory closures, either:
- Update it to use the manager fixture pattern (`fake_sam_with_text` etc.).
- Delete the file if its purpose is now covered by Phase 1-2 tests.

- [ ] **Step 4: Run the full test suite**

Run: `cd apps/model && pytest tests/sam/ -v --tb=short`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/sam3p1_adapter.py \
        apps/model/tests/
git commit -m "refactor(sam): delete dead _NATIVE_IMAGE_PREDICTOR + sam3p1 factory closures"
```

---

### Task 5.2: Shrink `predictor.py` to compat facade

**Files:**
- Modify: `apps/model/src/carve_model/sam/predictor.py`
- Test: Full SAM test suite

- [ ] **Step 1: Audit external imports**

```bash
cd apps/model && grep -rn "from carve_model.sam.predictor\|carve_model\.sam\.predictor" src/ tests/ \
    | grep -v "src/carve_model/sam/predictor.py"
```

Keep public symbols listed in the spec (Section 9 / module layout). Identify any callers that import the now-private internals (`_SESSION`, `_LOAD_STATE`, etc.) and fix them.

- [ ] **Step 2: Rewrite `predictor.py`**

Replace the entire file with a slim compat facade (about 250 lines). Skeleton:

```python
"""SAM predictor — compat facade over carve_model.sam.lifecycle.

Most production code paths now route through the manager directly. This
module remains as a shim so existing imports of:
  - test seams (set_test_predictor, set_text_predictor, ...)
  - get_predictor / get_session / set_loaded_image / set_prev_logits
keep working unchanged.

After all callers migrate to the manager, this file goes away.
"""
import logging
import os
import time
from types import SimpleNamespace
from typing import Any

from carve_model.sam.lifecycle import (
    LoadState,
    SamLifecycleManager,
    SamNotReadyError,
    _LegacyTestVariant,
    manager as _sam_manager,
)


log = logging.getLogger(__name__)


# ---- variant catalog ----

ALLOWED_SAM_MODELS: tuple[str, ...] = (
    "sam2.1-tiny",
    "sam2.1-small",
    "sam2.1-base-plus",
    "sam2.1-large",
    "sam3",     # legacy — remapped to sam3.1 in get_sam_model
    "sam3.1",
)
DEFAULT_SAM_MODEL = "sam2.1-large"


def get_sam_model() -> str:
    raw = os.environ.get("SAM_MODEL", DEFAULT_SAM_MODEL).strip()
    if raw == "sam2":
        raw = DEFAULT_SAM_MODEL
    if raw == "sam3":   # Phase 6 adds the warn-once log
        raw = "sam3.1"
    return raw


def is_sam3_family() -> bool:
    return get_sam_model().startswith("sam3")


def get_sam_variant() -> str:
    """Legacy alias. Returns 'sam3' for sam3.x, 'sam2' for sam2.x."""
    return "sam3" if is_sam3_family() else "sam2"


# ---- test seams (route to manager via _LegacyTestVariant) ----

def _legacy_variant() -> _LegacyTestVariant:
    v = _sam_manager._test_variant
    if not isinstance(v, _LegacyTestVariant):
        v = _LegacyTestVariant()
        _sam_manager.install_test_variant(v)
    return v


def _legacy_clear(op: str) -> None:
    v = _sam_manager._test_variant
    if not isinstance(v, _LegacyTestVariant):
        return
    setattr(v, f"_{op}_impl", None)
    if all(
        getattr(v, f"_{o}_impl") is None
        for o in ("point", "text", "box", "visual")
    ):
        _sam_manager.install_test_variant(None)


def set_test_predictor(p) -> None:
    if p is None: _legacy_clear("point"); return
    _legacy_variant()._point_impl = p


def set_text_predictor(fn) -> None:
    if fn is None: _legacy_clear("text"); return
    _legacy_variant()._text_impl = fn


def set_box_predictor(fn) -> None:
    if fn is None: _legacy_clear("box"); return
    _legacy_variant()._box_impl = fn


def set_visual_predictor(fn) -> None:
    if fn is None: _legacy_clear("visual"); return
    _legacy_variant()._visual_impl = fn


def reset_text_predictor() -> None: _legacy_clear("text")
def reset_box_predictor() -> None: _legacy_clear("box")
def _reset_visual_predictor_for_test() -> None: _legacy_clear("visual")


# ---- manager-facing compat ----

def get_predictor() -> Any:
    """Return the active variant. Raises RuntimeError if not loaded."""
    s = _sam_manager.status()
    if s.kind != "ready" or _sam_manager._active is None:
        raise RuntimeError(f"sam not ready: state={s.kind}")
    return _sam_manager._active


def get_text_predictor():
    v = _sam_manager._test_variant or _sam_manager._active
    if v is None:
        raise RuntimeError("text predictor not configured")
    return v.predict_text


def get_box_predictor():
    v = _sam_manager._test_variant or _sam_manager._active
    if v is None:
        raise RuntimeError("box predictor not configured")
    return v.predict_box


def get_visual_predictor():
    v = _sam_manager._test_variant or _sam_manager._active
    if v is None:
        raise RuntimeError("visual predictor not configured")
    return v.predict_visual


def load_predictor(variant: str) -> None:
    _sam_manager.ensure_loaded(variant)


def force_evict_predictor() -> bool:
    return _sam_manager.force_unload()


def evict_predictor_if_idle() -> bool:
    return _sam_manager.evict_if_idle()


def get_load_state() -> LoadState:
    return _sam_manager.status()


def touch_predictor() -> None:
    with _sam_manager._load_lock:
        if _sam_manager._active is not None:
            _sam_manager._last_used_at = time.monotonic()


# ---- per-image cache compat ----

def get_session():
    """Compat — returns a SimpleNamespace mirror of the legacy SamSession."""
    v = _sam_manager._test_variant or _sam_manager._active
    if v is None:
        return None
    return SimpleNamespace(
        predictor=v,
        loaded_hash=v.cached_image_hash(),
        loaded_shape=v.cached_image_shape(),
        last_used_at=_sam_manager._last_used_at or 0.0,
        build_key=v.build_key,
    )


def set_loaded_image(image_hash: str, shape) -> None:
    """No-op compat shim — variant.set_image already caches."""
    return None


def set_prev_logits(low_res_logits: Any | None, n_points: int) -> None:
    v = _sam_manager._test_variant or _sam_manager._active
    if v is None:
        return
    v.set_prev_logits(low_res_logits, n_points)


# ---- FO1 filter (unchanged) ----

_VLM_FO1_FILTER: Any | None = None


def set_vlm_fo1_filter(fn) -> None:
    global _VLM_FO1_FILTER
    _VLM_FO1_FILTER = fn


def get_vlm_fo1_filter():
    return _VLM_FO1_FILTER


def reset_vlm_fo1_filter() -> None:
    global _VLM_FO1_FILTER
    _VLM_FO1_FILTER = None
```

- [ ] **Step 3: Run the full test suite**

Run: `cd apps/model && pytest tests/sam/ -v --tb=short`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/model/src/carve_model/sam/predictor.py
git commit -m "refactor(sam): shrink predictor.py to compat facade (~250 lines)"
```

---

## Phase 6 — Drop `sam3` (transformers) family

### Task 6.1: Add `SAM_MODEL=sam3` deprecation warning (warn-once)

**Files:**
- Modify: `apps/model/src/carve_model/sam/predictor.py`
- Test: `apps/model/tests/sam/test_lifecycle_sam3_deprecation.py`

- [ ] **Step 1: Write the test**

```python
# apps/model/tests/sam/test_lifecycle_sam3_deprecation.py
import logging


def test_sam3_env_remaps_to_sam3p1(monkeypatch, caplog):
    from carve_model.sam.predictor import get_sam_model
    import carve_model.sam.predictor as p

    monkeypatch.setenv("SAM_MODEL", "sam3")
    p._SAM3_WARNED = False
    caplog.set_level(logging.WARNING, logger="carve_model.sam.predictor")

    name = get_sam_model()
    assert name == "sam3.1"
    assert any(
        "sam3" in rec.message and "deprecated" in rec.message.lower()
        for rec in caplog.records
    )


def test_sam3_warning_fires_only_once(monkeypatch, caplog):
    from carve_model.sam.predictor import get_sam_model
    import carve_model.sam.predictor as p

    monkeypatch.setenv("SAM_MODEL", "sam3")
    p._SAM3_WARNED = False
    caplog.set_level(logging.WARNING, logger="carve_model.sam.predictor")
    get_sam_model()
    get_sam_model()
    get_sam_model()
    deprecation_logs = [
        r for r in caplog.records if "deprecated" in r.message.lower()
    ]
    assert len(deprecation_logs) == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_sam3_deprecation.py -v`
Expected: FAIL.

- [ ] **Step 3: Update `get_sam_model`**

In `apps/model/src/carve_model/sam/predictor.py`, add the warn-once flag and the warning:

```python
_SAM3_WARNED = False


def get_sam_model() -> str:
    global _SAM3_WARNED
    raw = os.environ.get("SAM_MODEL", DEFAULT_SAM_MODEL).strip()
    if raw == "sam2":
        raw = DEFAULT_SAM_MODEL
    if raw == "sam3":
        if not _SAM3_WARNED:
            log.warning(
                "SAM_MODEL=sam3 is deprecated; remapping to sam3.1 "
                "(same accuracy, single model on GPU). Update your env to silence this warning."
            )
            _SAM3_WARNED = True
        raw = "sam3.1"
    return raw
```

- [ ] **Step 4: Run the test**

Run: `cd apps/model && pytest tests/sam/test_lifecycle_sam3_deprecation.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/predictor.py \
        apps/model/tests/sam/test_lifecycle_sam3_deprecation.py
git commit -m "feat(sam-lifecycle): add SAM_MODEL=sam3 deprecation warning (warn-once)"
```

---

### Task 6.2: Move visual-prompt helpers from `sam3_adapter.py` to safer homes

**Files:**
- Audit: `apps/model/src/carve_model/sam/sam3_adapter.py`
- Modify: `apps/model/src/carve_model/sam/lifecycle.py` (and possibly `codec.py` / `polygonize.py`)
- Test: existing visual-prompt tests

- [ ] **Step 1: Audit external imports of sam3_adapter symbols**

```bash
cd apps/model && grep -rn "from carve_model.sam.sam3_adapter\|sam3_adapter\." src/ tests/ \
    | grep -v "src/carve_model/sam/sam3_adapter.py"
```

For each surviving import:
- Pure helpers (e.g. capture_image_size, RLE/polygon composition) → move to `codec.py` or `polygonize.py`.
- `make_sam3_visual_predictor` → already migrated to `Sam3p1Variant.predict_visual` (Task 2.3); update callsites to use the manager.
- `make_sam3_text_predictor` / `make_sam3_box_predictor` (the sam3 transformers ones) → these are being deleted in Task 6.3; their callsites (tests) must be deleted or rewritten.

- [ ] **Step 2: Move each surviving helper to its natural home**

For each helper still imported from `sam3_adapter`, copy it to the appropriate target module and update the import in the consuming file. Remove the original from `sam3_adapter.py`.

- [ ] **Step 3: Run the SAM test suite**

Run: `cd apps/model && pytest tests/sam/ -v --tb=short`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/model/src/carve_model/sam/ apps/model/tests/sam/
git commit -m "refactor(sam): relocate sam3_adapter helpers to codec/polygonize/lifecycle"
```

---

### Task 6.3: Delete `sam3_adapter.py` + remove sam3 from allowlist

**Files:**
- Delete: `apps/model/src/carve_model/sam/sam3_adapter.py`
- Modify: `apps/model/src/carve_model/sam/predictor.py` (`ALLOWED_SAM_MODELS`)
- Delete: `apps/model/tests/sam/test_sam3_adapter.py`, `apps/model/tests/sam/test_sam3_factories.py`
- Test: full suite

- [ ] **Step 1: Verify no remaining imports**

```bash
cd apps/model && grep -rn "sam3_adapter" src/ tests/
```

Expected: only `sam3_adapter.py` itself, and the two `test_sam3_*.py` files we're deleting.

- [ ] **Step 2: Delete the files**

```bash
cd apps/model
rm src/carve_model/sam/sam3_adapter.py
rm tests/sam/test_sam3_adapter.py
rm tests/sam/test_sam3_factories.py
```

- [ ] **Step 3: Remove `"sam3"` from `ALLOWED_SAM_MODELS`**

In `apps/model/src/carve_model/sam/predictor.py`:

```python
ALLOWED_SAM_MODELS: tuple[str, ...] = (
    "sam2.1-tiny",
    "sam2.1-small",
    "sam2.1-base-plus",
    "sam2.1-large",
    "sam3.1",
    # Note: legacy "sam3" env value still accepted via get_sam_model's remap,
    # but no longer a first-class variant name.
)
```

- [ ] **Step 4: Run the full test suite**

Run: `cd apps/model && pytest tests/ -v --tb=short`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(sam): drop sam3 (transformers) variant; SAM_MODEL=sam3 auto-remaps"
```

---

### Task 6.4: Final integration sanity (smoke)

This is a smoke check before PR submission. Not a TDD task.

- [ ] **Step 1: Build the model container**

```bash
cd /home/media4us/Documents/Dev/VisualAutoAnnotator
docker compose build model
```
Expected: build succeeds.

- [ ] **Step 2: Start the model container**

```bash
docker compose up -d model
```
Expected: container reaches "Up" within ~30s.

- [ ] **Step 3: Check `/sam/status`**

```bash
curl -s http://localhost:<MODEL_PORT>/sam/status | jq .
```
Expected: `{"state": "idle", ...}`.

- [ ] **Step 4: Switch to sam3.1**

```bash
curl -s -X POST http://localhost:<MODEL_PORT>/sam/switch -d '{"variant": "sam3.1"}' -H 'Content-Type: application/json'
```
Then poll `/sam/status` until `state == "ready"`. Expected: 5–15s.

- [ ] **Step 5: Smoke test the original bug — text→point on a real image**

Hit `/sam/text-prompt` with a small image; then `/sam/encode` + `/sam/decode` on the same image. Run `nvidia-smi --query-compute-apps=pid,used_memory --format=csv` before and after each. Expected: VRAM usage hovers around one model's worth (~5 GB for sam3.1), not two.

- [ ] **Step 6: `/sam/unload` and verify VRAM returns to baseline**

```bash
curl -s -X POST http://localhost:<MODEL_PORT>/sam/unload
nvidia-smi
```
Expected: GPU memory back to pre-load baseline.

- [ ] **Step 7: (No commit — smoke test only)**

If anything failed, fix it as a separate commit; do not bundle smoke-test fixes with the refactor.

---

## Phase 7 — PR submission

### Task 7.1: Open PR

- [ ] **Step 1: Create PR with this body**

```
## Summary
- Unifies SAM model lifecycle in apps/model so at most one variant is GPU-resident
- Fixes production OOM where sam3.1 text-prompt and point-prompt loaded two copies of the same model on a 12 GB RTX 4070
- Idle eviction now releases all SAM state, not just _SESSION
- Strict inference serialization fixes a latent _state race on the native adapter
- Drops sam3 (transformers) family; SAM_MODEL=sam3 auto-remaps to sam3.1 with a one-time deprecation warning

## Architecture
- New apps/model/src/carve_model/sam/lifecycle.py: SamLifecycleManager + SamVariant protocol + Sam2Variant + Sam3p1Variant
- apps/model/src/carve_model/sam/predictor.py shrinks from ~1100 to ~250 lines (compat facade)
- apps/model/src/carve_model/sam/sam3_adapter.py deleted

## Test plan
- [x] All existing tests pass via back-compat shims (set_test_predictor + friends)
- [x] New unit tests: state machine, lock discipline, capability flags
- [x] New integration test: text→point no double-load (tests/sam/test_lifecycle_no_double_load.py)
- [ ] GPU smoke: load sam3.1, text-prompt + point-prompt, observe nvidia-smi stays at ~5 GB not ~10 GB
- [ ] GPU smoke: switch sam3.1 → sam2.1-large, observe VRAM drops before new model loads
- [ ] GPU smoke: idle for SAM_IDLE_TIMEOUT_S=10, observe sweeper releases VRAM

## Migration notes
- SAM_MODEL=sam3 still accepted; logs one-time deprecation warning at startup.
- Existing /sam/* HTTP contract unchanged.
- Spec: docs/superpowers/specs/2026-05-14-sam-lifecycle-manager-design.md
```

---

## Self-Review

**Spec coverage:**
- ✅ Section 1 (Context / bugs) — Phases 1-3 unify the manager + variant
- ✅ Section 2 (Goals) — Phases 1-4 cover all six goals
- ✅ Section 3 (Non-goals) — sweeper change in Task 4.1 keeps tracking + YOLOE + FO1 untouched
- ✅ Section 4 (Architectural decisions) — encoded across tasks
- ✅ Section 5.1 SamVariant protocol — Task 1.3
- ✅ Section 5.2 Sam2Variant + Sam3p1Variant — Tasks 1.4, 1.5, 2.1-2.3
- ✅ Section 5.3 SamLifecycleManager — Tasks 1.6-1.11
- ✅ Section 5.4 State machine — Tasks 1.9, 1.10
- ✅ Section 6 Operation flows — Tasks 1.8-1.11
- ✅ Section 7 Error handling — Tasks 1.8, 1.9 + router HTTP mapping in 3.3-3.6
- ✅ Section 8 Test seams — Tasks 3.1-3.2 + conftest fixtures
- ✅ Section 9 Module layout — across Phases 1, 3, 5, 6
- ✅ Section 10 Migration plan — 6 phases mirror 1:1
- ✅ Section 11 Risks — shims preserve tests (Task 3.2), audit in 5.1
- ✅ Section 12 Acceptance criteria — Task 3.7 (no double-load), Task 4.1 (sweeper), Task 6.4 (GPU smoke)

**Placeholder scan:** Tasks 2.2 and 2.3 instruct the implementer to "copy verbatim" the body from a named source (`make_sam3p1_box_predictor` / `make_sam3_visual_predictor`) rather than reproducing 80-150 lines of currently-working code inline. The plan identifies the exact source files and symbol names. This is a deliberate trade-off to avoid drift between the plan and the source of truth — the implementer reads the canonical body and copies it with the adapter swap. Not a placeholder; an explicit pointer.

Task 6.4 lists smoke-test steps without code — these are operator-run shell commands and curl invocations, intentionally not TDD.

**Type / method-name consistency:** Verified consistent across all tasks: `predict_point`, `predict_text`, `predict_box`, `predict_visual`, `set_image`, `cached_image_hash`, `cached_image_shape`, `set_prev_logits`, `get_prev_logits`, `extract_embedding`, `load`, `unload`, `ensure_loaded`, `lease`, `lease_or_load`, `force_unload`, `evict_if_idle`, `status`, `install_test_variant`, `remembered_variant`, `_reset_for_tests`, `_run_cuda_cleanup`, `_run_cuda_cleanup_light`, `_try_unload_locked`, `_idle_timeout_s`, `_env_default_variant`, `_resolve_device`, `_build_variant`, `_hash_image`, `_is_cuda_oom`. All used identically across tasks.
