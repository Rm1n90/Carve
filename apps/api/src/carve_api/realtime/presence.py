# Armin Mehri — mehri.armin@gmail.com
"""In-process presence tracker for the realtime collaboration channel.

What "presence" means here:

  * Snapshot — the list of other users currently connected to this
    task, sent in ``hello.presence`` so a freshly-joined client sees
    everyone who's already there.
  * ``presence:join`` / ``presence:leave`` — broadcast when a WS
    opens or closes so existing users see teammates arriving /
    leaving without re-snapshotting.
  * ``presence:cursor`` — high-frequency mouse position broadcast,
    throttled to a defensive ~30 Hz floor at the server (the
    frontend targets 20 Hz; the floor is just a defence against a
    misbehaving client flooding the channel).
  * ``presence:focus`` — soft indicator that a user is interacting
    with a specific annotation. No hard lock — Phase 5 keeps focus
    as a UI signal only; concurrent edits remain technically
    allowed.

What this module does NOT do:

  * Multi-worker fan-out. v1 broadcasts presence via the in-process
    ``ConnectionManager`` only, NOT through the Redis bus. That keeps
    cursor traffic out of the replay buffer (it'd churn it) and out
    of pub/sub at 20 Hz × N users (it'd be a lot of traffic for
    transient state). Multi-worker WS deployment is a deferred
    concern; documented here so a future migration knows what to
    rewire.
  * Hard locks. ``focus_target`` is advisory.
  * Persistence. Presence is ephemeral — disconnecting clears it.
"""

from __future__ import annotations

import hashlib
import time
import uuid
from typing import Any

from carve_api.realtime.manager import Connection, ConnectionManager, get_manager
from carve_api.realtime.schemas import (
    PresenceUser,
    ServerPresenceCursor,
    ServerPresenceFocus,
    ServerPresenceJoin,
    ServerPresenceLeave,
)

# ----- Color palette --------------------------------------------------------

# Ten high-contrast tones picked to remain readable in both light and
# dark themes. Order is meaningful: ``color_for_user`` hashes user_id
# bytes into this list, so re-ordering would shift every user's
# assigned color — only ever append.
PRESENCE_PALETTE: tuple[str, ...] = (
    "#f87171",  # red-400
    "#fb923c",  # orange-400
    "#fbbf24",  # amber-400
    "#a3e635",  # lime-400
    "#34d399",  # emerald-400
    "#22d3ee",  # cyan-400
    "#60a5fa",  # blue-400
    "#a78bfa",  # violet-400
    "#f472b6",  # pink-400
    "#94a3b8",  # slate-400
)


def color_for_user(user_id: uuid.UUID) -> str:
    """Deterministic palette index for ``user_id``.

    Stable across all sessions of the same user — important so a
    collaborator's color doesn't flicker between tab reloads — and
    stable across worker processes, since SHA-256 is not salted
    per-process the way Python's built-in ``hash()`` is.

    The frontend (Phase 6) reproduces this exact logic so colours
    match end-to-end on both sides of the wire.
    """
    digest = hashlib.sha256(user_id.bytes).digest()
    return PRESENCE_PALETTE[digest[0] % len(PRESENCE_PALETTE)]


# ----- Throttle constants ---------------------------------------------------

# Minimum interval between cursor broadcasts from a single session,
# in ms. 33 ms ≈ 30 Hz floor — the frontend targets 20 Hz so this is
# never hit in normal use; it's a defensive cap against a buggy
# client sending at 60+ Hz.
CURSOR_BROADCAST_INTERVAL_MS = 33


def _now_ms() -> int:
    """Monotonic-ish wall clock in ms. Wrapped so tests can monkeypatch
    a controlled value."""
    return int(time.time() * 1000)


# ----- Tracker --------------------------------------------------------------


class PresenceTracker:
    """High-level operations on top of the :class:`ConnectionManager`.

    The tracker is stateless beyond what the connections already
    carry — cursor / focus / last-broadcast-ms all live on the
    :class:`Connection` dataclass. That keeps presence and lifecycle
    aligned: when a connection unregisters, its presence vanishes
    with it.
    """

    def __init__(self, manager: ConnectionManager) -> None:
        self._manager = manager

    # -- snapshot for hello.presence -----------------------------------

    def snapshot(
        self,
        task_id: uuid.UUID,
        *,
        exclude_session: uuid.UUID | None = None,
    ) -> list[dict[str, Any]]:
        """List of presence-user entries for ``task_id``, ready to drop
        into a hello envelope's ``presence`` field.

        ``exclude_session`` filters out the recipient's own
        connection — a fresh client doesn't need to see itself in the
        list. The server calls this with ``exclude_session=self.session_id``
        from inside the WS handler.
        """
        entries: list[dict[str, Any]] = []
        for conn in self._manager.connections_for(task_id):
            if exclude_session is not None and conn.session_id == exclude_session:
                continue
            entries.append(
                PresenceUser(
                    user_id=conn.user_id,
                    session_id=conn.session_id,
                    name=conn.user_name,
                    color=conn.color,
                ).model_dump(mode="json")
            )
        return entries

    # -- join / leave broadcasts ---------------------------------------

    def broadcast_join(self, conn: Connection) -> int:
        """Notify peers that ``conn`` joined. Returns the number of
        queues the message landed in (zero is fine — the joiner is
        alone on the task)."""
        msg = ServerPresenceJoin(
            user=PresenceUser(
                user_id=conn.user_id,
                session_id=conn.session_id,
                name=conn.user_name,
                color=conn.color,
            ),
        ).model_dump(mode="json")
        return self._manager.broadcast(
            conn.task_id, msg, exclude_session=conn.session_id,
        )

    def broadcast_leave(self, conn: Connection) -> int:
        """Notify peers that ``conn`` left."""
        msg = ServerPresenceLeave(
            session_id=conn.session_id,
            user_id=conn.user_id,
        ).model_dump(mode="json")
        return self._manager.broadcast(
            conn.task_id, msg, exclude_session=conn.session_id,
        )

    # -- cursor + focus --------------------------------------------------

    def update_cursor(
        self,
        conn: Connection,
        *,
        asset_id: uuid.UUID,
        frame_id: uuid.UUID | None,
        x: float,
        y: float,
    ) -> bool:
        """Record + (throttled) broadcast a cursor update. Returns
        ``True`` when the broadcast went out, ``False`` when the
        throttle window suppressed it.

        The Connection's stored cursor is updated every time so any
        future snapshot (e.g. a late-joiner's hello) reflects the
        latest position even if the immediately-preceding broadcast
        was throttled.
        """
        now = _now_ms()
        # Update first — always — so the stored cursor stays fresh
        # even under throttle.
        conn.cursor_asset_id = asset_id
        conn.cursor_frame_id = frame_id
        conn.cursor_x = float(x)
        conn.cursor_y = float(y)
        if now - conn.last_cursor_broadcast_ms < CURSOR_BROADCAST_INTERVAL_MS:
            return False
        conn.last_cursor_broadcast_ms = now
        msg = ServerPresenceCursor(
            session_id=conn.session_id,
            user_id=conn.user_id,
            asset_id=asset_id,
            frame_id=frame_id,
            x=float(x),
            y=float(y),
        ).model_dump(mode="json")
        self._manager.broadcast(
            conn.task_id, msg, exclude_session=conn.session_id,
        )
        return True

    def update_focus(
        self,
        conn: Connection,
        target: dict | None,
    ) -> None:
        """Record + broadcast a focus change. Focus is low-frequency
        (one event per user interaction) so it isn't throttled."""
        conn.focus_target = target
        msg = ServerPresenceFocus(
            session_id=conn.session_id,
            user_id=conn.user_id,
            target=target,
        ).model_dump(mode="json")
        self._manager.broadcast(
            conn.task_id, msg, exclude_session=conn.session_id,
        )


# ----- Singleton accessor ---------------------------------------------------

_tracker: PresenceTracker | None = None


def get_tracker() -> PresenceTracker:
    """Process-wide singleton tracker bound to the singleton manager."""
    global _tracker
    if _tracker is None:
        _tracker = PresenceTracker(get_manager())
    return _tracker


def reset_tracker_for_test() -> PresenceTracker:
    """Bind a fresh tracker (still backed by the singleton manager).
    Tests only."""
    global _tracker
    _tracker = PresenceTracker(get_manager())
    return _tracker
