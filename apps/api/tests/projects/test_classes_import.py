"""v3.0 Bug 8 — cross-project class import endpoint.

Covers:
  - happy path: classes copied with new idx ordering
  - name collision: existing names skipped, others imported
  - source project missing → 404
  - destination project missing → 404
"""
import uuid

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


def _hdr(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def _setup(client, email: str = "ic@x.com") -> tuple[str, str, str]:
    """Register a user and create two projects: source + destination.

    Returns (source_project_id, dest_project_id, token).
    """
    client.post("/auth/register", json={"email": email, "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": email, "password": "hunter22"}
    ).json()["access_token"]
    src = client.post("/projects", json={"name": "Src"}, headers=_hdr(token)).json()[
        "id"
    ]
    dst = client.post("/projects", json={"name": "Dst"}, headers=_hdr(token)).json()[
        "id"
    ]
    return src, dst, token


def test_import_classes_happy_path(db_session) -> None:
    client = _client(db_session)
    src, dst, token = _setup(client)
    # Seed source with 3 classes.
    for i, (name, color) in enumerate(
        [("car", "#ff0000"), ("person", "#00ff00"), ("bike", "#0000ff")]
    ):
        r = client.post(
            f"/projects/{src}/classes",
            json={"idx": i, "name": name, "color": color},
            headers=_hdr(token),
        )
        assert r.status_code == 201, r.text

    r = client.post(
        f"/projects/{dst}/classes/import",
        json={"source_project_id": src},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    assert r.json() == {"imported": 3, "skipped": 0}

    # Verify destination now has all 3 classes with idx starting at 0.
    rows = client.get(f"/projects/{dst}/classes", headers=_hdr(token)).json()
    assert {c["name"] for c in rows} == {"car", "person", "bike"}
    assert [c["idx"] for c in rows] == [0, 1, 2]


def test_import_classes_skips_name_collisions(db_session) -> None:
    client = _client(db_session)
    src, dst, token = _setup(client, email="ic2@x.com")
    # Both projects already have a "car" class — destination should keep its.
    client.post(
        f"/projects/{src}/classes",
        json={"idx": 0, "name": "car", "color": "#ff0000"},
        headers=_hdr(token),
    )
    client.post(
        f"/projects/{src}/classes",
        json={"idx": 1, "name": "person", "color": "#00ff00"},
        headers=_hdr(token),
    )
    client.post(
        f"/projects/{dst}/classes",
        json={"idx": 0, "name": "car", "color": "#abcdef"},
        headers=_hdr(token),
    )

    r = client.post(
        f"/projects/{dst}/classes/import",
        json={"source_project_id": src},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    assert r.json() == {"imported": 1, "skipped": 1}

    rows = client.get(f"/projects/{dst}/classes", headers=_hdr(token)).json()
    # Existing car keeps its color; person is appended at next idx.
    by_name = {c["name"]: c for c in rows}
    assert by_name["car"]["color"] == "#abcdef"
    assert by_name["person"]["idx"] == 1


def test_import_classes_source_not_found_404(db_session) -> None:
    client = _client(db_session)
    _, dst, token = _setup(client, email="ic3@x.com")
    r = client.post(
        f"/projects/{dst}/classes/import",
        json={"source_project_id": str(uuid.uuid4())},
        headers=_hdr(token),
    )
    assert r.status_code == 404


def test_import_classes_dest_not_found_404(db_session) -> None:
    client = _client(db_session)
    src, _, token = _setup(client, email="ic4@x.com")
    r = client.post(
        f"/projects/{uuid.uuid4()}/classes/import",
        json={"source_project_id": src},
        headers=_hdr(token),
    )
    assert r.status_code == 404
