import pytest

from carve_api.auth.passwords import hash_password, verify_password
from carve_api.config import get_settings


@pytest.fixture(autouse=True)
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("POSTGRES_USER", "u")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    monkeypatch.setenv("POSTGRES_DB", "n")
    monkeypatch.setenv("JWT_SECRET", "j" * 64)
    monkeypatch.setenv("PASSWORD_PEPPER", "p" * 32)
    get_settings.cache_clear()


def test_hash_format() -> None:
    assert hash_password("hunter22").startswith("$argon2id$")


def test_verify_correct() -> None:
    h = hash_password("hunter22")
    assert verify_password("hunter22", h) is True


def test_verify_wrong() -> None:
    h = hash_password("hunter22")
    assert verify_password("nope", h) is False


def test_pepper_changes_hash(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PASSWORD_PEPPER", "a" * 32)
    get_settings.cache_clear()
    h1 = hash_password("same-pw")
    monkeypatch.setenv("PASSWORD_PEPPER", "b" * 32)
    get_settings.cache_clear()
    h2 = hash_password("same-pw")
    assert h1 != h2
