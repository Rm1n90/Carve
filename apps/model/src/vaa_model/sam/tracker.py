"""SAM 2 video tracker — protocol + in-memory session store.

A ``Tracker`` advances a single object's mask one frame at a time. Production
binds the protocol to ``sam2.sam2_video_predictor.SAM2VideoPredictor``; tests
inject a stub via ``set_test_tracker_factory``.

State for an active tracking session lives in process memory under
``_SESSIONS[session_id]``. Sessions are abandoned on worker restart — that's
the v1 contract.
"""

import threading
import uuid
from dataclasses import dataclass
from typing import Any, Protocol


class TrackerProtocol(Protocol):
    """Subset of SAM2VideoPredictor we use."""

    def init_state(self, video_path: str) -> Any: ...

    def add_new_points(
        self, inference_state: Any, frame_idx: int, points: Any, labels: Any,
    ) -> tuple[Any, Any, Any]: ...

    def propagate_in_video(self, inference_state: Any) -> Any: ...


@dataclass
class TrackerSession:
    """Holds the predictor + inference state + cursor for one active session."""

    session_id: str
    tracker: TrackerProtocol
    inference_state: Any
    last_frame_idx: int = 0
    propagation_iter: Any = None  # populated lazily on first step()


_SESSIONS: dict[str, TrackerSession] = {}
_SESSIONS_LOCK = threading.Lock()


_TEST_FACTORY: Any = None


def set_test_tracker_factory(factory: Any) -> None:
    """Inject a test factory returning a TrackerProtocol-implementing stub."""
    global _TEST_FACTORY
    _TEST_FACTORY = factory


def _default_factory() -> TrackerProtocol:
    """Production factory — imported lazily."""
    import torch  # type: ignore[import-not-found]
    from sam2.sam2_video_predictor import SAM2VideoPredictor  # type: ignore[import-not-found]

    p = SAM2VideoPredictor.from_pretrained("facebook/sam2-hiera-large")
    p.model.to("cuda" if torch.cuda.is_available() else "cpu")
    return p


def _get_tracker() -> TrackerProtocol:
    if _TEST_FACTORY is not None:
        return _TEST_FACTORY()
    return _default_factory()


def start_session(
    *,
    video_url: str,
    frame_idx: int,
    points: list[list[int]],
    labels: list[int],
) -> TrackerSession:
    tracker = _get_tracker()
    inference_state = tracker.init_state(video_url)
    tracker.add_new_points(inference_state, frame_idx, points, labels)
    session = TrackerSession(
        session_id=str(uuid.uuid4()),
        tracker=tracker,
        inference_state=inference_state,
        last_frame_idx=frame_idx,
    )
    with _SESSIONS_LOCK:
        _SESSIONS[session.session_id] = session
    return session


def get_session(session_id: str) -> TrackerSession | None:
    with _SESSIONS_LOCK:
        return _SESSIONS.get(session_id)


def release_session(session_id: str) -> bool:
    with _SESSIONS_LOCK:
        return _SESSIONS.pop(session_id, None) is not None


def reset_for_test() -> None:
    """Clear all in-memory sessions and the test factory. Use in test teardown."""
    global _TEST_FACTORY
    with _SESSIONS_LOCK:
        _SESSIONS.clear()
    _TEST_FACTORY = None
