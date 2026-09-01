# Armin Mehri — mehri.armin@gmail.com
import uuid
from collections.abc import Iterator
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from carve_api.auth.jwt import InvalidToken, decode_token
from carve_api.auth.models import ADMIN_LEVEL_ROLES, User, UserRole
from carve_api.db import db_session


def get_db() -> Iterator[Session]:
    yield from db_session()


def _bearer_token(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return authorization.split(" ", 1)[1].strip()


def get_current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    token = _bearer_token(authorization)
    # Personal access tokens (ck_<...>) are validated against the api_keys
    # table. Imported lazily so a missing api_keys table at import time (e.g.
    # legacy migrations in early test bootstraps) does not break the JWT path.
    from carve_api.api_keys.service import TOKEN_PREFIX, ApiKeyService

    if token.startswith(TOKEN_PREFIX):
        user = ApiKeyService(db).authenticate(raw_token=token)
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid api key",
                headers={"WWW-Authenticate": "Bearer"},
            )
        # A blocked account loses its personal access tokens too —
        # otherwise blocking would only stop the browser session.
        _reject_if_blocked(user)
        return user
    try:
        claims = decode_token(token, expected_type="access")
    except InvalidToken as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    user = db.get(User, claims["sub"])
    # Bug 14: soft-deleted users must not be able to use an existing JWT.
    if user is None or user.deleted_at is not None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="user not found")
    _reject_if_blocked(user)
    _reject_if_session_revoked(user, claims)
    return user


def _reject_if_blocked(user: User) -> None:
    """Refuse a blocked account.

    Checked on every authenticated request rather than only at login, so
    a superadmin blocking someone takes effect on that person's very next
    request instead of whenever their token happens to expire.
    """
    if user.blocked_at is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "account_blocked",
                "message": (
                    "This account has been blocked. Contact your workspace "
                    "administrator."
                ),
                "reason": user.blocked_reason,
            },
        )


def _reject_if_session_revoked(user: User, claims: dict) -> None:
    """Enforce "force logout" for tokens issued before the cutoff.

    JWTs are stateless, so revocation is a timestamp comparison rather
    than a deny-list: ``sessions_valid_from`` is bumped when a superadmin
    resets the password or explicitly revokes sessions, and every token
    minted earlier is refused from that moment on.

    A token with no ``iat`` (only possible for one hand-minted in a
    test) is treated as pre-cutoff, i.e. refused — failing closed.
    """
    cutoff = user.sessions_valid_from
    if cutoff is None:
        return
    iat = claims.get("iat")
    if iat is None or datetime.fromtimestamp(int(iat), tz=timezone.utc) < cutoff:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="session_revoked",
            headers={"WWW-Authenticate": "Bearer"},
        )


def require_role(*roles: UserRole):
    def _checker(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")
        return user

    return _checker


def get_current_admin_user(user: User = Depends(get_current_user)) -> User:
    """Convenience wrapper around ``require_role(UserRole.admin)`` for the
    new admin-only member CRUD endpoints (Bug 14)."""
    if user.role not in ADMIN_LEVEL_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")
    return user


def get_origin_session(
    x_origin_session: str | None = Header(default=None, alias="X-Origin-Session"),
) -> uuid.UUID | None:
    """Parse the realtime origin-session header for echo suppression.

    Mutating REST routes accept an optional ``X-Origin-Session`` header
    carrying the calling tab's WebSocket session UUID. The annotations
    router stamps it on the broadcast envelope so the *originating*
    WebSocket can skip its own echo (the local store already applied
    the mutation optimistically).

    Returns ``None`` for missing or malformed headers — realtime is an
    enhancement, not a hard requirement, so non-WS clients (CLI tools,
    server-to-server jobs, older browsers without realtime support)
    keep working.
    """
    if not x_origin_session:
        return None
    try:
        return uuid.UUID(x_origin_session)
    except (ValueError, AttributeError):
        return None
