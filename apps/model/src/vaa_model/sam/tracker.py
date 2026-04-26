"""SAM 2 video tracker — protocol + in-memory session store.

A ``Tracker`` advances a single object's mask one frame at a time. Production
binds the protocol to ``sam2.sam2_video_predictor.SAM2VideoPredictor``; tests
inject a stub via ``set_test_tracker_factory``.

State for an active tracking session lives in process memory under
``_SESSIONS[session_id]``. Sessions are abandoned on worker restart — that's
the v1 contract.
"""

import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Protocol

from vaa_model.sam.predictor import (
    _HF_REPO_BY_MODEL,
    _empty_cuda_cache,
    _idle_timeout_s,
    autocast_ctx,
    get_sam_model,
    maybe_compile,
)


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
_SESSION_LAST_USED: dict[str, float] = {}  # session_id -> last activity (monotonic)
_SESSIONS_LOCK = threading.Lock()


_TEST_FACTORY: Any = None


def touch_session(session_id: str) -> None:
    """Update a session's last-activity timestamp.

    Called from ``track_router.py``'s ``/sam-track/{sid}/step`` handler so
    the idle sweeper can release sessions that haven't advanced in a while.
    """
    with _SESSIONS_LOCK:
        _SESSION_LAST_USED[session_id] = time.monotonic()


def evict_idle_sessions() -> list[str]:
    """Release sessions whose last-activity is older than the idle timeout.

    Returns the list of evicted session IDs. No-op when the timeout is 0
    (disabled). When at least one session is evicted, calls
    ``_empty_cuda_cache()`` so the released GPU memory becomes free.
    """
    timeout = _idle_timeout_s()
    if timeout == 0:
        return []
    now = time.monotonic()
    evicted: list[str] = []
    with _SESSIONS_LOCK:
        for sid in list(_SESSIONS.keys()):
            last = _SESSION_LAST_USED.get(sid, now)
            if (now - last) >= timeout:
                _SESSIONS.pop(sid, None)
                _SESSION_LAST_USED.pop(sid, None)
                evicted.append(sid)
    if evicted:
        _empty_cuda_cache()
    return evicted


def force_evict_all_sessions() -> int:
    """Unconditionally release every tracker session. Returns the count."""
    with _SESSIONS_LOCK:
        n = len(_SESSIONS)
        _SESSIONS.clear()
        _SESSION_LAST_USED.clear()
    if n > 0:
        _empty_cuda_cache()
    return n


def set_test_tracker_factory(factory: Any) -> None:
    """Inject a test factory returning a TrackerProtocol-implementing stub."""
    global _TEST_FACTORY
    _TEST_FACTORY = factory


def _default_factory() -> TrackerProtocol:
    """Production factory — imports lazily; pulls the HF repo from get_sam_model().

    When ``SAM_MODEL=sam3`` is selected, builds the SAM 3 video tracker
    adapter via ``vaa_model.sam.sam3_adapter``. The adapter is text-prompt
    based (concept tracking); ``track_router`` enforces the ``text`` field
    requirement at the HTTP boundary.
    """
    model = get_sam_model()
    if model == "sam3":
        from vaa_model.sam import sam3_adapter

        return sam3_adapter.build_sam3_video_tracker()
    repo = _HF_REPO_BY_MODEL[model]

    import torch  # type: ignore[import-not-found]
    from sam2.sam2_video_predictor import SAM2VideoPredictor  # type: ignore[import-not-found]

    p = SAM2VideoPredictor.from_pretrained(repo)
    p.model.to("cuda" if torch.cuda.is_available() else "cpu")
    p.model = maybe_compile(p.model)
    return p


def _get_tracker() -> TrackerProtocol:
    if _TEST_FACTORY is not None:
        return _TEST_FACTORY()
    return _default_factory()


def start_session(
    *,
    video_url: str,
    frame_idx: int,
    points: list[Any],
    labels: list[Any],
) -> TrackerSession:
    """Initialize a tracker session.

    ``points`` and ``labels`` are intentionally typed as ``list[Any]`` so
    the same entrypoint can carry either SAM 2 click data
    (``list[list[int]]`` / ``list[int]``) or a SAM 3 text prompt list
    (``list[str]``) — the underlying ``TrackerProtocol.add_new_points``
    implementation interprets them according to which adapter is loaded.
    """
    tracker = _get_tracker()
    # init_state just downloads/decodes the video — no GPU forward — so it
    # stays outside the autocast. The forward pass that computes the seed
    # mask happens inside add_new_points and benefits from bf16.
    inference_state = tracker.init_state(video_url)
    with autocast_ctx():
        tracker.add_new_points(inference_state, frame_idx, points, labels)
    session = TrackerSession(
        session_id=str(uuid.uuid4()),
        tracker=tracker,
        inference_state=inference_state,
        last_frame_idx=frame_idx,
    )
    with _SESSIONS_LOCK:
        _SESSIONS[session.session_id] = session
        _SESSION_LAST_USED[session.session_id] = time.monotonic()
    return session


def get_session(session_id: str) -> TrackerSession | None:
    with _SESSIONS_LOCK:
        return _SESSIONS.get(session_id)


def release_session(session_id: str) -> bool:
    with _SESSIONS_LOCK:
        existed = _SESSIONS.pop(session_id, None) is not None
        _SESSION_LAST_USED.pop(session_id, None)
        return existed


def reset_for_test() -> None:
    """Clear all in-memory sessions and the test factory. Use in test teardown."""
    global _TEST_FACTORY
    with _SESSIONS_LOCK:
        _SESSIONS.clear()
        _SESSION_LAST_USED.clear()
    _TEST_FACTORY = None
