"""v3.27+ — API proxy tests for SAM 3.1 visual prompts.

Mirrors the encoding/decoding test pattern in ``test_sam.py``: monkeypatch
``MinioClient`` so the asset bytes come from an in-memory PNG, and use
``httpx.MockTransport`` to stub the model service. Each test exercises one
status branch (200 happy path / 409 sam3p1_not_enabled / 503 unreachable).
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

    client.post("/auth/register", json={"email": "vis@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "vis@x.com", "password": "hunter22"}
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


# --- /sam/visual-prompt --------------------------------------------------------


def test_sam_visual_prompt_returns_masks(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/visual-prompt":
            import json

            seen.update(json.loads(request.content))
            return httpx.Response(
                200,
                json=[
                    {
                        "counts": "0,2,2,2,10",
                        "size": [4, 4],
                        "score": 0.92,
                        "bbox": [1.0, 2.0, 3.0, 4.0],
                    }
                ],
            )
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/visual-prompt",
            json={
                "refer_asset_id": aid,
                "target_asset_id": aid,
                "regions": [{"kind": "bbox", "xyxy": [0, 0, 10, 10]}],
            },
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert isinstance(body, list)
        assert body[0]["counts"] == "0,2,2,2,10"
        assert body[0]["score"] == 0.92
        assert "refer_b64" in seen
        assert "target_b64" in seen
        assert seen["regions"] == [{"kind": "bbox", "xyxy": [0, 0, 10, 10]}]
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_visual_prompt_409_when_sam31_disabled(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"detail": "sam3p1_not_enabled"})

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/visual-prompt",
            json={
                "refer_asset_id": aid,
                "target_asset_id": aid,
                "regions": [{"kind": "bbox", "xyxy": [5, 5, 15, 15]}],
            },
            headers=_hdr(token),
        )
        assert r.status_code == 409
        assert r.json()["error"] == "sam3_not_enabled"
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_visual_prompt_503_on_connect_error(db_session, monkeypatch) -> None:
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
            f"/assets/{aid}/sam/visual-prompt",
            json={
                "refer_asset_id": aid,
                "target_asset_id": aid,
                "regions": [{"kind": "polygon", "xy": [[1, 1], [10, 1], [10, 10]]}],
            },
            headers=_hdr(token),
        )
        assert r.status_code == 503, r.text
        assert r.json()["error"] == "model_service_unreachable"
    finally:
        model_client_mod.set_test_transport(None)
