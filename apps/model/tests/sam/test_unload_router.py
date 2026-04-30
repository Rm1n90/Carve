"""HTTP-level tests for ``POST /sam/unload`` (admin force-evict endpoint).

Validates the contract: the body's ``which`` field selects ``image`` /
``tracker`` / ``all`` (default ``all``) and the response lists what was
actually freed. Idempotent — calling on an already-unloaded predictor
returns ``evicted: []``.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from carve_model.main import create_app
from carve_model.sam import predictor as p_mod
from carve_model.sam import tracker as t_mod


@pytest.fixture(autouse=True)
def _reset():
    p_mod.set_test_predictor(None)
    p_mod._set_test_session(None)
    t_mod.reset_for_test()
    yield
    p_mod.set_test_predictor(None)
    p_mod._set_test_session(None)
    t_mod.reset_for_test()


def _client() -> TestClient:
    return TestClient(create_app())


def test_unload_all_when_nothing_loaded():
    r = _client().post("/sam/unload", json={"which": "all"})
    assert r.status_code == 200
    body = r.json()
    assert body["evicted"] == []
    assert body["sessions_released"] == 0


def test_unload_all_default_body():
    """An empty body defaults to ``which='all'``."""
    r = _client().post("/sam/unload", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["evicted"] == []
    assert body["sessions_released"] == 0


def test_unload_image_only_releases_image():
    p_mod._set_test_session(object())
    t_mod._SESSIONS["x"] = object()  # type: ignore[assignment]
    r = _client().post("/sam/unload", json={"which": "image"})
    assert r.status_code == 200
    body = r.json()
    assert body["evicted"] == ["image"]
    assert body["sessions_released"] == 0
    # Tracker session was NOT touched
    assert "x" in t_mod._SESSIONS
    # Image predictor IS evicted
    assert p_mod._PREDICTOR is None  # type: ignore[attr-defined]


def test_unload_tracker_only_releases_sessions():
    p_mod._set_test_session(object())
    t_mod._SESSIONS["x"] = object()  # type: ignore[assignment]
    r = _client().post("/sam/unload", json={"which": "tracker"})
    assert r.status_code == 200
    body = r.json()
    assert body["evicted"] == ["tracker"]
    assert body["sessions_released"] == 1
    # Image predictor was NOT touched
    assert p_mod._PREDICTOR is not None  # type: ignore[attr-defined]
    # Tracker session IS gone
    assert "x" not in t_mod._SESSIONS


def test_unload_all_releases_both():
    p_mod._set_test_session(object())
    t_mod._SESSIONS["a"] = object()  # type: ignore[assignment]
    t_mod._SESSIONS["b"] = object()  # type: ignore[assignment]
    r = _client().post("/sam/unload", json={"which": "all"})
    assert r.status_code == 200
    body = r.json()
    assert set(body["evicted"]) == {"image", "tracker"}
    assert body["sessions_released"] == 2
    assert p_mod._PREDICTOR is None  # type: ignore[attr-defined]
    assert len(t_mod._SESSIONS) == 0


def test_unload_idempotent_when_already_evicted():
    """Second call returns evicted=[] — no error, no double-free."""
    p_mod._set_test_session(object())
    client = _client()
    first = client.post("/sam/unload", json={"which": "all"}).json()
    assert "image" in first["evicted"]
    second = client.post("/sam/unload", json={"which": "all"}).json()
    assert second["evicted"] == []
    assert second["sessions_released"] == 0


def test_unload_validates_which_field():
    r = _client().post("/sam/unload", json={"which": "bogus"})
    assert r.status_code == 422


def test_unload_tracker_only_when_no_sessions():
    """``which=tracker`` with no sessions returns no eviction marker."""
    r = _client().post("/sam/unload", json={"which": "tracker"})
    assert r.status_code == 200
    body = r.json()
    assert body["evicted"] == []
    assert body["sessions_released"] == 0
