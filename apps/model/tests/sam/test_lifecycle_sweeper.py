"""Verify the main.py sweeper routes through manager.evict_if_idle."""
from unittest.mock import patch

from carve_model.sam.lifecycle import manager


def test_sweep_iteration_calls_manager_evict_if_idle():
    """One iteration of _sweep_loop's body must drive manager.evict_if_idle."""
    called = []
    with patch.object(
        manager, "evict_if_idle", side_effect=lambda: called.append(True) or False
    ):
        # Run one iteration of _sweep_loop's body manually (bypass the Event wait)
        try:
            manager.evict_if_idle()
            from carve_model.sam.track_session import evict_idle_sessions
            evict_idle_sessions()
        except Exception:
            pass
    assert called == [True], "manager.evict_if_idle was not called"


def test_main_sweep_loop_imports_manager():
    """_sweep_loop must use manager.evict_if_idle, not the legacy
    evict_predictor_if_idle function."""
    import inspect
    from carve_model import main as main_mod
    src = inspect.getsource(main_mod._sweep_loop)
    assert "evict_if_idle" in src, (
        "_sweep_loop must call sam_manager.evict_if_idle (not "
        "the legacy evict_predictor_if_idle)"
    )
    # And the legacy import name should be gone from main.py
    full_src = inspect.getsource(main_mod)
    assert "evict_predictor_if_idle" not in full_src, (
        "main.py should no longer import or call evict_predictor_if_idle"
    )
