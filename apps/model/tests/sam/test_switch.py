"""HTTP-level tests for ``POST /sam/switch`` (variant hot-swap endpoint).

The real ``load_predictor`` imports torch + sam2 and downloads a 2 GB HF
checkpoint, which is unsuitable for CI. We monkeypatch the symbol the
router resolved at import time and assert on the contract:

- 200 + ``{active_variant}`` on success
- 422 on unknown variant
- 503 when ``load_predictor`` raises
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from carve_model.main import create_app
from carve_model.sam import predictor as p_mod
from carve_model.sam import router as r_mod


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    p_mod.set_test_predictor(None)
    p_mod._set_test_session(None)
    monkeypatch.delenv("SAM_MODEL", raising=False)
    monkeypatch.delenv("SAM_VARIANT", raising=False)
    yield
    p_mod.set_test_predictor(None)
    p_mod._set_test_session(None)


def _client() -> TestClient:
    return TestClient(create_app())


def test_switch_unknown_variant_returns_422() -> None:
    r = _client().post("/sam/switch", json={"variant": "totally-not-a-model"})
    assert r.status_code == 422


def test_switch_missing_variant_returns_422() -> None:
    r = _client().post("/sam/switch", json={})
    assert r.status_code == 422


def test_switch_calls_load_predictor_and_returns_active(monkeypatch) -> None:
    calls: list[str] = []

    def fake_load(variant: str) -> None:
        calls.append(variant)
        # Use monkeypatch.setenv so teardown restores the original value
        # and does not pollute sibling tests (e.g. test_text_router).
        monkeypatch.setenv("SAM_MODEL", variant)

    # Patch on the router module — that's where ``load_predictor`` was
    # bound at import time.
    monkeypatch.setattr(r_mod, "load_predictor", fake_load)

    r = _client().post("/sam/switch", json={"variant": "sam2.1-small"})
    assert r.status_code == 200
    assert r.json() == {"active_variant": "sam2.1-small"}
    assert calls == ["sam2.1-small"]


def test_switch_503_on_load_failure(monkeypatch) -> None:
    def boom(variant: str) -> None:
        raise RuntimeError("CUDA out of memory")

    monkeypatch.setattr(r_mod, "load_predictor", boom)

    r = _client().post("/sam/switch", json={"variant": "sam2.1-large"})
    assert r.status_code == 503
    assert r.json()["detail"] == "sam_variant_load_failed"


def test_switch_value_error_returns_422(monkeypatch) -> None:
    """Defensive: load_predictor's own validation maps to 422."""
    def reject(variant: str) -> None:
        raise ValueError("nope")

    # Bypass the router's own allow-list check by monkeypatching it too,
    # so we exercise the inner ValueError branch.
    monkeypatch.setattr(r_mod, "ALLOWED_SAM_MODELS", ("sam2.1-small",))
    monkeypatch.setattr(r_mod, "load_predictor", reject)

    r = _client().post("/sam/switch", json={"variant": "sam2.1-small"})
    assert r.status_code == 422


def test_switch_idempotent_via_load_predictor_noop(monkeypatch) -> None:
    """When variant matches current and a predictor exists, load_predictor is a no-op.

    We verify the endpoint still returns 200 and the env reflects the value.
    """
    monkeypatch.setenv("SAM_MODEL", "sam2.1-tiny")
    p_mod._set_test_session(object())

    # No monkeypatch on load_predictor — use the real one. It should
    # short-circuit (variant matches current AND a predictor exists).
    r = _client().post("/sam/switch", json={"variant": "sam2.1-tiny"})
    assert r.status_code == 200
    assert r.json() == {"active_variant": "sam2.1-tiny"}
    # Predictor untouched
    assert p_mod._PREDICTOR is not None  # type: ignore[attr-defined]
