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


# --- SAM encode Redis cache ------------------------------------------------


class _FakeRedis:
    """In-memory stand-in for redis.Redis used by the SAM encode cache.

    Mirrors patterns in tests/io/test_import_job.py and
    tests/inference/test_batch.py. Supports get/setex/ping with TTL
    bookkeeping that the cache layer relies on.
    """

    def __init__(self) -> None:
        self.store: dict[str, bytes] = {}
        self.ttls: dict[str, int] = {}
        self.ping_calls = 0
        self.get_calls = 0

    def ping(self) -> bool:
        self.ping_calls += 1
        return True

    def get(self, key: str):
        self.get_calls += 1
        return self.store.get(key)

    def setex(self, key: str, ttl: int, value) -> bool:
        self.store[key] = value if isinstance(value, bytes) else value.encode()
        self.ttls[key] = ttl
        return True


def test_sam_encode_caches_in_redis(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    from carve_api.inference import sam as sam_mod
    fake = _FakeRedis()
    monkeypatch.setattr(sam_mod, "_redis_or_none", lambda: fake)

    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/encode":
            call_count["n"] += 1
            return httpx.Response(200, json={
                "image_hash": "cafebabe" * 4,
                "shape": [12, 34],
                "embedding_b64": "AAA=",
            })
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(f"/assets/{aid}/sam/encode", headers=_hdr(token))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["image_hash"] == "cafebabe" * 4
        assert body["embedding_b64"] == "AAA="
        # Cache was written with a 30-min TTL
        assert call_count["n"] == 1
        assert any(k.startswith("sam:embed:") for k in fake.store)
        cache_key = next(k for k in fake.store if k.startswith("sam:embed:"))
        assert fake.ttls[cache_key] == 30 * 60
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_encode_returns_cached_on_repeat(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    from carve_api.inference import sam as sam_mod
    fake = _FakeRedis()
    monkeypatch.setattr(sam_mod, "_redis_or_none", lambda: fake)

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
        # Second call hits the cache — no second model invocation
        assert call_count["n"] == 1
        assert r1.json() == r2.json()
        assert r2.json()["embedding_b64"] == "BBB="
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_encode_falls_back_when_redis_unavailable(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    from carve_api.inference import sam as sam_mod
    monkeypatch.setattr(sam_mod, "_redis_or_none", lambda: None)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/encode":
            return httpx.Response(200, json={
                "image_hash": "ab" * 16,
                "shape": [4, 4],
                "embedding_b64": None,
            })
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(f"/assets/{aid}/sam/encode", headers=_hdr(token))
        assert r.status_code == 200, r.text
        assert r.json()["image_hash"] == "ab" * 16
    finally:
        model_client_mod.set_test_transport(None)
