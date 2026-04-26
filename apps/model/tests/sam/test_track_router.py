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


def test_start_with_sam3_no_prompt_creates_empty_session(monkeypatch) -> None:
    """v1.4: when SAM_MODEL=sam3 and neither text nor points are supplied,
    /sam-track/start now creates an empty session (was 422 in v1.3). The
    caller is expected to add objects via /sam-track/{sid}/objects before
    stepping."""
    monkeypatch.setenv("SAM_MODEL", "sam3")
    captured = {"tracker": None}

    def _factory():
        t = _CapturingDispatcherTracker()
        captured["tracker"] = t
        return t

    tracker_mod.set_test_tracker_factory(_factory)
    r = _client().post(
        "/sam-track/start",
        json={"video_url": "https://fake/v.mp4", "frame_idx": 0},
    )
    assert r.status_code == 200, r.text
    assert r.json()["session_id"]
    # No prompts forwarded — session is empty until /objects is called.
    assert captured["tracker"].calls == []


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


# --- v1.4 multi-object tracking ---------------------------------------------


class _MultiObjectFakeTracker:
    """v1.4 fake tracker — speaks the new per-object protocol AND records
    every ``add_inputs_at_frame`` call so tests can assert the right args
    reached the underlying tracker."""

    def __init__(self) -> None:
        self.add_inputs_calls: list = []

    def init_state(self, video_path):
        return {"video": video_path}

    def add_new_points(self, state, frame_idx, points, labels):  # legacy
        return None, None, None

    def add_inputs_at_frame(
        self,
        inference_state,
        frame_idx,
        obj_id,
        points=None,
        labels=None,
        boxes=None,
    ):
        self.add_inputs_calls.append({
            "frame_idx": frame_idx,
            "obj_id": obj_id,
            "points": points,
            "labels": labels,
            "boxes": boxes,
        })
        return None

    def propagate_in_video(self, state):
        # Yield one frame with two objects.
        yield 0, {
            1: np.array([[1, 0], [0, 0]], dtype=np.uint8),
            2: np.array([[0, 0], [1, 0]], dtype=np.uint8),
        }


def test_add_object_returns_404_for_unknown_session() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _MultiObjectFakeTracker())
    r = _client().post(
        "/sam-track/bad-id/objects",
        json={"frame_idx": 0, "obj_id": 1, "points": [[1, 1]], "labels": [1]},
    )
    assert r.status_code == 404


def test_add_object_validates_points_labels_length_mismatch() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _MultiObjectFakeTracker())
    client = _client()
    sid = client.post(
        "/sam-track/start",
        json={"video_url": "https://fake/v.mp4"},
    ).json()["session_id"]

    r = client.post(
        f"/sam-track/{sid}/objects",
        json={
            "frame_idx": 0,
            "obj_id": 1,
            "points": [[1, 1], [2, 2]],
            "labels": [1],
        },
    )
    assert r.status_code == 422


def test_add_object_requires_points_or_boxes() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _MultiObjectFakeTracker())
    client = _client()
    sid = client.post(
        "/sam-track/start",
        json={"video_url": "https://fake/v.mp4"},
    ).json()["session_id"]

    r = client.post(
        f"/sam-track/{sid}/objects",
        json={"frame_idx": 0, "obj_id": 1},
    )
    assert r.status_code == 422
    assert "object_requires_points_or_boxes" in r.text


def test_add_object_validates_label_values() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _MultiObjectFakeTracker())
    client = _client()
    sid = client.post(
        "/sam-track/start",
        json={"video_url": "https://fake/v.mp4"},
    ).json()["session_id"]

    r = client.post(
        f"/sam-track/{sid}/objects",
        json={
            "frame_idx": 0,
            "obj_id": 1,
            "points": [[1, 1]],
            "labels": [2],
        },
    )
    assert r.status_code == 422


def test_add_object_succeeds_and_calls_tracker() -> None:
    captured = {"tracker": None}

    def _factory():
        t = _MultiObjectFakeTracker()
        captured["tracker"] = t
        return t

    tracker_mod.set_test_tracker_factory(_factory)
    client = _client()
    sid = client.post(
        "/sam-track/start",
        json={"video_url": "https://fake/v.mp4"},
    ).json()["session_id"]

    r = client.post(
        f"/sam-track/{sid}/objects",
        json={
            "frame_idx": 5,
            "obj_id": 1,
            "points": [[100, 200], [120, 220]],
            "labels": [1, 0],
        },
    )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["obj_id"] == 1
    assert body["frame_idx"] == 5
    fake = captured["tracker"]
    assert len(fake.add_inputs_calls) == 1
    call = fake.add_inputs_calls[0]
    assert call["obj_id"] == 1
    assert call["frame_idx"] == 5
    assert call["points"] == [[100, 200], [120, 220]]
    assert call["labels"] == [1, 0]


def test_step_returns_per_object_masks() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _MultiObjectFakeTracker())
    client = _client()
    sid = client.post(
        "/sam-track/start",
        json={"video_url": "https://fake/v.mp4"},
    ).json()["session_id"]

    r = client.post(f"/sam-track/{sid}/step?frames=1")

    assert r.status_code == 200, r.text
    steps = r.json()["steps"]
    assert len(steps) == 1
    assert steps[0]["frame_idx"] == 0
    objects = steps[0]["objects"]
    assert isinstance(objects, list)
    obj_ids = sorted(int(o["obj_id"]) for o in objects)
    assert obj_ids == [1, 2]
    for entry in objects:
        assert {"obj_id", "counts", "size", "score"} <= set(entry.keys())


def test_step_legacy_fake_single_mask_wraps_as_obj_id_1() -> None:
    """Legacy fakes yield ``(frame_idx, single_mask)``; the router must
    wrap that as ``{1: mask}`` so single-object sessions still return a
    valid per-object response shape."""
    tracker_mod.set_test_tracker_factory(lambda: _FakeTracker())
    client = _client()
    sid = client.post(
        "/sam-track/start",
        json={"video_url": "https://fake/v.mp4", "points": [[1, 1]], "labels": [1]},
    ).json()["session_id"]

    r = client.post(f"/sam-track/{sid}/step?frames=1")

    assert r.status_code == 200, r.text
    steps = r.json()["steps"]
    assert len(steps) == 1
    objects = steps[0]["objects"]
    assert len(objects) == 1
    assert objects[0]["obj_id"] == 1


def test_start_with_no_points_creates_empty_session() -> None:
    """v1.4: /start with just a video_url is accepted — caller adds
    objects via /sam-track/{sid}/objects before stepping."""
    tracker_mod.set_test_tracker_factory(lambda: _MultiObjectFakeTracker())
    r = _client().post(
        "/sam-track/start",
        json={"video_url": "https://fake/v.mp4"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["session_id"]
