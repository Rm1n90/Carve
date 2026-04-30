"""SAM 2 / SAM 3 video tracker — protocol + in-memory session store.

A ``Tracker`` advances objects' masks one frame at a time. Production
binds the protocol to ``Sam2VideoTrackerAdapter`` (Hugging Face
``Sam2VideoModel`` + ``Sam2VideoProcessor``) for SAM 2 paths and to
``Sam3VideoDispatcherAdapter`` for SAM 3. Tests inject a stub via
``set_test_tracker_factory``.

State for an active tracking session lives in process memory under
``_SESSIONS[session_id]``. Sessions are abandoned on worker restart —
that's the v1 contract.

v1.4 introduces multi-object support:

- ``TrackerProtocol.add_inputs_at_frame(state, frame_idx, obj_id, ...)``
  is the new entrypoint. The legacy ``add_new_points`` stays as a
  convenience that auto-routes to ``add_inputs_at_frame`` with
  ``obj_id=1`` for backward compatibility.
- ``propagate_in_video`` now yields ``(frame_idx, dict[obj_id, mask])``
  instead of ``(frame_idx, mask)``. The router auto-wraps legacy fakes
  yielding a single mask as ``{1: mask}`` so older test fakes continue
  to work without modification.
"""

import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Protocol

from carve_model.sam.predictor import (
    _empty_cuda_cache,
    _idle_timeout_s,
    autocast_ctx,
    get_sam_model,
)


class TrackerProtocol(Protocol):
    """Subset of the SAM 2 / SAM 3 video predictor surface we use."""

    def init_state(self, video_path: str) -> Any: ...

    def add_new_points(
        self, inference_state: Any, frame_idx: int, points: Any, labels: Any,
    ) -> tuple[Any, Any, Any]: ...

    # v1.4: per-object prompt insertion. Implementations route to the
    # underlying predictor's multi-object API. ``points`` carries either
    # numeric clicks or text strings (SAM 3 dispatcher); ``boxes`` carries
    # xyxy coordinates. Implementations should accept ``None`` for any
    # input that wasn't supplied.
    def add_inputs_at_frame(
        self,
        inference_state: Any,
        frame_idx: int,
        obj_id: int,
        points: Any = None,
        labels: Any = None,
        boxes: Any = None,
    ) -> Any: ...

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
    adapter via ``carve_model.sam.sam3_adapter``. The adapter is text-prompt
    based (concept tracking); ``track_router`` enforces the ``text`` field
    requirement at the HTTP boundary.

    For SAM 2.x variants the tracker is built via
    ``carve_model.sam.sam2_adapter`` on top of Hugging Face transformers
    (``Sam2VideoModel`` + ``Sam2VideoProcessor``). The legacy upstream
    ``sam2`` git package path was removed in v3.4 commit 6.
    """
    model = get_sam_model()
    if model == "sam3":
        from carve_model.sam import sam3_adapter

        return sam3_adapter.build_sam3_video_tracker()

    if model.startswith("sam2"):
        from carve_model.sam import sam2_adapter

        return sam2_adapter.build_sam2_video_tracker(model)

    raise ValueError(f"unknown SAM model {model!r}")


def _get_tracker() -> TrackerProtocol:
    if _TEST_FACTORY is not None:
        return _TEST_FACTORY()
    return _default_factory()


def _start_empty_session(video_url: str) -> TrackerSession:
    """Create a tracker session with no objects yet.

    Used directly by the multi-object code path (and indirectly by
    ``start_session`` when called without prompts).
    """
    tracker = _get_tracker()
    inference_state = tracker.init_state(video_url)
    session = TrackerSession(
        session_id=str(uuid.uuid4()),
        tracker=tracker,
        inference_state=inference_state,
    )
    with _SESSIONS_LOCK:
        _SESSIONS[session.session_id] = session
        _SESSION_LAST_USED[session.session_id] = time.monotonic()
    return session


def start_session(
    *,
    video_url: str,
    frame_idx: int = 0,
    points: list[Any] | None = None,
    labels: list[Any] | None = None,
) -> TrackerSession:
    """Initialize a tracker session.

    v1.4 backward-compat: when ``points`` is non-empty, the prompt is
    auto-added as ``obj_id=1`` so the v1.3 single-object call shape keeps
    working. When ``points`` is empty/None the session is created with
    no objects — the caller is expected to add them via
    ``add_object_to_session`` before stepping.

    ``points`` and ``labels`` are intentionally typed as ``list[Any]`` so
    the same entrypoint can carry either SAM 2 click data
    (``list[list[int]]`` / ``list[int]``) or a SAM 3 text prompt list
    (``list[str]``) — the underlying ``TrackerProtocol`` implementation
    interprets them according to which adapter is loaded.
    """
    session = _start_empty_session(video_url)
    if points:
        with autocast_ctx():
            # Prefer the new per-object entrypoint (always available on
            # v1.4-compliant trackers). Fall back to legacy
            # ``add_new_points`` only if the tracker doesn't implement the
            # new method — keeps the protocol forward-compatible without
            # breaking older test stubs that pre-date the rename.
            if hasattr(session.tracker, "add_inputs_at_frame"):
                session.tracker.add_inputs_at_frame(
                    session.inference_state,
                    frame_idx=frame_idx,
                    obj_id=1,
                    points=points,
                    labels=labels,
                )
            else:
                session.tracker.add_new_points(
                    session.inference_state, frame_idx, points, labels,
                )
        session.last_frame_idx = frame_idx
    return session


def add_object_to_session(
    session: TrackerSession,
    *,
    frame_idx: int,
    obj_id: int,
    points: Any = None,
    labels: Any = None,
    boxes: Any = None,
) -> None:
    """Attach a new object's prompt to an active session.

    Wraps ``TrackerProtocol.add_inputs_at_frame`` and runs the underlying
    forward pass under autocast so the seed-mask computation benefits
    from bf16 on GPU.
    """
    with autocast_ctx():
        session.tracker.add_inputs_at_frame(
            session.inference_state,
            frame_idx=frame_idx,
            obj_id=obj_id,
            points=points,
            labels=labels,
            boxes=boxes,
        )


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
