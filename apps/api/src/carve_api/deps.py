from collections.abc import Iterator

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from carve_api.auth.jwt import InvalidToken, decode_token
from carve_api.auth.models import User, UserRole
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
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="user not found")
    return user


def require_role(*roles: UserRole):
    def _checker(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")
        return user

    return _checker
