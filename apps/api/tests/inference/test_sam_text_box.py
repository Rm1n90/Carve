"""v3.5 Phase D — API proxy tests for SAM 3 text + box prompts.

Mirrors the encoding/decoding test pattern in ``test_sam.py``: monkeypatch
``MinioClient`` so the asset bytes come from an in-memory PNG, and use
``httpx.MockTransport`` to stub the model service. Each test exercises one
status branch (200 happy path / 409 sam3_not_enabled / 503 unreachable)
for both ``/sam/text-prompt`` and ``/sam/box-prompt``.
"""

import io

import httpx
from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.inference import model_client as model_client_mod
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


def _hdr(t):
    return {"Authorization": f"Bearer {t}"}


def _tiny_png() -> bytes:
    return bytes.fromhex(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA63000000000200015C8B59FA0000000049454E44AE426082"
    )


class _FakeStorage:
    @classmethod
    def from_settings(cls):
        return cls()

    def ensure_bucket(self):
        pass

    def put_object(self, *a, **k):
        pass

    def get_object(self, key):
        return io.BytesIO(_tiny_png())

    def remove_object(self, key):
        pass

    def presigned_get(self, key, **k):
        return f"https://fake/{key}"


def _setup_asset(client, monkeypatch):
    from carve_api.assets import service as assets_svc
    from carve_api.inference import autoannotate as aa_mod

    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(aa_mod, "MinioClient", _FakeStorage)

    client.post("/auth/register", json={"email": "sam3@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "sam3@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(token)
    ).json()["id"]
    aid = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(_tiny_png()), "image/png")},
        headers=_hdr(token),
    ).json()["id"]
    return token, aid


# --- /sam/text-prompt --------------------------------------------------------


def test_sam_text_prompt_returns_masks(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/text-prompt":
            import json

            seen.update(json.loads(request.content))
            return httpx.Response(
                200,
                json=[
                    {
                        "counts": "0,2,2,2,10",
                        "size": [4, 4],
                        "score": 0.91,
                        "bbox": [1.0, 2.0, 3.0, 4.0],
                    }
                ],
            )
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/text-prompt",
            json={"text": "person"},
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert isinstance(body, list)
        assert body[0]["counts"] == "0,2,2,2,10"
        assert body[0]["score"] == 0.91
        assert seen["text"] == "person"
        assert "image_b64" in seen
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_text_prompt_409_when_sam3_disabled(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"detail": "sam3_not_enabled"})

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/text-prompt",
            json={"text": "dog"},
            headers=_hdr(token),
        )
        assert r.status_code == 409
        assert r.json()["error"] == "sam3_not_enabled"
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_text_prompt_503_on_connect_error(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(
            "[Errno -3] Temporary failure in name resolution",
            request=request,
        )

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/text-prompt",
            json={"text": "cat"},
            headers=_hdr(token),
        )
        assert r.status_code == 503, r.text
        assert r.json()["error"] == "model_service_unreachable"
    finally:
        model_client_mod.set_test_transport(None)


# --- /sam/box-prompt ---------------------------------------------------------


def test_sam_box_prompt_returns_mask(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/box-prompt":
            import json

            seen.update(json.loads(request.content))
            return httpx.Response(
                200,
                json=[
                    {
                        "counts": "0,4,4,4,12",
                        "size": [8, 8],
                        "score": 0.83,
                        "bbox": [10.0, 20.0, 30.0, 40.0],
                    }
                ],
            )
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/box-prompt",
            json={
                "boxes": [[10.0, 20.0, 30.0, 40.0]],
                "box_labels": [1],
            },
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body[0]["counts"] == "0,4,4,4,12"
        assert body[0]["score"] == 0.83
        assert seen["boxes"] == [[10.0, 20.0, 30.0, 40.0]]
        assert seen["box_labels"] == [1]
        # ``text`` defaults to None and should NOT be sent to the model
        # service (the box-prompt body omits it when absent).
        assert "text" not in seen
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_box_prompt_forwards_optional_text(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/box-prompt":
            import json

            seen.update(json.loads(request.content))
            return httpx.Response(
                200,
                json=[
                    {
                        "counts": "1,2,3",
                        "size": [4, 4],
                        "score": 0.7,
                        "bbox": [0.0, 0.0, 1.0, 1.0],
                    }
                ],
            )
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/box-prompt",
            json={
                "boxes": [[0.0, 0.0, 1.0, 1.0]],
                "box_labels": [1],
                "text": "fire hydrant",
            },
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        assert seen["text"] == "fire hydrant"
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_box_prompt_409_when_sam3_disabled(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"detail": "sam3_box_prompt_requires_sam3"})

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/box-prompt",
            json={
                "boxes": [[0.0, 0.0, 1.0, 1.0]],
                "box_labels": [1],
            },
            headers=_hdr(token),
        )
        assert r.status_code == 409
        assert r.json()["error"] == "sam3_not_enabled"
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_box_prompt_503_on_connect_error(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(
            "[Errno -3] Temporary failure in name resolution",
            request=request,
        )

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/box-prompt",
            json={
                "boxes": [[0.0, 0.0, 1.0, 1.0]],
                "box_labels": [1],
            },
            headers=_hdr(token),
        )
        assert r.status_code == 503, r.text
        assert r.json()["error"] == "model_service_unreachable"
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_box_prompt_422_on_length_mismatch(db_session, monkeypatch) -> None:
    """boxes/box_labels parity is enforced at the API layer before any
    model-service round-trip — saves a hop and produces a clearer error."""
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        # Should never be reached.
        return httpx.Response(500, json={"detail": "should_not_happen"})

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/box-prompt",
            json={
                "boxes": [[0.0, 0.0, 1.0, 1.0], [2.0, 2.0, 3.0, 3.0]],
                "box_labels": [1],  # length 1 vs 2 boxes
            },
            headers=_hdr(token),
        )
        assert r.status_code == 422, r.text
    finally:
        model_client_mod.set_test_transport(None)
