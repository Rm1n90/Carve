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
