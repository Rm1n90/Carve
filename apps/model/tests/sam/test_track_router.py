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


# --- SAM 3 video tracking (text OR point/box prompts) -----------------------


class _CapturingDispatcherTracker:
    """SAM 3 video tracker stub — captures whatever points/labels reach it
    so the test can assert that the router routed the correct payload type
    (text or numeric clicks) into the underlying dispatcher."""

    def __init__(self) -> None:
        self.calls: list = []

    def init_state(self, video_path):
        return {"video": video_path}

    def add_new_points(self, state, frame_idx, points, labels):
        self.calls.append({"frame_idx": frame_idx, "points": points, "labels": labels})
        return None, None, None

    def propagate_in_video(self, state):
        if False:
            yield  # empty generator


def test_start_with_sam3_accepts_text_only(monkeypatch) -> None:
    """When SAM_MODEL=sam3, /sam-track/start accepts text without points and
    forwards it into the tracker as ``points=[text]`` (the dispatcher routes
    that to Sam3VideoModel.add_text_prompt)."""
    monkeypatch.setenv("SAM_MODEL", "sam3")
    captured = {"tracker": None}

    def _factory():
        t = _CapturingDispatcherTracker()
        captured["tracker"] = t
        return t

    tracker_mod.set_test_tracker_factory(_factory)
    r = _client().post(
        "/sam-track/start",
        json={"video_url": "https://fake/v.mp4", "frame_idx": 0, "text": "person"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["session_id"]
    assert captured["tracker"].calls == [
        {"frame_idx": 0, "points": ["person"], "labels": []},
    ]


def test_start_with_sam3_accepts_points_only(monkeypatch) -> None:
    """When SAM_MODEL=sam3, /sam-track/start accepts numeric points without
    a text field — the dispatcher routes those to Sam3TrackerVideoModel
    via add_inputs_to_inference_session."""
    monkeypatch.setenv("SAM_MODEL", "sam3")
    captured = {"tracker": None}

    def _factory():
        t = _CapturingDispatcherTracker()
        captured["tracker"] = t
        return t

    tracker_mod.set_test_tracker_factory(_factory)
    r = _client().post(
        "/sam-track/start",
        json={
            "video_url": "https://fake/v.mp4",
            "frame_idx": 0,
            "points": [[210, 350]],
            "labels": [1],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["session_id"]
    assert captured["tracker"].calls == [
        {"frame_idx": 0, "points": [[210, 350]], "labels": [1]},
    ]


def test_start_with_sam3_rejects_no_prompt(monkeypatch) -> None:
    """When SAM_MODEL=sam3, /sam-track/start must 422 if neither text nor
    points are supplied — the dispatcher needs at least one prompt type."""
    monkeypatch.setenv("SAM_MODEL", "sam3")
    tracker_mod.set_test_tracker_factory(lambda: _CapturingDispatcherTracker())
    r = _client().post(
        "/sam-track/start",
        json={"video_url": "https://fake/v.mp4", "frame_idx": 0},
    )
    assert r.status_code == 422
    assert "sam3_track_requires_points_or_text" in r.text


def test_start_with_sam3_prefers_text_when_both_present(monkeypatch) -> None:
    """When BOTH text and points are sent, the router picks text (concept
    tracking is more specific to SAM 3's design intent for text prompts).
    Empty points fall through to text."""
    monkeypatch.setenv("SAM_MODEL", "sam3")
    captured = {"tracker": None}

    def _factory():
        t = _CapturingDispatcherTracker()
        captured["tracker"] = t
        return t

    tracker_mod.set_test_tracker_factory(_factory)
    r = _client().post(
        "/sam-track/start",
        json={"video_url": "https://fake/v.mp4", "frame_idx": 0, "text": "dog"},
    )
    assert r.status_code == 200, r.text
    assert captured["tracker"].calls[0]["points"] == ["dog"]


def test_start_with_sam3_points_label_mismatch_returns_422(monkeypatch) -> None:
    """When SAM_MODEL=sam3 and points are passed without text, length
    mismatch between points and labels still returns 422."""
    monkeypatch.setenv("SAM_MODEL", "sam3")
    tracker_mod.set_test_tracker_factory(lambda: _CapturingDispatcherTracker())
    r = _client().post(
        "/sam-track/start",
        json={
            "video_url": "https://fake/v.mp4",
            "frame_idx": 0,
            "points": [[1, 1], [2, 2]],
            "labels": [1],
        },
    )
    assert r.status_code == 422
