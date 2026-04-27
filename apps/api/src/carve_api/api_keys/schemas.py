from datetime import datetime

from pydantic import BaseModel, Field


class ApiKeyCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class ApiKeyOut(BaseModel):
    """Listing form. Never includes the raw token."""

    id: str
    name: str
    prefix: str
    created_at: datetime
    last_used_at: datetime | None
    revoked_at: datetime | None

    @classmethod
    def from_orm_key(cls, k) -> "ApiKeyOut":
        return cls(
            id=str(k.id),
            name=k.name,
            prefix=k.prefix,
            created_at=k.created_at,
            last_used_at=k.last_used_at,
            revoked_at=k.revoked_at,
        )


class ApiKeyCreatedOut(ApiKeyOut):
    """One-time response that includes the raw token. Returned only from POST."""

    token: str
