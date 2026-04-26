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


def test_refresh_issues_new_access(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "rf@example.com", "password": "hunter22"})
    login = client.post(
        "/auth/login", json={"email": "rf@example.com", "password": "hunter22"}
    ).json()
    r = client.post("/auth/refresh", json={"refresh_token": login["refresh_token"]})
    assert r.status_code == 200
    assert r.json()["access_token"]


def test_refresh_rejects_access_token(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "rf2@example.com", "password": "hunter22"})
    login = client.post(
        "/auth/login", json={"email": "rf2@example.com", "password": "hunter22"}
    ).json()
    r = client.post("/auth/refresh", json={"refresh_token": login["access_token"]})
    assert r.status_code == 401
