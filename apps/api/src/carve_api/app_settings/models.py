# Armin Mehri — mehri.armin@gmail.com
"""One row per setting saved in the app (alembic 0048)."""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from carve_api.db import Base


class AppSetting(Base):
    __tablename__ = "app_settings"

    # The environment variable the value stands in for, e.g. OPENAI_API_KEY.
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    # JSON for plain values; a Fernet token when ``encrypted``.
    value: Mapped[str] = mapped_column(Text, nullable=False)
    encrypted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
