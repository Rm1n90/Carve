# Armin Mehri — mehri.armin@gmail.com
"""HTTP surface for the new SAM 3.1 track router."""
from unittest.mock import MagicMock, patch
import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from carve_model.sam import track_session as ts
from carve_model.sam.track_router_v2 import router


@pytest.fixture
def client(tmp_path):
    app = FastAPI()
    app.include_router(router)
    ts._SESSIONS.clear()
    ts._set_predictor_for_test(None)
    yield TestClient(app), tmp_path
    ts._SESSIONS.clear()
    ts._set_predictor_for_test(None)


@pytest.mark.unit
def test_open_session_returns_session_id(client):
    tc, tmp_path = client
    fake = MagicMock()
    fake.handle_request.return_value = {"session_id": "native-sid"}
    ts._set_predictor_for_test(fake)
    with patch("carve_model.sam.track_session.ensure_cached",
               return_value=tmp_path / "h"):
        r = tc.post("/track/sessions", json={
            "frame_urls": ["http://x/0.jpg"],
            "image_size": [720, 1280],
            "asset_hash": "h",
        })
    assert r.status_code == 200
    body = r.json()
    assert body["session_id"]
    assert body["frame_count"] == 1


@pytest.mark.unit
def test_add_prompt_text(client):
    tc, tmp_path = client
    fake = MagicMock()
    fake.handle_request.side_effect = [
        {"session_id": "native-sid"},
        {"outputs": {1: {"mask": np.ones((4, 4), dtype=bool)}}},
    ]
    ts._set_predictor_for_test(fake)
    with patch("carve_model.sam.track_session.ensure_cached",
               return_value=tmp_path / "h"):
        sid = tc.post("/track/sessions", json={
            "frame_urls": ["http://x/0.jpg"],
            "image_size": [4, 4], "asset_hash": "h",
        }).json()["session_id"]
    r = tc.post(f"/track/sessions/{sid}/prompts", json={
        "frame_idx": 0, "text": "person",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["frame_idx"] == 0
    assert "1" in body["masks"] or 1 in body["masks"]


@pytest.mark.unit
def test_add_prompt_no_input_returns_422(client):
    tc, tmp_path = client
    fake = MagicMock()
    fake.handle_request.return_value = {"session_id": "native-sid"}
    ts._set_predictor_for_test(fake)
    with patch("carve_model.sam.track_session.ensure_cached",
               return_value=tmp_path / "h"):
        sid = tc.post("/track/sessions", json={
            "frame_urls": ["http://x/0.jpg"], "image_size": [4, 4], "asset_hash": "h",
        }).json()["session_id"]
    r = tc.post(f"/track/sessions/{sid}/prompts", json={"frame_idx": 0})
    assert r.status_code == 422
    assert r.json()["detail"] == "prompt_required"


@pytest.mark.unit
def test_propagate_returns_chunk(client):
    tc, tmp_path = client
    fake = MagicMock()
    fake.handle_request.return_value = {"session_id": "native-sid"}

    def _stream(_):
        for f in (0, 1, 2):
            yield {"frame_index": f,
                   "outputs": {1: {"mask": np.ones((4, 4), dtype=bool)}}}
    fake.handle_stream_request.side_effect = _stream
    ts._set_predictor_for_test(fake)

    with patch("carve_model.sam.track_session.ensure_cached",
               return_value=tmp_path / "h"):
        sid = tc.post("/track/sessions", json={
            "frame_urls": ["http://x/0.jpg"], "image_size": [4, 4], "asset_hash": "h",
        }).json()["session_id"]
    r = tc.post(f"/track/sessions/{sid}/propagate", json={})
    assert r.status_code == 200
    body = r.json()
    assert len(body["frames"]) == 3


@pytest.mark.unit
def test_close_session_404_when_unknown(client):
    tc, _ = client
    r = tc.delete("/track/sessions/does-not-exist")
    assert r.status_code == 404
