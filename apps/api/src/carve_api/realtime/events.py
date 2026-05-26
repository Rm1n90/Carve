# Armin Mehri — mehri.armin@gmail.com
"""Event emitters consumed by mutating REST routes.

These are thin wrappers over :func:`carve_api.realtime.bus.RealtimeBus.publish`
that keep payload-shape knowledge in one place and swallow publish
errors so a flaky Redis cannot break the actual annotation write. If a
publish fails the DB transaction has already committed; clients that
miss the broadcast catch up on next reconnect (the WS replay path) or
via the existing ``GET /tasks/{id}/annotations`` re-fetch.

Payload shape contract (one of):

  * ``{"v": 1, "type": "ops:upsert",  "annotation": {...}, "actor_id", "origin_session"}``
  * ``{"v": 1, "type": "ops:delete",  "annotation_id", "actor_id", "origin_session"}``
  * ``{"v": 1, "type": "ops:batch",   "ops": [...], "actor_id", "origin_session"}``

The bus stamps a monotonic ``seq`` and wall-clock ``ts`` (epoch ms) on
top of each payload at publish time — they're NOT part of the dict
constructed here. The WebSocket subscriber merges them in when
forwarding to a client (see :mod:`carve_api.realtime.router`).

``ops`` entries inside ``ops:batch`` are themselves self-describing
mini-messages so the frontend can iterate the list and dispatch each
one through its normal upsert/delete handlers:

  * ``{"type": "ops:upsert", "annotation": {...}}``
  * ``{"type": "ops:delete", "annotation_id": "..."}``
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from carve_api.realtime.bus import get_bus
from carve_api.realtime.schemas import PROTOCOL_VERSION

logger = logging.getLogger(__name__)


def _origin(origin_session: uuid.UUID | None) -> str | None:
    return str(origin_session) if origin_session is not None else None


def _safe_log(action: str, exc: BaseException) -> None:
    """Log a publish failure without leaking it to the REST caller."""
    logger.warning("realtime: %s publish failed: %r", action, exc)


async def emit_ops_upsert(
    *,
    task_id: uuid.UUID,
    annotation: dict[str, Any],
    actor_id: uuid.UUID,
    origin_session: uuid.UUID | None,
) -> None:
    """Broadcast a single create / update."""
    payload: dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "type": "ops:upsert",
        "annotation": annotation,
        "actor_id": str(actor_id),
        "origin_session": _origin(origin_session),
    }
    try:
        await get_bus().publish(task_id, payload)
    except Exception as exc:  # noqa: BLE001 — log + swallow
        _safe_log("ops:upsert", exc)


async def emit_ops_delete(
    *,
    task_id: uuid.UUID,
    annotation_id: uuid.UUID,
    actor_id: uuid.UUID,
    origin_session: uuid.UUID | None,
) -> None:
    """Broadcast a single delete."""
    payload: dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "type": "ops:delete",
        "annotation_id": str(annotation_id),
        "actor_id": str(actor_id),
        "origin_session": _origin(origin_session),
    }
    try:
        await get_bus().publish(task_id, payload)
    except Exception as exc:  # noqa: BLE001 — log + swallow
        _safe_log("ops:delete", exc)


async def emit_ops_batch(
    *,
    task_id: uuid.UUID,
    ops: list[dict[str, Any]],
    actor_id: uuid.UUID,
    origin_session: uuid.UUID | None,
) -> None:
    """Broadcast a mixed create/update/delete batch.

    ``ops`` entries must be self-describing dicts; see module docstring.
    An empty list is a no-op (we don't push noise to subscribers when
    the calling batch was a pure validation pass).
    """
    if not ops:
        return
    payload: dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "type": "ops:batch",
        "ops": ops,
        "actor_id": str(actor_id),
        "origin_session": _origin(origin_session),
    }
    try:
        await get_bus().publish(task_id, payload)
    except Exception as exc:  # noqa: BLE001 — log + swallow
        _safe_log("ops:batch", exc)


def make_upsert_op(annotation: dict[str, Any]) -> dict[str, Any]:
    """Build one self-describing upsert entry for ``ops:batch``."""
    return {"type": "ops:upsert", "annotation": annotation}


def make_delete_op(annotation_id: uuid.UUID | str) -> dict[str, Any]:
    """Build one self-describing delete entry for ``ops:batch``."""
    return {"type": "ops:delete", "annotation_id": str(annotation_id)}


__all__ = [
    "emit_ops_batch",
    "emit_ops_delete",
    "emit_ops_upsert",
    "make_delete_op",
    "make_upsert_op",
]
