# Armin Mehri — mehri.armin@gmail.com
"""Track session lifecycle: open/close, idle eviction, predictor singleton."""
from unittest.mock import MagicMock, patch
import pytest

from carve_model.sam import track_session as ts


@pytest.fixture(autouse=True)
def _reset_sessions():
    ts._SESSIONS.clear()
    ts._set_predictor_for_test(None)
    yield
    ts._SESSIONS.clear()
    ts._set_predictor_for_test(None)


@pytest.mark.unit
def test_open_session_calls_predictor_with_frame_dir(tmp_path):
    fake = MagicMock()
    fake.handle_request.return_value = {
        "session_id": "native-sid", "image_height": 720, "image_width": 1280,
    }
    ts._set_predictor_for_test(fake)

    with patch("carve_model.sam.track_session.ensure_cached",
               return_value=tmp_path / "abc"):
        sess = ts.open_session(
            frame_urls=["http://x/0.jpg", "http://x/1.jpg"],
            image_size=(720, 1280),
            asset_hash="abc",
        )

    assert sess.session_id  # local id
    assert sess.frame_count == 2
    assert sess.image_size == (720, 1280)
    fake.handle_request.assert_called_once_with({
        "type": "start_session",
        "resource_path": str(tmp_path / "abc"),
    })


@pytest.mark.unit
def test_close_session_calls_predictor_close(tmp_path):
    fake = MagicMock()
    fake.handle_request.return_value = {"session_id": "native-sid"}
    ts._set_predictor_for_test(fake)

    with patch("carve_model.sam.track_session.ensure_cached",
               return_value=tmp_path / "abc"):
        sess = ts.open_session(
            frame_urls=["http://x/0.jpg"],
            image_size=(720, 1280),
            asset_hash="abc",
        )
    ts.close_session(sess.session_id)

    fake.handle_request.assert_any_call({
        "type": "close_session", "session_id": "native-sid",
    })
    assert ts.get_session(sess.session_id) is None


@pytest.mark.unit
def test_get_session_returns_none_for_unknown():
    assert ts.get_session("does-not-exist") is None
