"""v3.3 audit issue 3a — weight upload populates ``class_names`` from the
model service ``/yolo/inspect`` endpoint.

We mock the model-service transport with ``httpx.MockTransport`` so the
upload path exercises the real ``WeightService.upload`` → ``yolo_inspect``
wiring without booting the model container or importing torch.

Coverage axes:

  * happy path: model service returns a real names dict → row stores it
  * connect failure: model service down → row falls back to ``[]``
  * 422 parser failure: corrupt .pt → row falls back to user-supplied names
  * task_kind override: inspect returns a different (valid) task than form
"""

import io
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.inference import model_client as model_client_mod
from carve_api.main import create_app


def _build_test_client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _setup(client: TestClient, monkeypatch) -> tuple[str, str]:
    """Stub MinioClient and bring up an authenticated user + project."""
    from carve_api.weights import service as svc_mod

    class _FakeStorage:
        @classmethod
        def from_settings(cls):
            return cls()

        def ensure_bucket(self):
            pass

        def put_object(self, *a, **k):
            pass

        def get_object(self, key):
            return io.BytesIO(b"")

        def remove_object(self, key):
            pass

        def presigned_get(self, key, **k):
            return f"https://fake/{key}"

    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client.post("/auth/register", json={"email": "ins@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login",
        json={"email": "ins@x.com", "password": "hunter22"},
    ).json()["access_token"]
    pid = client.post(
        "/projects", json={"name": "Inspector"}, headers=_hdr(token)
    ).json()["id"]
    return token, pid


def _make_inspect_transport(
    response_body: dict[str, Any], status_code: int = 200
) -> httpx.MockTransport:
    """Mock transport that returns ``response_body`` on /yolo/inspect."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/yolo/inspect":
            return httpx.Response(status_code, json=response_body)
        return httpx.Response(404, json={"detail": "unhandled"})

    return httpx.MockTransport(handler)


def _make_failing_transport(exc: Exception) -> httpx.MockTransport:
    """Mock transport that raises a connection-level error on every call."""

    def handler(_request: httpx.Request) -> httpx.Response:
        raise exc

    return httpx.MockTransport(handler)


@pytest.mark.integration
def test_upload_populates_class_names_from_inspect(db_session, monkeypatch) -> None:
    client = _build_test_client(db_session)
    token, pid = _setup(client, monkeypatch)

    transport = _make_inspect_transport(
        {"class_names": ["person", "bicycle", "car"], "task_kind": "detect"}
    )
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/projects/{pid}/weights",
            data={"name": "yolov8n", "task_kind": "detect", "class_names": "[]"},
            files={
                "file": (
                    "yolov8n.pt",
                    io.BytesIO(b"PK\x03\x04" + b"x" * 64),
                    "application/octet-stream",
                )
            },
            headers=_hdr(token),
        )
    finally:
        model_client_mod.set_test_transport(None)
    assert r.status_code == 201, r.text
    body = r.json()
    # The /yolo/inspect mock injected real class names — they MUST land on
    # the persisted row, replacing the form-supplied empty list.
    assert body["class_names"] == ["person", "bicycle", "car"]
    assert body["task_kind"] == "detect"


@pytest.mark.integration
def test_upload_falls_back_when_model_service_unreachable(db_session, monkeypatch) -> None:
    """Connect-level failure must NOT break the upload — class_names = []."""
    client = _build_test_client(db_session)
    token, pid = _setup(client, monkeypatch)

    transport = _make_failing_transport(httpx.ConnectError("connection refused"))
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/projects/{pid}/weights",
            data={"name": "no-inspect", "task_kind": "detect", "class_names": "[]"},
            files={
                "file": (
                    "y.pt",
                    io.BytesIO(b"PK\x03\x04" + b"x" * 32),
                    "application/octet-stream",
                )
            },
            headers=_hdr(token),
        )
    finally:
        model_client_mod.set_test_transport(None)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["class_names"] == []


@pytest.mark.integration
def test_upload_falls_back_when_inspect_returns_422(db_session, monkeypatch) -> None:
    """Corrupt .pt → model service 422 → row falls back to user-supplied names."""
    client = _build_test_client(db_session)
    token, pid = _setup(client, monkeypatch)

    transport = _make_inspect_transport(
        {"detail": "failed_to_load: bad magic"}, status_code=422
    )
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/projects/{pid}/weights",
            data={
                "name": "with-fallback",
                "task_kind": "detect",
                "class_names": '["fallback"]',
            },
            files={
                "file": (
                    "y.pt",
                    io.BytesIO(b"PK\x03\x04" + b"x" * 32),
                    "application/octet-stream",
                )
            },
            headers=_hdr(token),
        )
    finally:
        model_client_mod.set_test_transport(None)
    assert r.status_code == 201, r.text
    body = r.json()
    # The inspect call failed → keep the user-supplied fallback array.
    assert body["class_names"] == ["fallback"]


@pytest.mark.integration
def test_upload_overrides_task_kind_when_inspect_disagrees(db_session, monkeypatch) -> None:
    """A segment .pt uploaded as 'detect' should be corrected by inspect."""
    client = _build_test_client(db_session)
    token, pid = _setup(client, monkeypatch)

    transport = _make_inspect_transport(
        {"class_names": ["person"], "task_kind": "segment"}
    )
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/projects/{pid}/weights",
            data={"name": "seg", "task_kind": "detect", "class_names": "[]"},
            files={
                "file": (
                    "y.pt",
                    io.BytesIO(b"PK\x03\x04" + b"x" * 32),
                    "application/octet-stream",
                )
            },
            headers=_hdr(token),
        )
    finally:
        model_client_mod.set_test_transport(None)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["task_kind"] == "segment"
    assert body["class_names"] == ["person"]


@pytest.mark.integration
def test_upload_accepts_omitted_class_names_field(db_session, monkeypatch) -> None:
    """v3.3: class_names is optional on the upload form. Older clients still
    work, but new clients can omit it entirely and rely on inspect."""
    client = _build_test_client(db_session)
    token, pid = _setup(client, monkeypatch)

    transport = _make_inspect_transport(
        {"class_names": ["person", "bicycle"], "task_kind": "detect"}
    )
    model_client_mod.set_test_transport(transport)
    try:
        r = client.post(
            f"/projects/{pid}/weights",
            data={"name": "no-classes-field", "task_kind": "detect"},
            files={
                "file": (
                    "y.pt",
                    io.BytesIO(b"PK\x03\x04" + b"x" * 32),
                    "application/octet-stream",
                )
            },
            headers=_hdr(token),
        )
    finally:
        model_client_mod.set_test_transport(None)
    assert r.status_code == 201, r.text
    assert r.json()["class_names"] == ["person", "bicycle"]
