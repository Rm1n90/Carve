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


def _bootstrap(client) -> str:
    """Register a bootstrap admin and return the access token."""
    client.post(
        "/auth/register",
        json={"email": "owner@example.com", "password": "hunter22"},
    )
    return client.post(
        "/auth/login",
        json={"email": "owner@example.com", "password": "hunter22"},
    ).json()["access_token"]


def test_create_api_key_returns_token_once(db_session) -> None:
    client = _client(db_session)
    token = _bootstrap(client)

    r = client.post(
        "/auth/api-keys",
        json={"name": "ci"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "ci"
    assert body["token"].startswith("ck_")
    assert body["prefix"] == body["token"][:12]
    assert body["revoked_at"] is None

    # Listing must NOT include the raw token.
    listed = client.get(
        "/auth/api-keys",
        headers={"Authorization": f"Bearer {token}"},
    ).json()
    assert len(listed) == 1
    assert "token" not in listed[0]
    assert listed[0]["prefix"] == body["prefix"]


def test_api_key_authenticates_subsequent_request(db_session) -> None:
    client = _client(db_session)
    token = _bootstrap(client)

    raw = client.post(
        "/auth/api-keys",
        json={"name": "agent"},
        headers={"Authorization": f"Bearer {token}"},
    ).json()["token"]

    # Use the api key (not the JWT) to hit /auth/me.
    r = client.get("/auth/me", headers={"Authorization": f"Bearer {raw}"})
    assert r.status_code == 200
    assert r.json()["email"] == "owner@example.com"


def test_revoked_api_key_is_rejected(db_session) -> None:
    client = _client(db_session)
    token = _bootstrap(client)

    created = client.post(
        "/auth/api-keys",
        json={"name": "ci"},
        headers={"Authorization": f"Bearer {token}"},
    ).json()
    raw = created["token"]
    key_id = created["id"]

    # Revoke
    r = client.delete(
        f"/auth/api-keys/{key_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 204

    # Re-fetch listing — revoked_at populated.
    listed = client.get(
        "/auth/api-keys",
        headers={"Authorization": f"Bearer {token}"},
    ).json()
    assert listed[0]["revoked_at"] is not None

    # The raw token should now fail auth.
    r2 = client.get("/auth/me", headers={"Authorization": f"Bearer {raw}"})
    assert r2.status_code == 401


def test_garbage_ck_token_rejected(db_session) -> None:
    client = _client(db_session)
    r = client.get(
        "/auth/me",
        headers={"Authorization": "Bearer ck_definitely_not_a_real_token_xyz"},
    )
    assert r.status_code == 401


def test_other_user_cannot_revoke_my_key(db_session) -> None:
    client = _client(db_session)
    admin_token = _bootstrap(client)

    # Admin creates a second user.
    client.post(
        "/auth/register",
        json={"email": "other@example.com", "password": "hunter22"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    other_token = client.post(
        "/auth/login",
        json={"email": "other@example.com", "password": "hunter22"},
    ).json()["access_token"]

    created = client.post(
        "/auth/api-keys",
        json={"name": "owners"},
        headers={"Authorization": f"Bearer {admin_token}"},
    ).json()

    r = client.delete(
        f"/auth/api-keys/{created['id']}",
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert r.status_code == 404
