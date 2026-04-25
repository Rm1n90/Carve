import pytest

from vaa_api.config import Settings, get_settings


def _base_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("POSTGRES_USER", "u")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    monkeypatch.setenv("POSTGRES_DB", "n")


def test_settings_load_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_env(monkeypatch)
    monkeypatch.setenv("POSTGRES_HOST", "db.example")
    monkeypatch.setenv("POSTGRES_PORT", "5433")
    monkeypatch.setenv("JWT_SECRET", "x" * 64)
    monkeypatch.setenv("PASSWORD_PEPPER", "y" * 32)
    get_settings.cache_clear()
    s = Settings()
    assert s.database_url.startswith("postgresql+psycopg://u:p@db.example:5433/n")


def test_settings_rejects_short_jwt_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_env(monkeypatch)
    monkeypatch.setenv("JWT_SECRET", "short")
    monkeypatch.setenv("PASSWORD_PEPPER", "y" * 32)
    get_settings.cache_clear()
    with pytest.raises(ValueError):
        Settings()
