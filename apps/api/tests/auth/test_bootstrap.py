from fastapi.testclient import TestClient

from carve_api.auth.models import User
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


def _login(client: TestClient, email: str, password: str) -> dict:
    return client.post("/auth/login", json={"email": email, "password": password}).json()


def test_bootstrap_status_initially_false(db_session) -> None:
    # Arrange: clean users table
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)

    # Act
    r = client.get("/auth/bootstrap-status")

    # Assert
    assert r.status_code == 200, r.text
    assert r.json() == {"users_exist": False}


def test_register_allows_first_user_without_auth_and_creates_admin(db_session) -> None:
    # Arrange: clean users table
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)

    # Act
    r = client.post(
        "/auth/register",
        json={"email": "first@example.com", "password": "hunter22"},
    )

    # Assert
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["email"] == "first@example.com"
    assert body["role"] == "admin"


def test_bootstrap_status_true_after_first_user(db_session) -> None:
    # Arrange: clean and seed one user
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    client.post(
        "/auth/register",
        json={"email": "first@example.com", "password": "hunter22"},
    )

    # Act
    r = client.get("/auth/bootstrap-status")

    # Assert
    assert r.status_code == 200, r.text
    assert r.json() == {"users_exist": True}


def test_register_after_bootstrap_without_auth_returns_401(db_session) -> None:
    # Arrange: existing admin
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    client.post(
        "/auth/register",
        json={"email": "admin@example.com", "password": "hunter22"},
    )

    # Act: second register without auth
    r = client.post(
        "/auth/register",
        json={"email": "second@example.com", "password": "hunter22"},
    )

    # Assert
    assert r.status_code == 401
    assert r.json() == {"error": "bootstrapped_admin_only"}


def test_register_after_bootstrap_with_member_token_returns_403(db_session) -> None:
    # Arrange: clean DB; bootstrap admin via the public path, then create a
    # member through the admin-token path (the only way to create members
    # post-bootstrap). Using HTTP-driven seeding keeps the data alive past the
    # _override's per-request rollback (each route commits its work).
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    client.post(
        "/auth/register",
        json={"email": "admin@x.com", "password": "hunter22"},
    )
    admin_tokens = _login(client, "admin@x.com", "hunter22")
    client.post(
        "/auth/register",
        json={"email": "member@x.com", "password": "hunter22"},
        headers={"Authorization": f"Bearer {admin_tokens['access_token']}"},
    )

    member_tokens = _login(client, "member@x.com", "hunter22")
    assert "access_token" in member_tokens, member_tokens

    # Act: member tries to register a third user
    r = client.post(
        "/auth/register",
        json={"email": "third@example.com", "password": "hunter22"},
        headers={"Authorization": f"Bearer {member_tokens['access_token']}"},
    )

    # Assert
    assert r.status_code == 403
    assert r.json() == {"error": "bootstrapped_admin_only"}


def test_register_with_admin_token_creates_member(db_session) -> None:
    # Arrange: existing admin
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    client.post(
        "/auth/register",
        json={"email": "admin2@example.com", "password": "hunter22"},
    )
    tokens = _login(client, "admin2@example.com", "hunter22")
    assert "access_token" in tokens, tokens

    # Act: admin registers a member
    r = client.post(
        "/auth/register",
        json={"email": "member2@example.com", "password": "hunter22"},
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
    )

    # Assert
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["email"] == "member2@example.com"
    assert body["role"] == "member"
