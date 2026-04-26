"""HTTP-level tests for /sam-track endpoints."""
import numpy as np
from fastapi.testclient import TestClient

from vaa_model.main import create_app
from vaa_model.sam import tracker as tracker_mod


class _FakeTracker:
    def init_state(self, video_path):
        return {"video": video_path}

    def add_new_points(self, state, frame_idx, points, labels):
        return None, None, None

    def propagate_in_video(self, state):
        # Three 2x2 masks: top-left ones, top-right ones, bottom-right ones
        masks = [
            np.array([[1, 0], [0, 0]], dtype=np.uint8),
            np.array([[0, 1], [0, 0]], dtype=np.uint8),
            np.array([[0, 0], [0, 1]], dtype=np.uint8),
        ]
        for i, m in enumerate(masks):
            yield i, m


def _client() -> TestClient:
    return TestClient(create_app())


def teardown_function(_):
    tracker_mod.reset_for_test()


def test_start_returns_session_id_and_seed_mask() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _FakeTracker())
    r = _client().post(
        "/sam-track/start",
        json={
            "video_url": "https://fake/v.mp4",
            "frame_idx": 0,
            "points": [[10, 20]],
            "labels": [1],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["session_id"]
    assert "counts" in body["mask_at_start"]


def test_step_advances_one_frame_per_step() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _FakeTracker())
    client = _client()
    sid = client.post(
        "/sam-track/start",
        json={"video_url": "v", "frame_idx": 0, "points": [[1, 1]], "labels": [1]},
    ).json()["session_id"]

    r = client.post(f"/sam-track/{sid}/step?frames=1")
    assert r.status_code == 200
    steps = r.json()["steps"]
    assert len(steps) == 1
    assert steps[0]["frame_idx"] == 0


def test_step_advances_n_frames() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _FakeTracker())
    client = _client()
    sid = client.post(
        "/sam-track/start",
        json={"video_url": "v", "frame_idx": 0, "points": [[1, 1]], "labels": [1]},
    ).json()["session_id"]

    r = client.post(f"/sam-track/{sid}/step?frames=10")
    steps = r.json()["steps"]
    # FakeTracker yields exactly 3 frames then StopIteration
    assert len(steps) == 3
    assert [s["frame_idx"] for s in steps] == [0, 1, 2]


def test_step_unknown_session_returns_404() -> None:
    r = _client().post("/sam-track/nope/step")
    assert r.status_code == 404


def test_release_removes_session() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _FakeTracker())
    client = _client()
    sid = client.post(
        "/sam-track/start",
        json={"video_url": "v", "frame_idx": 0, "points": [[0, 0]], "labels": [1]},
    ).json()["session_id"]
    r = client.delete(f"/sam-track/{sid}")
    assert r.status_code == 204
    # Subsequent step on a released session is 404
    r = client.post(f"/sam-track/{sid}/step")
    assert r.status_code == 404


def test_start_mismatched_points_labels_returns_422() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _FakeTracker())
    r = _client().post(
        "/sam-track/start",
        json={"video_url": "v", "frame_idx": 0, "points": [[1, 1], [2, 2]], "labels": [1]},
    )
    assert r.status_code == 422


def test_step_invalid_frames_returns_422() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _FakeTracker())
    client = _client()
    sid = client.post(
        "/sam-track/start",
        json={"video_url": "v", "frame_idx": 0, "points": [[0, 0]], "labels": [1]},
    ).json()["session_id"]
    r = client.post(f"/sam-track/{sid}/step?frames=0")
    assert r.status_code == 422
    r = client.post(f"/sam-track/{sid}/step?frames=99999")
    assert r.status_code == 422
