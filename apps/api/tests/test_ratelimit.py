from fastapi.testclient import TestClient

from vaa_api.deps import get_db
from vaa_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def test_login_rate_limit_returns_429_after_10(db_session) -> None:
    # Arrange
    client = _client(db_session)

    # Act: 10 calls within the limit (slowapi counts every call regardless of status)
    for _ in range(10):
        r = client.post(
            "/auth/login", json={"email": "rl@example.com", "password": "wrong"}
        )
        assert r.status_code != 429

    # Assert: the 11th call must be rate-limited with the canonical body
    r11 = client.post(
        "/auth/login", json={"email": "rl@example.com", "password": "wrong"}
    )
    assert r11.status_code == 429
    assert r11.json() == {"error": "rate_limited"}


def test_register_rate_limit_returns_429_after_5(db_session) -> None:
    # Arrange
    client = _client(db_session)

    # Act: 5 calls within the limit (some may 4xx; slowapi counts them anyway)
    for i in range(5):
        r = client.post(
            "/auth/register",
            json={"email": f"reg{i}@example.com", "password": "hunter22"},
        )
        assert r.status_code != 429

    # Assert: the 6th call must be rate-limited
    r6 = client.post(
        "/auth/register",
        json={"email": "reg-last@example.com", "password": "hunter22"},
    )
    assert r6.status_code == 429
    assert r6.json() == {"error": "rate_limited"}


def test_rate_limit_resets_per_test(db_session) -> None:
    # If the autouse _reset_limiter fixture is wired correctly, this test starts
    # with a fresh limiter even though previous tests already exhausted /auth/login.
    client = _client(db_session)
    r = client.post(
        "/auth/login", json={"email": "fresh@example.com", "password": "wrong"}
    )
    assert r.status_code != 429
