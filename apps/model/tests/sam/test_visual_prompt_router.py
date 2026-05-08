"""Tests for POST /sam/visual-prompt endpoint."""
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from carve_model.main import app
    return TestClient(app)


def test_visual_prompt_returns_409_when_variant_not_sam3p1(client, monkeypatch):
    """SAM_MODEL != 'sam3.1' → 409 sam3p1_not_enabled."""
    monkeypatch.setenv("SAM_MODEL", "sam2")
    r = client.post("/sam/visual-prompt", json={
        "refer_b64": "aGVsbG8=",
        "regions": [{"kind": "bbox", "xyxy": [0, 0, 10, 10]}],
        "target_b64": "aGVsbG8=",
    })
    assert r.status_code == 409
    assert r.json()["detail"] == "sam3p1_not_enabled"


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
