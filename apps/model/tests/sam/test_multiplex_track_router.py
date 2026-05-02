"""Plan 11 Task 4 — multiplex semantics on /sam-track endpoints.

Covers:
- text prompt on POST /{sid}/objects → returns ``{obj_ids: [...], frame_idx}``
  and invokes the adapter's ``add_text_prompt``.
- DELETE /{sid}/objects/{oid} on a multiplex tracker → 204 + remove_object call.
- DELETE /{sid}/objects/{oid} on a non-multiplex tracker → 422
  ``adapter_not_multiplex``.
- POST /{sid}/reset on multiplex → 204 + reset_session call.
- POST /{sid}/reset on non-multiplex → 422 ``adapter_not_multiplex``.
- 404 mapping for unknown sessions on the new endpoints.
"""
from typing import Any

import numpy as np
from fastapi.testclient import TestClient

from carve_model.main import create_app
from carve_model.sam import tracker as tracker_mod


class _MultiplexFakeTracker:
    """Stub that mimics the SAM 3.1 multiplex adapter surface."""

    def __init__(self) -> None:
        self.add_text_prompt_calls: list = []
        self.remove_object_calls: list = []
        self.reset_session_calls: list = []
        self.add_inputs_calls: list = []

    def init_state(self, video_path: str) -> Any:
        return {"video": video_path, "outputs": {}}

    def add_new_points(self, state, frame_idx, points, labels):  # legacy
        return None, None, None

    def add_inputs_at_frame(
        self, inference_state, frame_idx, obj_id,
        points=None, labels=None, boxes=None,
    ):
        self.add_inputs_calls.append({
            "frame_idx": frame_idx,
            "obj_id": obj_id,
            "points": points,
            "labels": labels,
            "boxes": boxes,
        })
        return None

    def add_text_prompt(self, inference_state, frame_idx, text):
        self.add_text_prompt_calls.append({"frame_idx": frame_idx, "text": text})
        # Multiplex auto-creates obj_ids; return a response with two outputs.
        return {"outputs": {1: {"mask": None}, 2: {"mask": None}}}

    def remove_object(self, inference_state, obj_id):
        self.remove_object_calls.append(obj_id)
        return {"removed": int(obj_id)}

    def reset_session(self, inference_state):
        self.reset_session_calls.append(True)
        return {"reset": True}

    def propagate_in_video(self, inference_state):
        yield 0, {1: np.array([[1, 0], [0, 0]], dtype=np.uint8)}


class _NonMultiplexFakeTracker:
    """Stub WITHOUT remove_object / reset_session / add_text_prompt — mirrors
    the SAM 3 dispatcher adapter surface."""

    def init_state(self, video_path):
        return {"video": video_path}

    def add_new_points(self, state, frame_idx, points, labels):
        return None, None, None

    def add_inputs_at_frame(
        self, inference_state, frame_idx, obj_id,
        points=None, labels=None, boxes=None,
    ):
        return None

    def propagate_in_video(self, state):
        if False:
            yield


def _client() -> TestClient:
    return TestClient(create_app())


def teardown_function(_):
    tracker_mod.reset_for_test()


# --- text prompt on /objects ------------------------------------------------


def test_add_object_with_text_invokes_add_text_prompt() -> None:
    captured: dict = {}

    def _factory():
        t = _MultiplexFakeTracker()
        captured["tracker"] = t
        return t

    tracker_mod.set_test_tracker_factory(_factory)
    client = _client()
    sid = client.post(
        "/sam-track/start", json={"video_url": "https://fake/v.mp4"},
    ).json()["session_id"]

    r = client.post(
        f"/sam-track/{sid}/objects",
        json={"frame_idx": 7, "text": "person"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["frame_idx"] == 7
    assert sorted(body["obj_ids"]) == [1, 2]
    assert captured["tracker"].add_text_prompt_calls == [
        {"frame_idx": 7, "text": "person"},
    ]


def test_add_object_text_on_non_multiplex_returns_422() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _NonMultiplexFakeTracker())
    client = _client()
    sid = client.post(
        "/sam-track/start", json={"video_url": "https://fake/v.mp4"},
    ).json()["session_id"]

    r = client.post(
        f"/sam-track/{sid}/objects",
        json={"frame_idx": 0, "text": "dog"},
    )
    assert r.status_code == 422
    assert "adapter_not_multiplex" in r.text


# --- DELETE /{sid}/objects/{oid} -------------------------------------------


def test_remove_object_calls_adapter_on_multiplex() -> None:
    captured: dict = {}

    def _factory():
        t = _MultiplexFakeTracker()
        captured["tracker"] = t
        return t

    tracker_mod.set_test_tracker_factory(_factory)
    client = _client()
    sid = client.post(
        "/sam-track/start", json={"video_url": "https://fake/v.mp4"},
    ).json()["session_id"]

    r = client.delete(f"/sam-track/{sid}/objects/3")
    assert r.status_code == 204, r.text
    assert captured["tracker"].remove_object_calls == [3]


def test_remove_object_on_non_multiplex_returns_422() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _NonMultiplexFakeTracker())
    client = _client()
    sid = client.post(
        "/sam-track/start", json={"video_url": "https://fake/v.mp4"},
    ).json()["session_id"]

    r = client.delete(f"/sam-track/{sid}/objects/1")
    assert r.status_code == 422
    assert "adapter_not_multiplex" in r.text


def test_remove_object_unknown_session_returns_404() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _MultiplexFakeTracker())
    r = _client().delete("/sam-track/no-such/objects/1")
    assert r.status_code == 404


# --- POST /{sid}/reset -----------------------------------------------------


def test_reset_calls_adapter_on_multiplex() -> None:
    captured: dict = {}

    def _factory():
        t = _MultiplexFakeTracker()
        captured["tracker"] = t
        return t

    tracker_mod.set_test_tracker_factory(_factory)
    client = _client()
    sid = client.post(
        "/sam-track/start", json={"video_url": "https://fake/v.mp4"},
    ).json()["session_id"]

    r = client.post(f"/sam-track/{sid}/reset")
    assert r.status_code == 204, r.text
    assert captured["tracker"].reset_session_calls == [True]


def test_reset_on_non_multiplex_returns_422() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _NonMultiplexFakeTracker())
    client = _client()
    sid = client.post(
        "/sam-track/start", json={"video_url": "https://fake/v.mp4"},
    ).json()["session_id"]

    r = client.post(f"/sam-track/{sid}/reset")
    assert r.status_code == 422
    assert "adapter_not_multiplex" in r.text


def test_reset_unknown_session_returns_404() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _MultiplexFakeTracker())
    r = _client().post("/sam-track/no-such/reset")
    assert r.status_code == 404
