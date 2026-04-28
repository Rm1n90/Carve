from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _assert_rate_limited_envelope(response) -> None:
    """v2.6: 429 body now carries retry_after_seconds + detail and a
    Retry-After header so clients can back off intelligently."""
    assert response.status_code == 429
    body = response.json()
    assert body["error"] == "rate_limited"
    assert isinstance(body["retry_after_seconds"], int)
    assert body["retry_after_seconds"] >= 1
    assert "detail" in body and "Slow down" in body["detail"]
    assert response.headers.get("Retry-After") == str(body["retry_after_seconds"])


def test_login_rate_limit_returns_429_after_10(db_session) -> None:
    # Arrange
    client = _client(db_session)

    # Act: 10 calls within the limit (slowapi counts every call regardless of status)
    for _ in range(10):
        r = client.post(
            "/auth/login", json={"email": "rl@example.com", "password": "wrong"}
        )
        assert r.status_code != 429

    # Assert: the 11th call must be rate-limited with the v2.6 envelope
    r11 = client.post(
        "/auth/login", json={"email": "rl@example.com", "password": "wrong"}
    )
    _assert_rate_limited_envelope(r11)


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
    _assert_rate_limited_envelope(r6)


def test_rate_limit_resets_per_test(db_session) -> None:
    # If the autouse _reset_limiter fixture is wired correctly, this test starts
    # with a fresh limiter even though previous tests already exhausted /auth/login.
    client = _client(db_session)
    r = client.post(
        "/auth/login", json={"email": "fresh@example.com", "password": "wrong"}
    )
    assert r.status_code != 429


def test_asset_upload_limit_constant_is_1000_per_minute() -> None:
    """v2.6: the single-asset POST /tasks/{tid}/assets endpoint was
    raised from 100/minute to 1000/minute so authenticated users can
    drop a normal batch of a few hundred images without hitting a 429
    mid-loop. Hitting the cap with 1001 real requests in a unit test
    would be slow and flaky, so we assert the constant the decorator
    consumes — the integration with the limiter is exercised by the
    auth tests above (which use the same code path)."""
    # Arrange / Act: read the module-level constant the decorator uses.
    from carve_api.assets.router import SINGLE_ASSET_UPLOAD_LIMIT

    # Assert
    assert SINGLE_ASSET_UPLOAD_LIMIT == "1000/minute"
