# Armin Mehri — mehri.armin@gmail.com
import secrets
import uuid
from datetime import datetime, timezone
from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.api_keys.models import ApiKey
from carve_api.auth.models import User
from carve_api.auth.passwords import hash_password, verify_password
from carve_api.errors import AppError


class ApiKeyNotFound(AppError):
    http_status = 404
    code = "api_key_not_found"


class ApiKeyForbidden(AppError):
    http_status = 403
    code = "api_key_forbidden"


# Plain-text tokens look like "ck_<32 url-safe bytes>" so the prefix on
# its own ("ck_xxxxxxxx") is sufficient for the bearer-token path to
# disambiguate API-key auth from JWT (JWTs always begin with "ey").
TOKEN_PREFIX = "ck_"
PREFIX_LENGTH = 12  # "ck_" + 9 chars


class CreatedKey(NamedTuple):
    key: ApiKey
    raw_token: str


class ApiKeyService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def create(self, *, user: User, name: str) -> CreatedKey:
        raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
        prefix = raw[:PREFIX_LENGTH]
        k = ApiKey(
            user_id=user.id,
            name=name,
            hashed_token=hash_password(raw),
            prefix=prefix,
        )
        self.session.add(k)
        self.session.flush()
        return CreatedKey(key=k, raw_token=raw)

    def list_for_user(self, *, user: User) -> list[ApiKey]:
        return list(
            self.session.execute(
                select(ApiKey)
                .where(ApiKey.user_id == user.id)
                .order_by(ApiKey.created_at.desc())
            ).scalars()
        )

    def revoke(self, *, user: User, key_id: uuid.UUID) -> ApiKey:
        k = self.session.get(ApiKey, key_id)
        if k is None or k.user_id != user.id:
            raise ApiKeyNotFound("api key not found")
        if k.revoked_at is None:
            k.revoked_at = datetime.now(timezone.utc)
            self.session.flush()
        return k

    def authenticate(self, *, raw_token: str) -> User | None:
        """Look up the user that owns this raw token, or return None.

        Strategy: filter by prefix (indexed) to reduce the candidate set,
        then verify the argon2 hash. We touch ``last_used_at`` on success.
        """
        if not raw_token.startswith(TOKEN_PREFIX):
            return None
        prefix = raw_token[:PREFIX_LENGTH]
        candidates = list(
            self.session.execute(
                select(ApiKey).where(
                    ApiKey.prefix == prefix, ApiKey.revoked_at.is_(None)
                )
            ).scalars()
        )
        for k in candidates:
            if verify_password(raw_token, k.hashed_token):
                k.last_used_at = datetime.now(timezone.utc)
                self.session.flush()
                # Bug 14: soft-deleted users must not authenticate via PAT.
                user = self.session.get(User, k.user_id)
                if user is None or user.deleted_at is not None:
                    return None
                return user
        return None
