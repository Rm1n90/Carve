"""SSO OIDC entry-point tests (Plan-13 Phase 7 Task 5).

Fakes the OIDC provider with ``httpx.MockTransport`` so we can drive
the full authorize -> exchange -> id_token-verify roundtrip without
touching the network. A self-signed RSA key is generated per session
and exposed via a mock JWKS endpoint; ``id_token``s are signed with
it.
"""

from __future__ import annotations

import base64
import json
import time
from collections.abc import Iterator
from urllib.parse import parse_qs, urlparse

import httpx
import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import select

from carve_api.auth.models import User
from carve_api.auth.sso import (
    reset_discovery_cache,
    reset_state_store,
    set_http_client_factory,
)
from carve_api.config import get_settings
from carve_api.deps import get_db
from carve_api.main import create_app


ISSUER = "https://accounts.example.com"
DISCOVERY_URL = f"{ISSUER}/.well-known/openid-configuration"
AUTH_ENDPOINT = f"{ISSUER}/authorize"
TOKEN_ENDPOINT = f"{ISSUER}/token"
JWKS_URI = f"{ISSUER}/jwks"
CLIENT_ID = "test-client-id"
CLIENT_SECRET = "test-client-secret"
REDIRECT_URI = "http://localhost:8000/auth/sso/google/callback"


def _b64url_uint(value: int) -> str:
    raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


@pytest.fixture(scope="module")
def rsa_keypair() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="module")
def jwks(rsa_keypair: rsa.RSAPrivateKey) -> dict:
    pub = rsa_keypair.public_key().public_numbers()
    return {
        "keys": [
            {
                "kty": "RSA",
                "kid": "test-key-1",
                "use": "sig",
                "alg": "RS256",
                "n": _b64url_uint(pub.n),
                "e": _b64url_uint(pub.e),
            }
        ]
    }


def _make_id_token(
    rsa_keypair: rsa.RSAPrivateKey,
    *,
    email: str,
    sub: str,
    nonce: str,
    audience: str = CLIENT_ID,
    issuer: str = ISSUER,
    exp_offset: int = 600,
) -> str:
    now = int(time.time())
    claims = {
        "iss": issuer,
        "aud": audience,
        "sub": sub,
        "email": email,
        "email_verified": True,
        "nonce": nonce,
        "iat": now,
        "exp": now + exp_offset,
    }
    private_pem = rsa_keypair.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return pyjwt.encode(
        claims,
        private_pem,
        algorithm="RS256",
        headers={"kid": "test-key-1"},
    )


class MockOIDCServer:
    """Holds mutable state so individual tests can override the next
    id_token to return without rebuilding the whole transport.
    """

    def __init__(self, rsa_keypair: rsa.RSAPrivateKey, jwks: dict) -> None:
        self.rsa_keypair = rsa_keypair
        self.jwks = jwks
        self.next_id_token: str | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == DISCOVERY_URL:
            return httpx.Response(
                200,
                json={
                    "issuer": ISSUER,
                    "authorization_endpoint": AUTH_ENDPOINT,
                    "token_endpoint": TOKEN_ENDPOINT,
                    "jwks_uri": JWKS_URI,
                },
            )
        if url == JWKS_URI:
            return httpx.Response(200, json=self.jwks)
        if url == TOKEN_ENDPOINT:
            assert self.next_id_token is not None, "test forgot to set id_token"
            return httpx.Response(
                200,
                json={
                    "id_token": self.next_id_token,
                    "access_token": "fake-access",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                },
            )
        return httpx.Response(404, text=f"unmocked: {url}")


@pytest.fixture
def mock_oidc(
    rsa_keypair: rsa.RSAPrivateKey,
    jwks: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[MockOIDCServer]:
    server = MockOIDCServer(rsa_keypair, jwks)
    transport = httpx.MockTransport(server.handler)

    def factory() -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=transport, timeout=5.0)

    set_http_client_factory(factory)
    reset_state_store()
    reset_discovery_cache()

    # Patch PyJWKClient so the JWKS fetch (urllib-based) also runs
    # against our mock transport.
    import jwt as _jwt

    original_pyjwk_client = _jwt.PyJWKClient

    class _FakePyJWKClient:
        def __init__(self, uri: str, *args, **kwargs) -> None:
            self.uri = uri

        def get_signing_key_from_jwt(self, token: str):
            with httpx.Client(transport=transport) as c:
                resp = c.get(self.uri)
            jwk = resp.json()["keys"][0]
            from jwt.algorithms import RSAAlgorithm

            class _Key:
                key = RSAAlgorithm.from_jwk(json.dumps(jwk))

            return _Key()

    monkeypatch.setattr(_jwt, "PyJWKClient", _FakePyJWKClient)

    yield server

    set_http_client_factory(None)
    reset_state_store()
    reset_discovery_cache()
    monkeypatch.setattr(_jwt, "PyJWKClient", original_pyjwk_client)


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app, follow_redirects=False)


def _enable_google_sso(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SSO_PROVIDERS", "google")
    monkeypatch.setenv("OIDC_GOOGLE_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("OIDC_GOOGLE_CLIENT_SECRET", CLIENT_SECRET)
    monkeypatch.setenv("OIDC_GOOGLE_DISCOVERY_URL", DISCOVERY_URL)
    monkeypatch.setenv("OIDC_GOOGLE_REDIRECT_URI", REDIRECT_URI)
    get_settings.cache_clear()


def _disable_sso(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SSO_PROVIDERS", "")
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _restore_settings_cache() -> Iterator[None]:
    yield
    get_settings.cache_clear()


def test_sso_routes_404_when_no_providers_configured(
    db_session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _disable_sso(monkeypatch)
    client = _client(db_session)
    r = client.get("/auth/sso/google/start")
    assert r.status_code == 404
    assert r.json()["error"] == "sso_provider_unknown"

    r2 = client.get("/auth/sso/google/callback?code=x&state=y")
    assert r2.status_code == 404


def test_sso_start_redirects_with_pkce_and_state(
    db_session, monkeypatch: pytest.MonkeyPatch, mock_oidc: MockOIDCServer
) -> None:
    _enable_google_sso(monkeypatch)
    client = _client(db_session)
    r = client.get("/auth/sso/google/start?redirect_url=/dashboard")
    assert r.status_code == 302
    location = r.headers["location"]
    parsed = urlparse(location)
    assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == AUTH_ENDPOINT
    qs = parse_qs(parsed.query)
    assert qs["client_id"] == [CLIENT_ID]
    assert qs["redirect_uri"] == [REDIRECT_URI]
    assert qs["response_type"] == ["code"]
    assert qs["code_challenge_method"] == ["S256"]
    assert qs["code_challenge"][0]
    assert qs["state"][0]
    assert qs["nonce"][0]
    assert "openid" in qs["scope"][0]


def _do_start(client: TestClient) -> tuple[str, str]:
    r = client.get("/auth/sso/google/start?redirect_url=/after")
    assert r.status_code == 302
    qs = parse_qs(urlparse(r.headers["location"]).query)
    return qs["state"][0], qs["nonce"][0]


def test_sso_callback_creates_new_user_and_issues_jwt(
    db_session,
    monkeypatch: pytest.MonkeyPatch,
    mock_oidc: MockOIDCServer,
    rsa_keypair: rsa.RSAPrivateKey,
) -> None:
    _enable_google_sso(monkeypatch)
    client = _client(db_session)
    state, nonce = _do_start(client)
    mock_oidc.next_id_token = _make_id_token(
        rsa_keypair, email="alice@example.com", sub="sub-alice", nonce=nonce
    )
    r = client.get(f"/auth/sso/google/callback?code=auth-code&state={state}")
    assert r.status_code == 302
    location = r.headers["location"]
    assert location.startswith("/after#token=")
    token = location.split("#token=", 1)[1]
    assert token

    user = db_session.execute(
        select(User).where(User.email == "alice@example.com")
    ).scalar_one()
    assert user.sso_subject == "sub-alice"


def test_sso_callback_links_existing_user(
    db_session,
    monkeypatch: pytest.MonkeyPatch,
    mock_oidc: MockOIDCServer,
    rsa_keypair: rsa.RSAPrivateKey,
) -> None:
    _enable_google_sso(monkeypatch)
    client = _client(db_session)
    client.post(
        "/auth/register",
        json={"email": "bob@example.com", "password": "hunter22"},
    )
    state, nonce = _do_start(client)
    mock_oidc.next_id_token = _make_id_token(
        rsa_keypair, email="bob@example.com", sub="sub-bob", nonce=nonce
    )
    r = client.get(f"/auth/sso/google/callback?code=c&state={state}")
    assert r.status_code == 302
    user = db_session.execute(
        select(User).where(User.email == "bob@example.com")
    ).scalar_one()
    assert user.sso_subject == "sub-bob"


def test_sso_callback_invalid_state(
    db_session, monkeypatch: pytest.MonkeyPatch, mock_oidc: MockOIDCServer
) -> None:
    _enable_google_sso(monkeypatch)
    client = _client(db_session)
    r = client.get("/auth/sso/google/callback?code=c&state=never-issued")
    assert r.status_code == 400
    assert r.json()["error"] == "sso_invalid_or_replayed_state"


def test_sso_callback_replayed_state(
    db_session,
    monkeypatch: pytest.MonkeyPatch,
    mock_oidc: MockOIDCServer,
    rsa_keypair: rsa.RSAPrivateKey,
) -> None:
    _enable_google_sso(monkeypatch)
    client = _client(db_session)
    state, nonce = _do_start(client)
    mock_oidc.next_id_token = _make_id_token(
        rsa_keypair, email="carol@example.com", sub="sub-carol", nonce=nonce
    )
    r1 = client.get(f"/auth/sso/google/callback?code=c&state={state}")
    assert r1.status_code == 302
    r2 = client.get(f"/auth/sso/google/callback?code=c&state={state}")
    assert r2.status_code == 400
    assert r2.json()["error"] == "sso_invalid_or_replayed_state"


def test_sso_callback_bad_nonce(
    db_session,
    monkeypatch: pytest.MonkeyPatch,
    mock_oidc: MockOIDCServer,
    rsa_keypair: rsa.RSAPrivateKey,
) -> None:
    _enable_google_sso(monkeypatch)
    client = _client(db_session)
    state, _nonce = _do_start(client)
    mock_oidc.next_id_token = _make_id_token(
        rsa_keypair,
        email="dave@example.com",
        sub="sub-dave",
        nonce="wrong-nonce",
    )
    r = client.get(f"/auth/sso/google/callback?code=c&state={state}")
    assert r.status_code == 400
    assert "nonce" in r.json()["error"]


def test_sso_callback_subject_conflict(
    db_session,
    monkeypatch: pytest.MonkeyPatch,
    mock_oidc: MockOIDCServer,
    rsa_keypair: rsa.RSAPrivateKey,
) -> None:
    _enable_google_sso(monkeypatch)
    client = _client(db_session)
    state1, nonce1 = _do_start(client)
    mock_oidc.next_id_token = _make_id_token(
        rsa_keypair, email="eve@example.com", sub="sub-eve-1", nonce=nonce1
    )
    r1 = client.get(f"/auth/sso/google/callback?code=c&state={state1}")
    assert r1.status_code == 302

    state2, nonce2 = _do_start(client)
    mock_oidc.next_id_token = _make_id_token(
        rsa_keypair, email="eve@example.com", sub="sub-eve-2", nonce=nonce2
    )
    r2 = client.get(f"/auth/sso/google/callback?code=c&state={state2}")
    assert r2.status_code == 409
    assert r2.json()["error"] == "sso_subject_conflict"
