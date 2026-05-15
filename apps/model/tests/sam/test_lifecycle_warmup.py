"""Regression tests for the post-load warmup step.

The lifecycle manager flips ``state→ready`` only after ``variant.warmup()``
has run a synthetic encoder forward pass against the just-built adapter.
This prevents the frontend's "SAM ready" toast from firing 1-10 s before
the first real /sam/encode can actually serve a click — the bug that
made users perceive a crashed tool when they clicked the canvas
immediately after the toast appeared.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from carve_model.sam.lifecycle import (
    Sam2Variant,
    Sam3p1Variant,
    SamLifecycleManager,
    SamLoadError,
    _build_warmup_image,
    _run_warmup,
)


def test_warmup_image_is_64x64_uint8_with_bright_square() -> None:
    img = _build_warmup_image()
    assert img.shape == (64, 64, 3)
    assert img.dtype == np.uint8
    # Outer frame is black, inner square (quarter inset) is white — a
    # deliberate non-trivial pattern so preprocessors that short-circuit
    # on flat-black inputs still exercise the full encoder path.
    assert int(img[0, 0, 0]) == 0
    assert int(img[32, 32, 0]) == 255


def test_run_warmup_resets_variant_cache_after_set_image() -> None:
    """Warmup must clear the dummy hash so the user's first real
    /sam/encode re-encodes against the actual image."""
    fake_adapter = MagicMock()
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=fake_adapter,
    ):
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
    assert v.cached_image_hash() is None
    _run_warmup(v)
    # set_image stamped a hash; warmup MUST clear it so the next real
    # /sam/encode doesn't accept the dummy hash.
    assert v.cached_image_hash() is None
    assert v._prev_logits is None
    assert v._prev_n_points == 0
    fake_adapter.set_image.assert_called_once()


def test_sam2_variant_warmup_invokes_run_warmup() -> None:
    fake_adapter = MagicMock()
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=fake_adapter,
    ):
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
    with patch("carve_model.sam.lifecycle._run_warmup") as run:
        v.warmup()
        run.assert_called_once_with(v)


def test_sam3p1_variant_warmup_invokes_run_warmup() -> None:
    fake_adapter = MagicMock()
    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=fake_adapter,
    ):
        v = Sam3p1Variant()
        v.load(device="cuda")
    with patch("carve_model.sam.lifecycle._run_warmup") as run:
        v.warmup()
        run.assert_called_once_with(v)


def test_ensure_loaded_runs_warmup_before_flipping_to_ready() -> None:
    """The state machine must observe warmup→ready, never ready→warmup.

    If warmup ran AFTER state=ready, the frontend's poll could catch
    "ready" while the encoder is still doing first-pass lazy init.
    """
    observed: list[str] = []

    fake_adapter = MagicMock()
    fake_adapter.set_image.side_effect = (
        lambda _img: observed.append("warmup_set_image")
    )
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=fake_adapter,
    ):
        mgr = SamLifecycleManager()
        mgr.ensure_loaded("sam2.1-large")
        observed.append(f"state:{mgr.status().kind}")

    # warmup_set_image MUST appear before the final state:ready.
    assert observed == ["warmup_set_image", "state:ready"]


def test_ensure_loaded_marks_error_when_warmup_fails() -> None:
    """A genuine model failure during warmup must surface as state=error,
    not state=ready. The structural guarantee that "ready means ready"
    — without it, the frontend's toast would lie."""

    fake_adapter = MagicMock()
    fake_adapter.set_image.side_effect = RuntimeError(
        "CUDA OOM during warmup",
    )
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=fake_adapter,
    ):
        mgr = SamLifecycleManager()
        with pytest.raises(SamLoadError):
            mgr.ensure_loaded("sam2.1-large")
    s = mgr.status()
    assert s.kind == "error"
    assert "cuda" in (s.error or "").lower() \
        or "warmup" in (s.error or "").lower() \
        or "oom" in (s.error or "").lower()
    assert mgr._active is None


def test_ensure_loaded_tolerates_variant_without_warmup() -> None:
    """The Protocol does not require warmup() — variants without it
    (e.g. _LegacyTestVariant or future minimal variants) must still
    reach state=ready without raising AttributeError."""
    from carve_model.sam.lifecycle import _build_variant as real_build

    fake_adapter = MagicMock()

    def build_without_warmup(name: str):
        v = real_build(name)
        # Per-instance attribute hides the class method.
        v.warmup = None  # type: ignore[assignment]
        return v

    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=fake_adapter,
    ), patch(
        "carve_model.sam.lifecycle._build_variant",
        side_effect=build_without_warmup,
    ):
        mgr = SamLifecycleManager()
        mgr.ensure_loaded("sam2.1-large")
    assert mgr.status().kind == "ready"


def test_sequential_switches_each_run_warmup() -> None:
    """Real users switch variants multiple times in a session. Every
    successful switch must run its own warmup — not just the first —
    so the "ready" signal stays honest across the session."""
    sam2_adapter_1 = MagicMock()
    sam2_adapter_2 = MagicMock()
    sam3p1_adapter = MagicMock()
    sam3p1_adapter._state = {}

    set_image_calls: list[str] = []
    sam2_adapter_1.set_image.side_effect = (
        lambda _img: set_image_calls.append("sam2-tiny:set_image")
    )
    sam2_adapter_2.set_image.side_effect = (
        lambda _img: set_image_calls.append("sam2-large:set_image")
    )
    sam3p1_adapter.set_image.side_effect = (
        lambda _img: set_image_calls.append("sam3.1:set_image")
    )

    # _build_sam2_adapter is called twice with different names — return
    # a different mock per call so we can attribute set_image events.
    sam2_returns = iter([sam2_adapter_1, sam2_adapter_2])
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        side_effect=lambda _name, device=None: next(sam2_returns),
    ), patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=sam3p1_adapter,
    ):
        mgr = SamLifecycleManager()
        mgr.ensure_loaded("sam2.1-tiny")
        mgr.ensure_loaded("sam3.1")
        mgr.ensure_loaded("sam2.1-large")

    # One warmup set_image per switch.
    assert set_image_calls == [
        "sam2-tiny:set_image",
        "sam3.1:set_image",
        "sam2-large:set_image",
    ]
    assert mgr.status().kind == "ready"
    assert mgr.status().variant == "sam2.1-large"


def test_idempotent_reload_does_not_re_warmup() -> None:
    """Switching to the already-active variant is a no-op — the existing
    warmup state must not be discarded by a spurious second warmup pass.
    Mirrors test_ensure_loaded_idempotent_same_variant but verifies the
    new warmup contract is also idempotent."""
    set_image_count = {"n": 0}
    fake_adapter = MagicMock()
    fake_adapter.set_image.side_effect = (
        lambda _img: set_image_count.__setitem__("n", set_image_count["n"] + 1)
    )
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=fake_adapter,
    ):
        mgr = SamLifecycleManager()
        mgr.ensure_loaded("sam2.1-large")
        mgr.ensure_loaded("sam2.1-large")  # no-op
        mgr.ensure_loaded("sam2.1-large")  # no-op
    # Exactly one warmup set_image — subsequent ensure_loaded calls
    # short-circuited because the variant was already ready.
    assert set_image_count["n"] == 1


def test_test_variant_install_bypasses_real_warmup_path() -> None:
    """``install_test_variant`` is the back door for tests that need
    deterministic SAM behavior without a real load. ``ensure_loaded``
    must return immediately when a test variant is installed (no real
    load, no warmup) so unit tests stay deterministic and fast."""
    test_variant = MagicMock()
    test_variant.name = "test"

    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
    ) as build, patch(
        "carve_model.sam.lifecycle._run_warmup",
    ) as run_warmup:
        mgr = SamLifecycleManager()
        mgr.install_test_variant(test_variant)
        mgr.ensure_loaded("sam2.1-large")
        # Neither the real adapter build nor the warmup helper should
        # have been touched — test mode is fully synthetic.
        build.assert_not_called()
        run_warmup.assert_not_called()


def test_warmup_failure_triggers_cuda_cleanup() -> None:
    """A genuinely broken model (e.g. CUDA OOM during warmup) must run
    the full CUDA cleanup so the GPU memory of the partial-build doesn't
    leak. The state must end in 'error' (not 'ready'), and the cleanup
    helper must be invoked exactly the same way as load() failures do."""

    cleanup_calls = {"n": 0}
    fake_adapter = MagicMock()
    fake_adapter.set_image.side_effect = RuntimeError(
        "CUDA out of memory during warmup",
    )
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=fake_adapter,
    ):
        mgr = SamLifecycleManager()
        with patch.object(
            mgr,
            "_run_cuda_cleanup",
            side_effect=lambda: cleanup_calls.__setitem__(
                "n", cleanup_calls["n"] + 1,
            ),
        ):
            with pytest.raises(SamLoadError):
                mgr.ensure_loaded("sam2.1-large")
    # Cleanup runs at least once after the warmup failure (parity with
    # load()-failure cleanup).
    assert cleanup_calls["n"] >= 1
    assert mgr.status().kind == "error"
    assert mgr._active is None


def test_post_warmup_no_stale_dummy_hash_leaks_into_first_real_encode() -> None:
    """After warmup completes, the variant must NOT report its dummy
    image hash as the cached one — otherwise a subsequent /sam/decode
    that compares ``payload.image_hash`` against the cached hash would
    accept the wrong embedding and serve a mask for the dummy frame
    instead of the user's image."""
    fake_adapter = MagicMock()
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=fake_adapter,
    ):
        mgr = SamLifecycleManager()
        mgr.ensure_loaded("sam2.1-large")
    # mgr._active is the loaded variant; it must NOT carry a cached hash
    # from the warmup encode.
    active = mgr._active
    assert active is not None
    assert active.cached_image_hash() is None
    assert active.cached_image_shape() is None


def test_warmup_runs_inside_inference_lock() -> None:
    """Warmup mutates the variant's image cache + adapter state. It
    must run under the manager's inference lock so a concurrent
    ``lease()`` can't observe a half-warmed-up variant."""
    fake_adapter = MagicMock()

    lock_state_during_warmup = {"locked": False}

    def fake_set_image(_img):
        # If the inference lock is held, attempting to acquire it
        # non-blockingly returns False. We use that as a probe — if we
        # *could* acquire here, the load path didn't hold the lock.
        lock_state_during_warmup["locked"] = (
            not mgr._inference_lock.acquire(blocking=False)
        )
        if not lock_state_during_warmup["locked"]:
            mgr._inference_lock.release()

    fake_adapter.set_image.side_effect = fake_set_image
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=fake_adapter,
    ):
        mgr = SamLifecycleManager()
        mgr.ensure_loaded("sam2.1-large")
    assert lock_state_during_warmup["locked"], (
        "warmup must run under _inference_lock"
    )


def test_full_lifecycle_bug_scenario_warmup_then_lease_succeeds() -> None:
    """End-to-end bug scenario: after ensure_loaded completes (warmup
    included), the immediately-following lease() returns the variant
    cleanly — proving that the "ready" signal is honest and a click
    that arrives the millisecond after won't 503."""
    fake_adapter = MagicMock()
    fake_adapter.predict.return_value = (
        np.zeros((1, 4, 4), dtype=bool),
        np.array([0.9]),
        np.zeros((1, 256, 256), dtype=np.float32),
    )
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=fake_adapter,
    ):
        mgr = SamLifecycleManager()
        mgr.ensure_loaded("sam2.1-large")
        # The frontend's "SAM ready" toast would fire NOW. The user's
        # click lands immediately after — lease() must succeed.
        with mgr.lease() as sam:
            assert sam is not None
            # Pre-warmed model — set_image followed by predict_point
            # should both work without surprises.
            sam.set_image(np.zeros((100, 100, 3), dtype=np.uint8))
            masks, scores, _ = sam.predict_point(
                point_coords=np.array([[50, 50]]),
                point_labels=np.array([1]),
            )
        assert masks.shape[0] == 1
