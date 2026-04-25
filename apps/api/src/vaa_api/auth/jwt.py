from datetime import UTC, datetime, timedelta
from typing import Literal

from jose import JWTError, jwt

from vaa_api.config import get_settings

ALGORITHM = "HS256"
TokenType = Literal["access", "refresh"]


class InvalidToken(Exception):
    """Raised when a token cannot be decoded, has the wrong type, or is expired."""


def _now() -> datetime:
    return datetime.now(UTC)


def create_access_token(*, subject: str, role: str) -> str:
    s = get_settings()
    now = _now()
    claims = {
        "sub": subject,
        "role": role,
        "typ": "access",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=s.jwt_access_ttl_min)).timestamp()),
    }
    return jwt.encode(claims, s.jwt_secret, algorithm=ALGORITHM)


def create_refresh_token(*, subject: str, role: str) -> str:
    s = get_settings()
    now = _now()
    claims = {
        "sub": subject,
        "role": role,
        "typ": "refresh",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=s.jwt_refresh_ttl_days)).timestamp()),
    }
    return jwt.encode(claims, s.jwt_secret, algorithm=ALGORITHM)


def decode_token(token: str, *, expected_type: TokenType) -> dict:
    try:
        claims = jwt.decode(token, get_settings().jwt_secret, algorithms=[ALGORITHM])
    except JWTError as exc:
        raise InvalidToken(str(exc)) from exc
    if claims.get("typ") != expected_type:
        raise InvalidToken(f"expected {expected_type}, got {claims.get('typ')}")
    return claims
