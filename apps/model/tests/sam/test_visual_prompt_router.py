"""Tests for POST /sam/visual-prompt endpoint."""
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from carve_model.main import app
    return TestClient(app)


def test_visual_prompt_returns_409_when_variant_lacks_visual_capability(client, monkeypatch):
    """Variant without ``supports_visual`` → 409
    ``visual_prompt_not_supported_for_variant``.

    Task 3.4 replaced the old ``SAM_MODEL != 'sam3.1'`` env-name gate
    (detail ``sam3p1_not_enabled``) with a capability flag check on the
    leased variant. We install a point-impl stub so the manager yields
    the LegacyTestVariant (whose ``supports_visual`` is False without a
    visual impl) instead of trying to load the real model at test time.
    """
    from carve_model.sam import predictor as p_mod

    monkeypatch.setenv("SAM_MODEL", "sam2")
    p_mod.set_test_predictor(lambda **_: ([], [], None))
    try:
        r = client.post("/sam/visual-prompt", json={
            "refer_b64": "aGVsbG8=",
            "regions": [{"kind": "bbox", "xyxy": [0, 0, 10, 10]}],
            "target_b64": "aGVsbG8=",
        })
        assert r.status_code == 409
        assert r.json()["detail"] == "visual_prompt_not_supported_for_variant"
    finally:
        p_mod.set_test_predictor(None)


def test_visual_prompt_validates_mixed_ref_types(client, monkeypatch):
    """Even with sam3.1 active, mixed bbox + polygon refs → 422."""
    monkeypatch.setenv("SAM_MODEL", "sam3.1")
    r = client.post("/sam/visual-prompt", json={
        "refer_b64": "aGVsbG8=",
        "regions": [
            {"kind": "bbox", "xyxy": [0, 0, 10, 10]},
            {"kind": "polygon", "points": [[0, 0], [1, 0], [1, 1]]},
        ],
        "target_b64": "aGVsbG8=",
    })
    assert r.status_code == 422
    assert "mixed" in r.json()["detail"].lower()


def test_status_reports_visual_prompt_available_for_sam3p1(client, monkeypatch):
    from carve_model.sam.predictor import set_visual_predictor
    monkeypatch.setenv("SAM_MODEL", "sam3.1")

    # Register a mock factory so visual_prompt_available is True.
    set_visual_predictor(lambda **kwargs: [])

    r = client.get("/sam/status")
    assert r.status_code == 200
    body = r.json()
    assert "visual_prompt_available" in body
    assert body["visual_prompt_available"] is True

    # Cleanup
    set_visual_predictor(None)


def test_status_reports_visual_prompt_unavailable_for_sam2(client, monkeypatch):
    monkeypatch.setenv("SAM_MODEL", "sam2")
    r = client.get("/sam/status")
    assert r.status_code == 200
    body = r.json()
    assert body["visual_prompt_available"] is False
