import time

import pytest

from vaa_api.auth.jwt import (
    InvalidToken,
    create_access_token,
    create_refresh_token,
    decode_token,
)
from vaa_api.config import get_settings


@pytest.fixture(autouse=True)
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("POSTGRES_USER", "u")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    monkeypatch.setenv("POSTGRES_DB", "n")
    monkeypatch.setenv("JWT_SECRET", "j" * 64)
    monkeypatch.setenv("PASSWORD_PEPPER", "p" * 32)
    get_settings.cache_clear()


def test_access_round_trip() -> None:
    t = create_access_token(subject="u-1", role="admin")
    c = decode_token(t, expected_type="access")
    assert c["sub"] == "u-1"
    assert c["role"] == "admin"
    assert c["typ"] == "access"


def test_refresh_round_trip() -> None:
    t = create_refresh_token(subject="u-2", role="member")
    c = decode_token(t, expected_type="refresh")
    assert c["typ"] == "refresh"


def test_wrong_type_rejected() -> None:
    t = create_access_token(subject="x", role="member")
    with pytest.raises(InvalidToken):
        decode_token(t, expected_type="refresh")


def test_tampered_rejected() -> None:
    t = create_access_token(subject="x", role="member")
    bad = t[:-2] + ("aa" if not t.endswith("aa") else "bb")
    with pytest.raises(InvalidToken):
        decode_token(bad, expected_type="access")


def test_expired_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JWT_ACCESS_TTL_MIN", "0")
    get_settings.cache_clear()
    t = create_access_token(subject="x", role="member")
    time.sleep(1)
    with pytest.raises(InvalidToken):
        decode_token(t, expected_type="access")
