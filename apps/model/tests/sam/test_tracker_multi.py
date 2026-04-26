"""Tests for v1.4 multi-object tracking — protocol-level concerns.

Covers:

- ``add_object_to_session(...)`` routes through the new
  ``TrackerProtocol.add_inputs_at_frame(...)`` method.
- ``propagate_in_video`` yields ``(frame_idx, dict[obj_id, mask])``.
- The legacy ``start_session(video_url=..., points=..., labels=...)``
  signature still works and auto-adds the prompt as ``obj_id=1`` for
  backward compatibility.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from vaa_model.sam import tracker as tracker_mod


class _MultiObjectFakeTracker:
    """Stub matching the v1.4 TrackerProtocol with multi-object semantics."""

    def __init__(self) -> None:
        self.added_inputs: list[dict[str, Any]] = []

    def init_state(self, video_path: str) -> dict:
        return {"video": video_path, "objects": {}}

    def add_new_points(self, state, frame_idx, points, labels):  # legacy
        self.added_inputs.append({
            "frame_idx": frame_idx,
            "obj_id": 1,
            "points": list(points),
            "labels": list(labels),
            "boxes": None,
            "via": "legacy",
        })
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
        self.added_inputs.append({
            "frame_idx": frame_idx,
            "obj_id": obj_id,
            "points": list(points) if points else None,
            "labels": list(labels) if labels else None,
            "boxes": list(boxes) if boxes else None,
            "via": "v14",
        })
        return None

    def propagate_in_video(self, inference_state):
        # Yield two frames, each with two objects.
        masks_a = np.array([[1, 0], [0, 0]], dtype=np.uint8)
        masks_b = np.array([[0, 0], [0, 1]], dtype=np.uint8)
        yield 0, {1: masks_a, 2: masks_b}
        yield 1, {1: masks_b, 2: masks_a}


def teardown_function(_):
    tracker_mod.reset_for_test()


def test_add_object_to_session_routes_to_tracker_add_inputs_at_frame() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _MultiObjectFakeTracker())
    session = tracker_mod.start_session(video_url="https://fake/v.mp4")

    tracker_mod.add_object_to_session(
        session,
        frame_idx=12,
        obj_id=2,
        points=[[100, 200]],
        labels=[1],
    )

    fake = session.tracker
    assert isinstance(fake, _MultiObjectFakeTracker)
    assert fake.added_inputs == [
        {
            "frame_idx": 12,
            "obj_id": 2,
            "points": [[100, 200]],
            "labels": [1],
            "boxes": None,
            "via": "v14",
        },
    ]


def test_add_object_to_session_forwards_boxes() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _MultiObjectFakeTracker())
    session = tracker_mod.start_session(video_url="https://fake/v.mp4")

    tracker_mod.add_object_to_session(
        session,
        frame_idx=0,
        obj_id=3,
        boxes=[[1, 2, 3, 4]],
    )

    fake = session.tracker
    assert fake.added_inputs[0]["boxes"] == [[1, 2, 3, 4]]
    assert fake.added_inputs[0]["points"] is None


def test_propagate_yields_per_object_dict() -> None:
    tracker_mod.set_test_tracker_factory(lambda: _MultiObjectFakeTracker())
    session = tracker_mod.start_session(video_url="https://fake/v.mp4")

    output = list(session.tracker.propagate_in_video(session.inference_state))

    assert len(output) == 2
    frame0, masks0 = output[0]
    assert frame0 == 0
    assert isinstance(masks0, dict)
    assert set(masks0.keys()) == {1, 2}
    for mask in masks0.values():
        assert isinstance(mask, np.ndarray)


def test_legacy_start_session_with_points_adds_obj_1() -> None:
    """Backward-compat: the v1.3 ``start_session(video_url=..., points=...,
    labels=...)`` shape still auto-adds the prompt as obj_id=1."""
    tracker_mod.set_test_tracker_factory(lambda: _MultiObjectFakeTracker())

    session = tracker_mod.start_session(
        video_url="https://fake/v.mp4",
        frame_idx=0,
        points=[[10, 20]],
        labels=[1],
    )

    fake = session.tracker
    assert isinstance(fake, _MultiObjectFakeTracker)
    assert len(fake.added_inputs) == 1
    call = fake.added_inputs[0]
    # obj_id must be 1 for backward compat.
    assert call["obj_id"] == 1
    assert call["frame_idx"] == 0
    assert call["points"] == [[10, 20]]
    assert call["labels"] == [1]


def test_start_session_with_no_points_creates_empty_session() -> None:
    """v1.4: start_session may be called WITHOUT points/labels — caller is
    expected to add objects via add_object_to_session before stepping."""
    tracker_mod.set_test_tracker_factory(lambda: _MultiObjectFakeTracker())

    session = tracker_mod.start_session(video_url="https://fake/v.mp4")

    fake = session.tracker
    assert isinstance(fake, _MultiObjectFakeTracker)
    # No prompts added yet.
    assert fake.added_inputs == []
