"""Unit tests for the in-memory tracker session store."""
import numpy as np

from carve_model.sam import tracker as tracker_mod


class _FakeTracker:
    """Stub matching TrackerProtocol with deterministic outputs."""

    def init_state(self, video_path):
        return {"video": video_path, "prompts": []}

    def add_new_points(self, state, frame_idx, points, labels):
        state["prompts"].append({"frame": frame_idx, "points": list(points), "labels": list(labels)})
        return None, None, None

    def propagate_in_video(self, state):
        # Yield three tiny 2x2 masks with increasing frame indices
        for i in range(3):
            yield i, np.array([[1, 0], [0, 1]], dtype=np.uint8) * (i + 1)


def teardown_function(_):
    tracker_mod.reset_for_test()


def test_start_then_get_then_release_roundtrip() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _FakeTracker())
    s = tracker_mod.start_session(
        video_url="https://fake/v.mp4",
        frame_idx=0,
        points=[[10, 20]],
        labels=[1],
    )
    assert s.session_id
    fetched = tracker_mod.get_session(s.session_id)
    assert fetched is not None
    assert fetched.last_frame_idx == 0
    assert tracker_mod.release_session(s.session_id) is True
    assert tracker_mod.get_session(s.session_id) is None
    assert tracker_mod.release_session(s.session_id) is False  # idempotent


def test_get_unknown_returns_none() -> None:
    assert tracker_mod.get_session("does-not-exist") is None


def test_test_factory_overrides_default() -> None:
    captured = {}

    class _Recorder(_FakeTracker):
        def init_state(self, video_path):
            captured["video"] = video_path
            return {"video": video_path, "prompts": []}

    tracker_mod.set_test_tracker_factory(lambda: _Recorder())
    tracker_mod.start_session(
        video_url="https://recorded/v.mp4",
        frame_idx=2,
        points=[[1, 2]],
        labels=[0],
    )
    assert captured["video"] == "https://recorded/v.mp4"


def test_reset_clears_factory_and_sessions() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _FakeTracker())
    tracker_mod.start_session(
        video_url="https://x", frame_idx=0, points=[[0, 0]], labels=[1]
    )
    assert len(tracker_mod._SESSIONS) >= 1
    tracker_mod.reset_for_test()
    assert tracker_mod._SESSIONS == {}
    assert tracker_mod._TEST_FACTORY is None
