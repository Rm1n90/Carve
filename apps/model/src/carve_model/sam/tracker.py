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

import logging
import os
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

logger = logging.getLogger(__name__)


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
    # v3.8 Phase 4-video step F6 -- temp dir of downloaded frame JPEGs
    # for sessions started from a frame_urls list (post-extract videos
    # whose original mp4 has been deleted). release_session() rmtrees it.
    tmpdir: str | None = None


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
    backend = os.environ.get("SAM_VIDEO_BACKEND", "").lower()

    # Plan 11 — SAM 3.1 native multiplex video adapter. Opt-in via
    # ``SAM_VIDEO_BACKEND=multiplex`` (or ``SAM_MODEL=sam3.1``); requires
    # the native ``sam3`` git package. Falls back to the SAM 3 transformers
    # dispatcher when the native package is unavailable.
    if backend == "multiplex" or model == "sam3.1":
        try:
            from carve_model.sam.sam3p1_adapter import (
                build_sam3p1_multiplex_video_tracker,
            )

            return build_sam3p1_multiplex_video_tracker()
        except ImportError as exc:
            logger.warning(
                "sam3.1 multiplex backend requested but native sam3 package not "
                "available: %s; falling back to transformers SAM 3 dispatcher",
                exc,
            )
            from carve_model.sam import sam3_adapter

            return sam3_adapter.build_sam3_video_tracker()

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


def _start_empty_session(
    video_url: str, tmpdir: str | None = None
) -> TrackerSession:
    """Create a tracker session with no objects yet.

    Used directly by the multi-object code path (and indirectly by
    ``start_session`` when called without prompts).

    v3.8 Phase 4-video step F6 — ``tmpdir`` is recorded on the session
    so ``release_session`` can rmtree it. Caller is responsible for
    populating the dir before calling this; ``video_url`` may point at
    that dir or at a single video file.
    """
    tracker = _get_tracker()
    inference_state = tracker.init_state(video_url)
    session = TrackerSession(
        session_id=str(uuid.uuid4()),
        tracker=tracker,
        inference_state=inference_state,
        tmpdir=tmpdir,
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
    tmpdir: str | None = None,
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
    session = _start_empty_session(video_url, tmpdir=tmpdir)
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


def remove_object_from_session(session: TrackerSession, *, obj_id: int) -> None:
    """Remove a tracked object from an in-flight session.

    Only supported by adapters with a ``remove_object`` method (the SAM 3.1
    multiplex adapter). Raises ``NotImplementedError`` otherwise — the router
    translates that to HTTP 422 ``adapter_not_multiplex``.
    """
    if not hasattr(session.tracker, "remove_object"):
        raise NotImplementedError("active tracker does not support remove_object")
    session.tracker.remove_object(session.inference_state, obj_id=obj_id)


def reset_session_text(session: TrackerSession) -> None:
    """Reset a session's text-driven prompts (SAM 3.1 multiplex).

    Raises ``NotImplementedError`` when the active adapter is not the
    multiplex one — translated to HTTP 422 by the router.
    """
    if not hasattr(session.tracker, "reset_session"):
        raise NotImplementedError("active tracker does not support reset_session")
    session.tracker.reset_session(session.inference_state)


def get_session(session_id: str) -> TrackerSession | None:
    with _SESSIONS_LOCK:
        return _SESSIONS.get(session_id)


def release_session(session_id: str) -> bool:
    with _SESSIONS_LOCK:
        sess = _SESSIONS.pop(session_id, None)
        _SESSION_LAST_USED.pop(session_id, None)
    # v3.8 Phase 4-video step F6 — rmtree the temp frames dir if the
    # session was started from a frame_urls list. Outside the lock so a
    # slow rmtree doesn't block other sessions.
    if sess is not None and sess.tmpdir:
        try:
            import shutil
            shutil.rmtree(sess.tmpdir, ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass
    return sess is not None


def reset_for_test() -> None:
    """Clear all in-memory sessions and the test factory. Use in test teardown."""
    global _TEST_FACTORY
    with _SESSIONS_LOCK:
        _SESSIONS.clear()
        _SESSION_LAST_USED.clear()
    _TEST_FACTORY = None
