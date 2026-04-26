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
        json={"video_url": "https://fake/v.mp4", "frame_idx": 0, "points": [[1, 1]], "labels": [1]},
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
        json={"video_url": "https://fake/v.mp4", "frame_idx": 0, "points": [[1, 1]], "labels": [1]},
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
        json={"video_url": "https://fake/v.mp4", "frame_idx": 0, "points": [[0, 0]], "labels": [1]},
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
        json={"video_url": "https://fake/v.mp4", "frame_idx": 0, "points": [[1, 1], [2, 2]], "labels": [1]},
    )
    assert r.status_code == 422


def test_step_invalid_frames_returns_422() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _FakeTracker())
    client = _client()
    sid = client.post(
        "/sam-track/start",
        json={"video_url": "https://fake/v.mp4", "frame_idx": 0, "points": [[0, 0]], "labels": [1]},
    ).json()["session_id"]
    r = client.post(f"/sam-track/{sid}/step?frames=0")
    assert r.status_code == 422
    r = client.post(f"/sam-track/{sid}/step?frames=99999")
    assert r.status_code == 422


def test_start_rejects_file_scheme_video_url() -> None:
    """SSRF guard: file:// video URLs must be refused before any tracker init."""
    tracker_mod.set_test_tracker_factory(lambda: _FakeTracker())
    r = _client().post(
        "/sam-track/start",
        json={"video_url": "file:///etc/passwd", "frame_idx": 0, "points": [[0, 0]], "labels": [1]},
    )
    assert r.status_code == 422
    assert "video_url_scheme_not_allowed" in r.text


# --- SAM 3 video tracking (text-prompt-based) -------------------------------


class _CapturingTextTracker:
    """SAM 3 video tracker stub — accepts a single string in the points slot
    and records it so the test can assert the router routed text correctly."""

    def __init__(self) -> None:
        self.texts: list = []

    def init_state(self, video_path):
        return {"video": video_path}

    def add_new_points(self, state, frame_idx, points, labels):
        self.texts.append(points)
        return None, None, None

    def propagate_in_video(self, state):
        if False:
            yield  # empty generator


def test_start_with_sam3_requires_text_field(monkeypatch) -> None:
    """When SAM_MODEL=sam3, /sam-track/start must reject calls that omit
    the text prompt — SAM 3 video tracking is concept-based, not click-based."""
    monkeypatch.setenv("SAM_MODEL", "sam3")
    tracker_mod.set_test_tracker_factory(lambda: _CapturingTextTracker())
    r = _client().post(
        "/sam-track/start",
        json={"video_url": "https://fake/v.mp4", "frame_idx": 0},
    )
    assert r.status_code == 422
    assert "sam3_track_requires_text" in r.text


def test_start_with_sam3_accepts_text_only(monkeypatch) -> None:
    """When SAM_MODEL=sam3, /sam-track/start must accept text without
    points/labels and forward the text into the tracker."""
    monkeypatch.setenv("SAM_MODEL", "sam3")
    captured = {"tracker": None}

    def _factory():
        t = _CapturingTextTracker()
        captured["tracker"] = t
        return t

    tracker_mod.set_test_tracker_factory(_factory)
    r = _client().post(
        "/sam-track/start",
        json={"video_url": "https://fake/v.mp4", "frame_idx": 0, "text": "person"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["session_id"]
    assert captured["tracker"].texts == [["person"]]
