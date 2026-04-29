"""v3.1 Bug 6 — singleton workspace endpoints.

Covers ``GET /workspace`` and ``PATCH /workspace``:

- GET (any authed user) returns the singleton fields incl. members_count
- PATCH name (admin) -> 200, persists across reads
- PATCH description (admin) -> 200, persists
- PATCH as member (non-admin) -> 403
- Unauthenticated GET/PATCH -> 401

The migration seeds the singleton row on real Postgres deployments. The
test schema uses ``Base.metadata.create_all`` (see ``conftest.engine``)
which doesn't run migrations, so each test seeds the row directly via
the ORM before exercising the endpoint.
"""
from fastapi.testclient import TestClient

from carve_api.auth.models import User
from carve_api.deps import get_db
from carve_api.main import create_app
from carve_api.workspace.models import Workspace


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _reset(db_session) -> None:
    db_session.query(Workspace).delete()
    db_session.query(User).delete()
    db_session.flush()
    # Seed the singleton — the migration handles this in prod, but the
    # in-test schema is built from Base.metadata.create_all which doesn't
    # execute the data-seeding step.
    db_session.add(Workspace(name="Carve"))
    db_session.flush()


def _bootstrap_admin(client: TestClient) -> str:
    client.post(
        "/auth/register",
        json={"email": "admin@x.com", "password": "hunter22"},
    )
    return client.post(
        "/auth/login",
        json={"email": "admin@x.com", "password": "hunter22"},
    ).json()["access_token"]


def _create_member(client: TestClient, admin_token: str, email: str) -> str:
    client.post(
        "/auth/members",
        json={"email": email, "password": "hunter22", "role": "member"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    return client.post(
        "/auth/login",
        json={"email": email, "password": "hunter22"},
    ).json()["access_token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ------------------------------- GET ---------------------------------


def test_get_returns_singleton_fields(db_session) -> None:
    _reset(db_session)
    client = _client(db_session)
    admin = _bootstrap_admin(client)

    r = client.get("/workspace", headers=_auth(admin))
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body.keys()) >= {
        "id",
        "name",
        "description",
        "created_at",
        "updated_at",
        "members_count",
    }
    assert body["name"] == "Carve"
    assert body["description"] is None
    # Bootstrapping the admin counts as one active member.
    assert body["members_count"] == 1


def test_get_unauthenticated_returns_401(db_session) -> None:
    _reset(db_session)
    client = _client(db_session)

    r = client.get("/workspace")
    assert r.status_code == 401


# ------------------------------- PATCH -------------------------------


def test_patch_name_persists(db_session) -> None:
    _reset(db_session)
    client = _client(db_session)
    admin = _bootstrap_admin(client)

    r = client.patch(
        "/workspace", json={"name": "Acme Labs"}, headers=_auth(admin)
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Acme Labs"

    # Round-trip through GET to confirm persistence.
    again = client.get("/workspace", headers=_auth(admin)).json()
    assert again["name"] == "Acme Labs"


def test_patch_description_persists(db_session) -> None:
    _reset(db_session)
    client = _client(db_session)
    admin = _bootstrap_admin(client)

    r = client.patch(
        "/workspace",
        json={"description": "Annotation lab for satellite imagery."},
        headers=_auth(admin),
    )
    assert r.status_code == 200
    assert (
        r.json()["description"] == "Annotation lab for satellite imagery."
    )


def test_patch_member_forbidden(db_session) -> None:
    _reset(db_session)
    client = _client(db_session)
    admin = _bootstrap_admin(client)
    member_token = _create_member(client, admin, "member@x.com")

    r = client.patch(
        "/workspace", json={"name": "Hacked"}, headers=_auth(member_token)
    )
    assert r.status_code == 403


def test_patch_unauthenticated_returns_401(db_session) -> None:
    _reset(db_session)
    client = _client(db_session)

    r = client.patch("/workspace", json={"name": "Anon"})
    assert r.status_code == 401


def test_patch_rejects_empty_name(db_session) -> None:
    """Singleton invariant: name must always be non-empty."""
    _reset(db_session)
    client = _client(db_session)
    admin = _bootstrap_admin(client)

    r = client.patch(
        "/workspace", json={"name": ""}, headers=_auth(admin)
    )
    # Pydantic v2 surfaces min_length violations as 422 by default.
    assert r.status_code == 422


def test_patch_rejects_oversized_name(db_session) -> None:
    _reset(db_session)
    client = _client(db_session)
    admin = _bootstrap_admin(client)

    r = client.patch(
        "/workspace",
        json={"name": "x" * 121},
        headers=_auth(admin),
    )
    assert r.status_code == 422
