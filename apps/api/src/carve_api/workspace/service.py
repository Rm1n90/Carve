"""Service layer for the singleton workspace (v3.1 Bug 6).

The migration in ``alembic/versions/0012_workspace.py`` seeds exactly one
row, so ``get`` should never raise in a healthy install. The
``RuntimeError`` is defence in depth — if a deployment somehow ends up
with an empty table we surface it loudly instead of silently returning
``None``.
"""
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.workspace.models import Workspace


class WorkspaceService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def get(self) -> Workspace:
        ws = self.session.scalar(select(Workspace).limit(1))
        if ws is None:
            raise RuntimeError("workspace singleton missing")
        return ws

    def update(
        self,
        *,
        name: str | None = None,
        description: str | None = None,
    ) -> Workspace:
        ws = self.get()
        # Only patch fields that were sent — Pydantic gives us ``None`` for
        # fields the client omitted, which we treat as "no change". To clear
        # the description, callers can send an empty string instead.
        if name is not None:
            ws.name = name
        if description is not None:
            ws.description = description
        ws.updated_at = datetime.now(timezone.utc)
        self.session.commit()
        return ws
