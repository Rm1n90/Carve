# Armin Mehri — mehri.armin@gmail.com
from datetime import UTC, datetime, timedelta
from typing import Literal

import jwt as pyjwt

from carve_api.config import get_settings

ALGORITHM = "HS256"
TokenType = Literal["access", "refresh"]


class InvalidToken(Exception):
    """Raised when a token cannot be decoded, has the wrong type, or is expired."""


def _now() -> datetime:
    return datetime.now(UTC)


def _encode(claims: dict) -> str:
    return pyjwt.encode(claims, get_settings().jwt_secret, algorithm=ALGORITHM)


def create_access_token(*, subject: str, role: str) -> str:
    s = get_settings()
    now = _now()
    return _encode(
        {
            "sub": subject,
            "role": role,
            "typ": "access",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(minutes=s.jwt_access_ttl_min)).timestamp()),
        }
    )


def create_refresh_token(*, subject: str, role: str) -> str:
    s = get_settings()
    now = _now()
    return _encode(
        {
            "sub": subject,
            "role": role,
            "typ": "refresh",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(days=s.jwt_refresh_ttl_days)).timestamp()),
        }
    )


def decode_token(token: str, *, expected_type: TokenType) -> dict:
    try:
        # leeway=1 mirrors python-jose's `now < exp` boundary (PyJWT uses `now <= exp`),
        # preserving behavior parity for tokens whose `exp` rounds to the current second.
        claims = pyjwt.decode(
            token, get_settings().jwt_secret, algorithms=[ALGORITHM], leeway=1
        )
    except pyjwt.PyJWTError as exc:
        raise InvalidToken(str(exc)) from exc
    if claims.get("typ") != expected_type:
        raise InvalidToken(f"expected {expected_type}, got {claims.get('typ')}")
    return claims
