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


def test_register_returns_user(db_session) -> None:
    client = _client(db_session)
    r = client.post(
        "/auth/register", json={"email": "u1@example.com", "password": "hunter22"}
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["email"] == "u1@example.com"
    assert body["role"] in {"admin", "member"}


def test_register_short_password() -> None:
    from vaa_api.main import create_app
    client = TestClient(create_app())
    r = client.post(
        "/auth/register", json={"email": "u2@example.com", "password": "short"}
    )
    assert r.status_code == 422


def test_register_duplicate(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "u3@example.com", "password": "hunter22"})
    r = client.post(
        "/auth/register", json={"email": "u3@example.com", "password": "hunter22"}
    )
    assert r.status_code == 409
    assert r.json()["error"] == "email_taken"
