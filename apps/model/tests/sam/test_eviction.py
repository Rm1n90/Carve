"""Tests for SAM idle eviction (image predictor + video tracker sessions).

The eviction logic lives in ``predictor.py`` (singleton + last-used clock)
and ``tracker.py`` (per-session last-used map). A 60-second background sweep
in ``main.py``'s lifespan calls these helpers; this module unit-tests the
helpers directly without touching any thread.
"""

from __future__ import annotations

import time

import pytest

from carve_model.sam import predictor as p_mod
from carve_model.sam import tracker as t_mod


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    monkeypatch.delenv("SAM_IDLE_TIMEOUT_S", raising=False)
    p_mod.set_test_predictor(None)
    p_mod._PREDICTOR = None  # type: ignore[attr-defined]
    p_mod._PREDICTOR_LAST_USED = 0.0  # type: ignore[attr-defined]
    t_mod.reset_for_test()
    yield
    p_mod.set_test_predictor(None)
    p_mod._PREDICTOR = None  # type: ignore[attr-defined]
    p_mod._PREDICTOR_LAST_USED = 0.0  # type: ignore[attr-defined]
    t_mod.reset_for_test()


# --- _idle_timeout_s --------------------------------------------------------


def test_idle_timeout_s_default():
    """Unset env returns DEFAULT_SAM_IDLE_TIMEOUT_S (15 minutes)."""
    assert p_mod._idle_timeout_s() == p_mod.DEFAULT_SAM_IDLE_TIMEOUT_S
    assert p_mod.DEFAULT_SAM_IDLE_TIMEOUT_S == 15 * 60


def test_idle_timeout_s_invalid_falls_back(monkeypatch):
    monkeypatch.setenv("SAM_IDLE_TIMEOUT_S", "not-a-number")
    assert p_mod._idle_timeout_s() == p_mod.DEFAULT_SAM_IDLE_TIMEOUT_S


def test_idle_timeout_s_negative_clamps_to_zero(monkeypatch):
    monkeypatch.setenv("SAM_IDLE_TIMEOUT_S", "-30")
    assert p_mod._idle_timeout_s() == 0


def test_idle_timeout_s_reads_env(monkeypatch):
    monkeypatch.setenv("SAM_IDLE_TIMEOUT_S", "120")
    assert p_mod._idle_timeout_s() == 120


# --- predictor eviction -----------------------------------------------------


def test_evict_predictor_if_idle_returns_false_when_not_loaded():
    assert p_mod.evict_predictor_if_idle() is False


def test_evict_predictor_when_loaded_and_idle_long_enough(monkeypatch):
    monkeypatch.setenv("SAM_IDLE_TIMEOUT_S", "1")
    p_mod._PREDICTOR = object()  # type: ignore[attr-defined]
    p_mod._PREDICTOR_LAST_USED = time.monotonic() - 5  # 5s ago, exceeds 1s timeout
    assert p_mod.evict_predictor_if_idle() is True
    assert p_mod._PREDICTOR is None  # type: ignore[attr-defined]


def test_no_evict_when_recently_used(monkeypatch):
    monkeypatch.setenv("SAM_IDLE_TIMEOUT_S", "60")
    p_mod._PREDICTOR = object()  # type: ignore[attr-defined]
    p_mod._PREDICTOR_LAST_USED = time.monotonic() - 5  # 5s < 60s
    assert p_mod.evict_predictor_if_idle() is False
    assert p_mod._PREDICTOR is not None  # type: ignore[attr-defined]


def test_force_evict_predictor_works_anytime():
    p_mod._PREDICTOR = object()  # type: ignore[attr-defined]
    assert p_mod.force_evict_predictor() is True
    assert p_mod._PREDICTOR is None  # type: ignore[attr-defined]


def test_force_evict_predictor_idempotent():
    """Calling on an already-evicted predictor returns False (no-op)."""
    assert p_mod.force_evict_predictor() is False


def test_idle_timeout_zero_disables_eviction(monkeypatch):
    monkeypatch.setenv("SAM_IDLE_TIMEOUT_S", "0")
    p_mod._PREDICTOR = object()  # type: ignore[attr-defined]
    p_mod._PREDICTOR_LAST_USED = time.monotonic() - 10000
    assert p_mod.evict_predictor_if_idle() is False
    assert p_mod._PREDICTOR is not None  # type: ignore[attr-defined]


def test_touch_predictor_updates_clock():
    before = time.monotonic()
    p_mod.touch_predictor()
    after = time.monotonic()
    assert before <= p_mod._PREDICTOR_LAST_USED <= after  # type: ignore[attr-defined]


# --- tracker session eviction -----------------------------------------------


def test_evict_idle_sessions_returns_evicted_ids(monkeypatch):
    monkeypatch.setenv("SAM_IDLE_TIMEOUT_S", "1")
    sid = "s-old"
    t_mod._SESSIONS[sid] = object()  # type: ignore[assignment]
    t_mod._SESSION_LAST_USED[sid] = time.monotonic() - 5  # type: ignore[attr-defined]
    evicted = t_mod.evict_idle_sessions()
    assert evicted == [sid]
    assert sid not in t_mod._SESSIONS
    assert sid not in t_mod._SESSION_LAST_USED  # type: ignore[attr-defined]


def test_evict_idle_sessions_keeps_recent(monkeypatch):
    monkeypatch.setenv("SAM_IDLE_TIMEOUT_S", "60")
    sid = "s-fresh"
    t_mod._SESSIONS[sid] = object()  # type: ignore[assignment]
    t_mod._SESSION_LAST_USED[sid] = time.monotonic() - 1  # type: ignore[attr-defined]
    assert t_mod.evict_idle_sessions() == []
    assert sid in t_mod._SESSIONS


def test_evict_idle_sessions_disabled_when_timeout_zero(monkeypatch):
    monkeypatch.setenv("SAM_IDLE_TIMEOUT_S", "0")
    sid = "s-keepme"
    t_mod._SESSIONS[sid] = object()  # type: ignore[assignment]
    t_mod._SESSION_LAST_USED[sid] = time.monotonic() - 99999  # type: ignore[attr-defined]
    assert t_mod.evict_idle_sessions() == []
    assert sid in t_mod._SESSIONS


def test_force_evict_all_sessions_returns_count():
    t_mod._SESSIONS["a"] = object()  # type: ignore[assignment]
    t_mod._SESSIONS["b"] = object()  # type: ignore[assignment]
    assert t_mod.force_evict_all_sessions() == 2
    assert len(t_mod._SESSIONS) == 0


def test_force_evict_all_sessions_zero_when_empty():
    assert t_mod.force_evict_all_sessions() == 0


def test_touch_session_updates_clock():
    sid = "s-touch"
    t_mod._SESSIONS[sid] = object()  # type: ignore[assignment]
    before = time.monotonic()
    t_mod.touch_session(sid)
    after = time.monotonic()
    assert before <= t_mod._SESSION_LAST_USED[sid] <= after  # type: ignore[attr-defined]
