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


def test_login_returns_token_pair(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "lg@example.com", "password": "hunter22"})
    r = client.post("/auth/login", json={"email": "lg@example.com", "password": "hunter22"})
    assert r.status_code == 200
    body = r.json()
    assert body["access_token"]
    assert body["refresh_token"]
    assert body["token_type"] == "Bearer"


def test_login_wrong_password(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "lg2@example.com", "password": "hunter22"})
    r = client.post("/auth/login", json={"email": "lg2@example.com", "password": "wrong"})
    assert r.status_code == 401


def test_me_requires_token() -> None:
    client = TestClient(create_app())
    r = client.get("/auth/me")
    assert r.status_code == 401


def test_me_with_token(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "me@example.com", "password": "hunter22"})
    login = client.post(
        "/auth/login", json={"email": "me@example.com", "password": "hunter22"}
    ).json()
    r = client.get("/auth/me", headers={"Authorization": f"Bearer {login['access_token']}"})
    assert r.status_code == 200
    assert r.json()["email"] == "me@example.com"
