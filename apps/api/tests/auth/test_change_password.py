"""Audit Bug 16 — self-service password change at ``POST /auth/password``.

Covers:
- Successful change (204) and a follow-up login with the new password works.
- Wrong current password → 401 with ``current_password_wrong``.
- New password shorter than 8 chars → 422 (Pydantic validation).
- Missing/invalid bearer token → 401.
- Sixth call within a minute → 429 (limiter is 5/minute and is reset per test
  by the ``_reset_limiter`` fixture in conftest).
"""

from __future__ import annotations

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


def _register_and_login(client: TestClient, email: str, password: str) -> str:
    """Register a fresh user and return the access token."""
    client.post("/auth/register", json={"email": email, "password": password})
    r = client.post("/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def test_change_password_success(db_session) -> None:
    # Arrange
    client = _client(db_session)
    token = _register_and_login(client, "cp1@example.com", "oldpass1")

    # Act
    r = client.post(
        "/auth/password",
        json={"current_password": "oldpass1", "new_password": "newpass1"},
        headers={"Authorization": f"Bearer {token}"},
    )

    # Assert
    assert r.status_code == 204, r.text
    # Old password no longer works
    bad = client.post(
        "/auth/login", json={"email": "cp1@example.com", "password": "oldpass1"}
    )
    assert bad.status_code == 401
    # New password works
    good = client.post(
        "/auth/login", json={"email": "cp1@example.com", "password": "newpass1"}
    )
    assert good.status_code == 200


def test_change_password_wrong_current_returns_401(db_session) -> None:
    # Arrange
    client = _client(db_session)
    token = _register_and_login(client, "cp2@example.com", "oldpass1")

    # Act
    r = client.post(
        "/auth/password",
        json={"current_password": "WRONG", "new_password": "newpass1"},
        headers={"Authorization": f"Bearer {token}"},
    )

    # Assert
    assert r.status_code == 401
    assert r.json()["detail"] == "current_password_wrong"


def test_change_password_short_new_returns_422(db_session) -> None:
    # Arrange
    client = _client(db_session)
    token = _register_and_login(client, "cp3@example.com", "oldpass1")

    # Act — Pydantic rejects new_password < 8 chars before the handler runs.
    r = client.post(
        "/auth/password",
        json={"current_password": "oldpass1", "new_password": "short"},
        headers={"Authorization": f"Bearer {token}"},
    )

    # Assert
    assert r.status_code == 422


def test_change_password_unauthenticated_returns_401(db_session) -> None:
    # Arrange
    client = _client(db_session)

    # Act
    r = client.post(
        "/auth/password",
        json={"current_password": "anything", "new_password": "newpass1"},
    )

    # Assert
    assert r.status_code == 401


def test_change_password_rate_limit_returns_429_after_5(db_session) -> None:
    """The limiter is set to 5/minute. The 6th call must be rejected with
    the v2.6 rate-limit envelope (see test_ratelimit.py)."""
    # Arrange
    client = _client(db_session)
    token = _register_and_login(client, "cp4@example.com", "oldpass1")
    headers = {"Authorization": f"Bearer {token}"}

    # Act: 5 calls (each will 401 with current_password_wrong, but slowapi
    # still counts them against the bucket).
    for _ in range(5):
        r = client.post(
            "/auth/password",
            json={"current_password": "WRONG", "new_password": "newpass1"},
            headers=headers,
        )
        assert r.status_code != 429

    # Assert: the 6th call is rate-limited
    r6 = client.post(
        "/auth/password",
        json={"current_password": "WRONG", "new_password": "newpass1"},
        headers=headers,
    )
    assert r6.status_code == 429
    body = r6.json()
    assert body["error"] == "rate_limited"
    assert isinstance(body["retry_after_seconds"], int)
    assert r6.headers.get("Retry-After") == str(body["retry_after_seconds"])
