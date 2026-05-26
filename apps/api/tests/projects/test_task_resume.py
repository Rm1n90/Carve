import uuid
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from carve_api.projects.schemas import TaskResumeStatus


def test_resume_schema_accepts_populated_payload() -> None:
    asset_id = uuid.uuid4()
    frame_id = uuid.uuid4()
    ts = datetime(2026, 5, 26, 16, 4, tzinfo=timezone.utc)
    s = TaskResumeStatus(
        last_asset_id=asset_id,
        last_frame_id=frame_id,
        annotated_assets=350,
        total_assets=1000,
        last_activity_at=ts,
    )
    assert s.last_asset_id == asset_id
    assert s.annotated_assets == 350


def test_resume_schema_accepts_empty_payload() -> None:
    s = TaskResumeStatus(
        last_asset_id=None,
        last_frame_id=None,
        annotated_assets=0,
        total_assets=0,
        last_activity_at=None,
    )
    assert s.last_asset_id is None
    assert s.last_activity_at is None


def test_resume_schema_rejects_negative_counts() -> None:
    with pytest.raises(ValidationError):
        TaskResumeStatus(
            last_asset_id=None,
            last_frame_id=None,
            annotated_assets=-1,
            total_assets=10,
            last_activity_at=None,
        )


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


def _register_and_login(client, email: str) -> str:
    client.post("/auth/register", json={"email": email, "password": "hunter22"})
    return client.post(
        "/auth/login", json={"email": email, "password": "hunter22"}
    ).json()["access_token"]


def _hdr(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def test_resume_returns_empty_payload_when_no_annotations(db_session) -> None:
    client = _client(db_session)
    token = _register_and_login(client, "resume-r1@x.com")
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]

    r = client.get(f"/projects/{pid}/tasks/{tid}/resume", headers=_hdr(token))

    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {
        "last_asset_id": None,
        "last_frame_id": None,
        "annotated_assets": 0,
        "total_assets": 0,
        "last_activity_at": None,
    }


def test_resume_requires_auth(db_session) -> None:
    client = _client(db_session)
    fake_pid = "00000000-0000-0000-0000-000000000000"
    fake_tid = "00000000-0000-0000-0000-000000000000"
    r = client.get(f"/projects/{fake_pid}/tasks/{fake_tid}/resume")
    assert r.status_code == 401


def test_resume_404_for_unknown_task(db_session) -> None:
    client = _client(db_session)
    token = _register_and_login(client, "resume-r2@x.com")
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    bogus_tid = "00000000-0000-0000-0000-000000000000"
    r = client.get(f"/projects/{pid}/tasks/{bogus_tid}/resume", headers=_hdr(token))
    assert r.status_code == 404


def test_resume_403_for_non_member(db_session) -> None:
    client = _client(db_session)
    owner_token = _register_and_login(client, "resume-owner@x.com")
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(owner_token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(owner_token),
    ).json()["id"]

    # Second user must be registered by an authenticated user (invite pattern).
    client.post(
        "/auth/register",
        json={"email": "resume-outsider@x.com", "password": "hunter22"},
        headers=_hdr(owner_token),
    )
    outsider_token = client.post(
        "/auth/login",
        json={"email": "resume-outsider@x.com", "password": "hunter22"},
    ).json()["access_token"]

    r = client.get(
        f"/projects/{pid}/tasks/{tid}/resume", headers=_hdr(outsider_token)
    )
    assert r.status_code == 403
