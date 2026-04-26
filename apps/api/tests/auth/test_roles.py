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


def _login(client, email: str, password: str) -> dict:
    return client.post("/auth/login", json={"email": email, "password": password}).json()


def test_admin_only_allows_admin(db_session) -> None:
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    client.post("/auth/register", json={"email": "boss@x.com", "password": "hunter22"})
    tokens = _login(client, "boss@x.com", "hunter22")
    r = client.get("/admin/ping", headers={"Authorization": f"Bearer {tokens['access_token']}"})
    assert r.status_code == 200


def test_admin_only_rejects_member(db_session) -> None:
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    client.post("/auth/register", json={"email": "boss2@x.com", "password": "hunter22"})
    boss_tokens = _login(client, "boss2@x.com", "hunter22")
    # Member registration requires an admin token after bootstrap.
    client.post(
        "/auth/register",
        json={"email": "staff@x.com", "password": "hunter22"},
        headers={"Authorization": f"Bearer {boss_tokens['access_token']}"},
    )
    tokens = _login(client, "staff@x.com", "hunter22")
    r = client.get("/admin/ping", headers={"Authorization": f"Bearer {tokens['access_token']}"})
    assert r.status_code == 403
