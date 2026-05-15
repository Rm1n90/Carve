import io

import httpx
from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.inference import model_client as model_client_mod
from carve_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()
    def _override():
        try: yield db_session
        finally: db_session.rollback()
    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(t): return {"Authorization": f"Bearer {t}"}


def _tiny_png() -> bytes:
    return bytes.fromhex(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA63000000000200015C8B59FA0000000049454E44AE426082"
    )


class _FakeStorage:
    @classmethod
    def from_settings(cls): return cls()
    def ensure_bucket(self): pass
    def put_object(self, *a, **k): pass
    def get_object(self, key): return io.BytesIO(_tiny_png())
    def remove_object(self, key): pass
    def presigned_get(self, key, **k): return f"https://fake/{key}"


def _setup_asset(client, monkeypatch):
    from carve_api.assets import service as assets_svc
    from carve_api.inference import autoannotate as aa_mod
    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(aa_mod, "MinioClient", _FakeStorage)

    client.post("/auth/register", json={"email": "sam@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "sam@x.com", "password": "hunter22"}).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(token)).json()["id"]
    aid = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(_tiny_png()), "image/png")},
        headers=_hdr(token),
    ).json()["id"]
    return token, aid


def test_sam_encode_returns_image_hash(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/encode":
            return httpx.Response(200, json={
                "image_hash": "deadbeef" * 4,
                "shape": [1, 1],
            })
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(f"/assets/{aid}/sam/encode", headers=_hdr(token))
        assert r.status_code == 200
        assert r.json()["image_hash"] == "deadbeef" * 4
        assert r.json()["shape"] == [1, 1]
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_decode_forwards_points_and_labels(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/decode":
            import json
            body = json.loads(request.content)
            seen.update(body)
            return httpx.Response(200, json={
                "counts": "0,2,2,2,10",
                "size": [4, 4],
                "score": 0.88,
            })
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/decode",
            json={
                "image_hash": "deadbeef" * 4,
                "points": [[10, 10], [20, 20]],
                "labels": [1, 0],
            },
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["counts"] == "0,2,2,2,10"
        assert body["score"] == 0.88
        assert seen["points"] == [[10, 10], [20, 20]]
        assert seen["labels"] == [1, 0]
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_decode_409_when_embedding_missing(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"detail": "embedding_not_loaded"})

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/decode",
            json={
                "image_hash": "x" * 32,
                "points": [[1, 2]],
                "labels": [1],
            },
            headers=_hdr(token),
        )
        assert r.status_code == 409
        assert r.json()["error"] == "sam_embedding_missing"
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_decode_502_on_model_error(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"detail": "boom"})

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/decode",
            json={
                "image_hash": "x" * 32,
                "points": [[1, 2]],
                "labels": [1],
            },
            headers=_hdr(token),
        )
        assert r.status_code == 502
        assert r.json()["error"] == "sam_model_failed"
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_unknown_asset_returns_404(db_session, monkeypatch) -> None:
    client = _client(db_session)
    from carve_api.assets import service as assets_svc
    from carve_api.inference import autoannotate as aa_mod
    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(aa_mod, "MinioClient", _FakeStorage)
    client.post("/auth/register", json={"email": "u@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "u@x.com", "password": "hunter22"}).json()["access_token"]
    import uuid
    r = client.post(f"/assets/{uuid.uuid4()}/sam/encode", headers=_hdr(token))
    assert r.status_code == 404


# --- v3.5 Phase A2: encode always round-trips to the model service ---------
#
# The Redis ``sam:embed:<hash>`` cache was removed because it could
# return a successful encode result without the model service actually
# loading the image — which caused subsequent decodes to 409/500 when
# the predictor's set_image had not been invoked.


def test_sam_encode_always_calls_model_service(db_session, monkeypatch) -> None:
    """Repeat encode requests on the same asset must each round-trip
    to the model service. Pre-v3.5 this was cached in Redis; the cache
    has been dropped to keep the API in sync with the model worker."""
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/encode":
            call_count["n"] += 1
            return httpx.Response(200, json={
                "image_hash": "feedface" * 4,
                "shape": [10, 20],
                "embedding_b64": "BBB=",
            })
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r1 = client.post(f"/assets/{aid}/sam/encode", headers=_hdr(token))
        r2 = client.post(f"/assets/{aid}/sam/encode", headers=_hdr(token))
        assert r1.status_code == 200 and r2.status_code == 200
        # Both calls reached the model service — no API-side caching.
        assert call_count["n"] == 2
        assert r1.json() == r2.json()
        assert r2.json()["embedding_b64"] == "BBB="
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_encode_raises_503_when_model_service_down(db_session, monkeypatch) -> None:
    """When the model service hostname can't be resolved (i.e. the
    ``inference`` docker-compose profile isn't running), the api previously
    surfaced the raw httpx.ConnectError as a generic 500. We now translate
    it to a 503 with ``error: model_service_unreachable`` so the SAM tool
    can show a clear "model service is offline" toast."""
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(
            "[Errno -3] Temporary failure in name resolution",
            request=request,
        )

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(f"/assets/{aid}/sam/encode", headers=_hdr(token))
        assert r.status_code == 503, r.text
        assert r.json()["error"] == "model_service_unreachable"
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_encode_translates_lifecycle_loading_to_sam_not_ready(
    db_session, monkeypatch,
) -> None:
    """A model-service ``503 {"detail": "sam_loading"}`` (variant is mid
    hot-swap) used to be collapsed to ``model_service_unreachable`` and
    rendered as "model service is offline" in the editor — confusing the
    user because the service *is* running, the variant is just loading.

    The api now re-packs the lifecycle detail into ``error=sam_not_ready``
    with a ``state`` slug so the frontend can show "SAM is loading the
    model. Try again in a few seconds." instead.
    """
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/encode":
            return httpx.Response(503, json={"detail": "sam_loading"})
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(f"/assets/{aid}/sam/encode", headers=_hdr(token))
        assert r.status_code == 503, r.text
        body = r.json()
        assert body["error"] == "sam_not_ready", body
        assert body["state"] == "loading", body
        assert body["detail"] == "sam_loading", body
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_encode_translates_lifecycle_idle_to_sam_not_ready(
    db_session, monkeypatch,
) -> None:
    """``503 {"detail": "sam_not_loaded"}`` → ``state="idle"`` so the editor
    can prompt the user to pick a variant instead of suggesting the
    model container is down."""
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/encode":
            return httpx.Response(503, json={"detail": "sam_not_loaded"})
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(f"/assets/{aid}/sam/encode", headers=_hdr(token))
        assert r.status_code == 503, r.text
        body = r.json()
        assert body["error"] == "sam_not_ready"
        assert body["state"] == "idle"
        assert body["detail"] == "sam_not_loaded"
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_encode_translates_lifecycle_load_failed_to_sam_not_ready(
    db_session, monkeypatch,
) -> None:
    """``503 {"detail": "sam_load_failed: <reason>"}`` → ``state="error"``
    with the original reason preserved in ``detail`` so the editor can
    surface the actual failure (e.g. ``CUDA out of memory``) instead of a
    generic "service unavailable" toast."""
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/encode":
            return httpx.Response(
                503, json={"detail": "sam_load_failed: CUDA out of memory"},
            )
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(f"/assets/{aid}/sam/encode", headers=_hdr(token))
        assert r.status_code == 503, r.text
        body = r.json()
        assert body["error"] == "sam_not_ready"
        assert body["state"] == "error"
        assert "CUDA out of memory" in body["detail"]
    finally:
        model_client_mod.set_test_transport(None)
