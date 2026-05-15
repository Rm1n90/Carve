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
