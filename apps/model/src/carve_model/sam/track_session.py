# Armin Mehri — mehri.armin@gmail.com
"""SAM 3.1 multiplex track session manager.

Single backend, single code path. The ``sam3`` native package is imported
lazily so unit tests can inject a fake predictor via ``_set_predictor_for_test``.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from carve_model.sam.track_frame_cache import ensure_cached

logger = logging.getLogger(__name__)


@dataclass
class TrackSession:
    """One in-flight tracking session."""

    session_id: str                 # local id (uuid)
    native_session_id: str          # the predictor's id (mirrored in requests)
    image_size: tuple[int, int]     # (h, w)
    frame_dir: Path
    frame_count: int
    asset_hash: str
    obj_classes: dict[int, str] = field(default_factory=dict)
    last_used: float = field(default_factory=time.monotonic)


_SESSIONS: dict[str, TrackSession] = {}
_LOCK = threading.Lock()
_PREDICTOR: Any | None = None
_TEST_PREDICTOR: Any | None = None
_IDLE_TIMEOUT_S = 600.0  # 10 min


def _set_predictor_for_test(predictor: Any | None) -> None:
    """Inject a fake multiplex predictor for unit tests."""
    global _TEST_PREDICTOR
    _TEST_PREDICTOR = predictor


def _get_predictor() -> Any:
    if _TEST_PREDICTOR is not None:
        return _TEST_PREDICTOR
    global _PREDICTOR
    if _PREDICTOR is None:
        from sam3.model_builder import (  # type: ignore[import-not-found]
            build_sam3_multiplex_video_predictor,
        )
        _PREDICTOR = build_sam3_multiplex_video_predictor()
    return _PREDICTOR


def open_session(
    *,
    frame_urls: list[str],
    image_size: tuple[int, int],
    asset_hash: str,
) -> TrackSession:
    frame_dir = ensure_cached(asset_hash=asset_hash, frame_urls=frame_urls)
    predictor = _get_predictor()
    resp = predictor.handle_request({
        "type": "start_session",
        "resource_path": str(frame_dir),
    })
    if not isinstance(resp, dict) or "session_id" not in resp:
        raise RuntimeError(
            f"start_session_unexpected_response: {resp!r}",
        )
    sess = TrackSession(
        session_id=str(uuid.uuid4()),
        native_session_id=str(resp["session_id"]),
        image_size=image_size,
        frame_dir=frame_dir,
        frame_count=len(frame_urls),
        asset_hash=asset_hash,
    )
    with _LOCK:
        _SESSIONS[sess.session_id] = sess
    return sess


def get_session(session_id: str) -> TrackSession | None:
    with _LOCK:
        sess = _SESSIONS.get(session_id)
    if sess is not None:
        sess.last_used = time.monotonic()
    return sess


def close_session(session_id: str) -> bool:
    with _LOCK:
        sess = _SESSIONS.pop(session_id, None)
    if sess is None:
        return False
    try:
        _get_predictor().handle_request({
            "type": "close_session",
            "session_id": sess.native_session_id,
        })
    except Exception as exc:  # noqa: BLE001
        logger.warning("close_session best-effort failed: %s", exc)
    return True


def evict_idle_sessions() -> list[str]:
    now = time.monotonic()
    evicted: list[str] = []
    with _LOCK:
        for sid in list(_SESSIONS):
            if (now - _SESSIONS[sid].last_used) >= _IDLE_TIMEOUT_S:
                _SESSIONS.pop(sid, None)
                evicted.append(sid)
    return evicted
