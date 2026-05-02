# Armin Mehri — mehri.armin@gmail.com
"""SQLAlchemy model for the singleton workspace row.

The table is created by Alembic migration ``0012_workspace`` which also
seeds exactly one row, so the application code never has to handle a
"missing workspace" case at runtime — see ``service.WorkspaceService.get``
which still raises defensively if the invariant is somehow violated.
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from carve_api.db import Base


class Workspace(Base):
    __tablename__ = "workspace"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(
        String(120), nullable=False, default="Carve"
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
