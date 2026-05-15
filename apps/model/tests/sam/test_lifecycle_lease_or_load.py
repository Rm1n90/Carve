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
