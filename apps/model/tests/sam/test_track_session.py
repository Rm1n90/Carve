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


# ---- T3: add_prompt -------------------------------------------------------
import numpy as np


def _open_session_with_fake_predictor(tmp_path, fake):
    ts._set_predictor_for_test(fake)
    fake.handle_request.return_value = {"session_id": "native-sid"}
    with patch("carve_model.sam.track_session.ensure_cached",
               return_value=tmp_path / "abc"):
        return ts.open_session(
            frame_urls=["http://x/0.jpg"],
            image_size=(720, 1280),
            asset_hash="abc",
        )


@pytest.mark.unit
def test_add_prompt_text_returns_per_obj_masks(tmp_path):
    fake = MagicMock()
    sess = _open_session_with_fake_predictor(tmp_path, fake)
    fake.handle_request.return_value = {
        "outputs": {1: {"mask": np.zeros((720, 1280), dtype=bool)},
                    2: {"mask": np.ones((720, 1280), dtype=bool)}},
    }

    masks = ts.add_prompt(sess.session_id, frame_idx=0, text="person")

    assert set(masks.keys()) == {1, 2}
    fake.handle_request.assert_any_call({
        "type": "add_prompt",
        "session_id": "native-sid",
        "frame_index": 0,
        "text": "person",
    })


@pytest.mark.unit
def test_add_prompt_point_with_obj_id_refines(tmp_path):
    fake = MagicMock()
    sess = _open_session_with_fake_predictor(tmp_path, fake)
    fake.handle_request.return_value = {
        "outputs": {2: {"mask": np.ones((720, 1280), dtype=bool)}},
    }

    masks = ts.add_prompt(
        sess.session_id, frame_idx=5, obj_id=2,
        points=[(640, 360)], labels=[1],
    )
    assert set(masks.keys()) == {2}
    call = fake.handle_request.call_args_list[-1].args[0]
    assert call["type"] == "add_prompt"
    assert call["frame_index"] == 5
    assert call["obj_id"] == 2
    # rel coords: 640/1280=0.5, 360/720=0.5
    pts = call["points"]
    if hasattr(pts, "tolist"):
        pts = pts.tolist()
    np.testing.assert_allclose(pts, [[0.5, 0.5]], rtol=1e-3)
    pl = call["point_labels"]
    if hasattr(pl, "tolist"):
        pl = pl.tolist()
    np.testing.assert_array_equal(pl, [1])


@pytest.mark.unit
def test_add_prompt_no_input_raises(tmp_path):
    fake = MagicMock()
    sess = _open_session_with_fake_predictor(tmp_path, fake)
    with pytest.raises(ValueError, match="prompt_required"):
        ts.add_prompt(sess.session_id, frame_idx=0)


@pytest.mark.unit
def test_add_prompt_point_and_box_raises(tmp_path):
    fake = MagicMock()
    sess = _open_session_with_fake_predictor(tmp_path, fake)
    with pytest.raises(ValueError, match="exclusive_prompt_modes"):
        ts.add_prompt(
            sess.session_id, frame_idx=0,
            points=[(1, 1)], labels=[1],
            box=(0, 0, 10, 10),
        )


@pytest.mark.unit
def test_add_prompt_session_not_found():
    with pytest.raises(LookupError, match="session_not_found"):
        ts.add_prompt("nope", frame_idx=0, text="cat")


# ---- T4: propagate --------------------------------------------------------


@pytest.mark.unit
def test_propagate_streams_per_frame_masks(tmp_path):
    fake = MagicMock()
    sess = _open_session_with_fake_predictor(tmp_path, fake)

    def _stream(_request):
        for f in (0, 1, 2):
            yield {
                "frame_index": f,
                "outputs": {1: {"mask": np.ones((10, 10), dtype=bool)}},
            }
    fake.handle_stream_request.side_effect = _stream

    chunk = ts.propagate(sess.session_id)
    assert [f["frame_idx"] for f in chunk] == [0, 1, 2]
    assert all(set(f["masks"].keys()) == {1} for f in chunk)


@pytest.mark.unit
def test_propagate_respects_start_and_end_frame(tmp_path):
    fake = MagicMock()
    sess = _open_session_with_fake_predictor(tmp_path, fake)

    def _stream(_request):
        for f in range(10):
            yield {
                "frame_index": f,
                "outputs": {1: {"mask": np.ones((4, 4), dtype=bool)}},
            }
    fake.handle_stream_request.side_effect = _stream

    chunk = ts.propagate(sess.session_id, start_frame=3, end_frame=5)
    assert [f["frame_idx"] for f in chunk] == [3, 4, 5]


@pytest.mark.unit
def test_propagate_session_not_found():
    with pytest.raises(LookupError, match="session_not_found"):
        ts.propagate("nope")


# ---- T5: remove_object + reset_prompts ------------------------------------


@pytest.mark.unit
def test_remove_object_calls_predictor(tmp_path):
    fake = MagicMock()
    sess = _open_session_with_fake_predictor(tmp_path, fake)

    ts.remove_object(sess.session_id, obj_id=2)
    fake.handle_request.assert_any_call({
        "type": "remove_object",
        "session_id": "native-sid",
        "obj_id": 2,
    })


@pytest.mark.unit
def test_reset_prompts_calls_predictor(tmp_path):
    fake = MagicMock()
    sess = _open_session_with_fake_predictor(tmp_path, fake)

    ts.reset_prompts(sess.session_id)
    fake.handle_request.assert_any_call({
        "type": "reset_session",
        "session_id": "native-sid",
    })


@pytest.mark.unit
def test_remove_object_session_not_found():
    with pytest.raises(LookupError, match="session_not_found"):
        ts.remove_object("nope", obj_id=1)
