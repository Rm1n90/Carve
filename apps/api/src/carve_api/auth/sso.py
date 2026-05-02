"""OIDC SSO entry point (Plan-13 Phase 7 Task 5).

Wires the minimal moving parts needed to drive an Authorization-Code +
PKCE flow against an OIDC provider:

* PKCE / state / nonce generation helpers.
* In-process state store with TTL (single-replica only -- multi-replica
  deployments need to swap this for a Redis-backed store).
* OIDC discovery cache (1h TTL) keyed on ``discovery_url``.
* ``OIDCProvider`` adapter exposing ``authorize_url``, ``exchange_code``,
  and ``verify_id_token``.

RS256/ES256 signature verification is delegated to PyJWT +
``cryptography`` via ``jwt.PyJWKClient``. No new heavy deps are added
beyond the ``[crypto]`` extra of the existing PyJWT pin.

Framework-agnostic; FastAPI integration lives in
``carve_api.auth.router``.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt as pyjwt

from carve_api.config import get_settings


# ---------------------------------------------------------------------------
# PKCE / state helpers
# ---------------------------------------------------------------------------


def generate_pkce_pair() -> tuple[str, str]:
    """Return ``(code_verifier, code_challenge)`` for PKCE S256.

    The verifier is 64 bytes of url-safe randomness (well over the 43-128
    char window mandated by RFC 7636); the challenge is the base64url-
    encoded SHA-256 of the verifier with trailing '=' stripped.
    """
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return verifier, challenge


def generate_state() -> str:
    return secrets.token_urlsafe(32)


def generate_nonce() -> str:
    return secrets.token_urlsafe(32)


# ---------------------------------------------------------------------------
# In-process state store with TTL (10 min)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SSOState:
    provider: str
    redirect_url: str
    code_verifier: str
    nonce: str


_STATE_TTL_SECONDS = 10 * 60
_state_store: dict[str, tuple[SSOState, float]] = {}
_state_lock = threading.Lock()


def _now() -> float:
    return time.time()


def _purge_expired(now: float) -> None:
    expired = [k for k, (_s, exp) in _state_store.items() if exp <= now]
    for k in expired:
        _state_store.pop(k, None)


def store_state(state: str, payload: SSOState) -> None:
    now = _now()
    with _state_lock:
        _purge_expired(now)
        _state_store[state] = (payload, now + _STATE_TTL_SECONDS)


def pop_state(state: str) -> SSOState | None:
    now = _now()
    with _state_lock:
        _purge_expired(now)
        entry = _state_store.pop(state, None)
    if entry is None:
        return None
    payload, exp = entry
    if exp <= now:
        return None
    return payload


def reset_state_store() -> None:
    """Test helper -- wipe the in-process state store."""
    with _state_lock:
        _state_store.clear()


# ---------------------------------------------------------------------------
# OIDC discovery cache (1h TTL)
# ---------------------------------------------------------------------------


_DISCOVERY_TTL_SECONDS = 60 * 60
_discovery_cache: dict[str, tuple[dict[str, Any], float]] = {}
_discovery_lock = threading.Lock()

# httpx client factory -- swappable for tests via ``set_http_client_factory``.
_http_client_factory: Any = None


def set_http_client_factory(factory: Any | None) -> None:
    """Test hook: install a callable that returns ``httpx.AsyncClient``.

    Production code passes ``None`` to fall back to the default client.
    """
    global _http_client_factory
    _http_client_factory = factory


def _build_async_client() -> httpx.AsyncClient:
    if _http_client_factory is not None:
        return _http_client_factory()
    return httpx.AsyncClient(timeout=10.0)


def reset_discovery_cache() -> None:
    """Test helper -- wipe the discovery cache."""
    with _discovery_lock:
        _discovery_cache.clear()


# ---------------------------------------------------------------------------
# OIDCProvider adapter
# ---------------------------------------------------------------------------


class OIDCError(Exception):
    """Raised on any OIDC-level failure (discovery, token exchange, verify)."""


@dataclass(frozen=True)
class OIDCProvider:
    name: str
    client_id: str
    client_secret: str
    discovery_url: str
    redirect_uri: str

    async def discover(self) -> dict[str, Any]:
        now = _now()
        with _discovery_lock:
            entry = _discovery_cache.get(self.discovery_url)
            if entry is not None and entry[1] > now:
                return entry[0]
        async with _build_async_client() as client:
            resp = await client.get(self.discovery_url)
            if resp.status_code != 200:
                raise OIDCError(
                    f"discovery_failed: {self.discovery_url} -> {resp.status_code}"
                )
            config = resp.json()
        with _discovery_lock:
            _discovery_cache[self.discovery_url] = (
                config,
                now + _DISCOVERY_TTL_SECONDS,
            )
        return config

    async def authorize_url(
        self, state: str, nonce: str, code_challenge: str
    ) -> str:
        config = await self.discover()
        endpoint = config.get("authorization_endpoint")
        if not endpoint:
            raise OIDCError("discovery_missing_authorization_endpoint")
        params = {
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "scope": "openid email profile",
            "state": state,
            "nonce": nonce,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        return f"{endpoint}?{urlencode(params)}"

    async def exchange_code(
        self, code: str, code_verifier: str
    ) -> dict[str, Any]:
        config = await self.discover()
        endpoint = config.get("token_endpoint")
        if not endpoint:
            raise OIDCError("discovery_missing_token_endpoint")
        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.redirect_uri,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "code_verifier": code_verifier,
        }
        async with _build_async_client() as client:
            resp = await client.post(
                endpoint,
                data=data,
                headers={"Accept": "application/json"},
            )
        if resp.status_code != 200:
            raise OIDCError(
                f"token_exchange_failed: {resp.status_code} {resp.text[:200]}"
            )
        body = resp.json()
        if "id_token" not in body:
            raise OIDCError("token_response_missing_id_token")
        return body

    async def verify_id_token(
        self, id_token: str, expected_nonce: str
    ) -> dict[str, Any]:
        config = await self.discover()
        jwks_uri = config.get("jwks_uri")
        issuer = config.get("issuer")
        if not jwks_uri or not issuer:
            raise OIDCError("discovery_missing_jwks_or_issuer")
        try:
            unverified_header = pyjwt.get_unverified_header(id_token)
        except pyjwt.PyJWTError as exc:
            raise OIDCError(f"id_token_header_invalid: {exc}") from exc
        alg = unverified_header.get("alg") or "RS256"
        # PyJWKClient owns its own HTTP fetch with a small in-process
        # cache; acceptable because (a) JWKS rotates infrequently and
        # (b) the call path is the SSO callback (low QPS).
        try:
            jwk_client = pyjwt.PyJWKClient(jwks_uri)
            signing_key = jwk_client.get_signing_key_from_jwt(id_token).key
            claims = pyjwt.decode(
                id_token,
                signing_key,
                algorithms=[alg],
                audience=self.client_id,
                issuer=issuer,
                leeway=5,
            )
        except pyjwt.PyJWTError as exc:
            raise OIDCError(f"id_token_verify_failed: {exc}") from exc
        if claims.get("nonce") != expected_nonce:
            raise OIDCError("id_token_nonce_mismatch")
        return claims


# ---------------------------------------------------------------------------
# Provider builder (settings-driven)
# ---------------------------------------------------------------------------


def build_provider(name: str) -> OIDCProvider:
    """Construct an ``OIDCProvider`` for ``name`` from Settings.

    Raises ``OIDCError`` if the provider is not configured.
    """
    settings = get_settings()
    name_lower = name.lower()
    cid = getattr(settings, f"oidc_{name_lower}_client_id", "") or ""
    csec = getattr(settings, f"oidc_{name_lower}_client_secret", "") or ""
    disc = getattr(settings, f"oidc_{name_lower}_discovery_url", "") or ""
    redir = getattr(settings, f"oidc_{name_lower}_redirect_uri", "") or ""
    if not (cid and disc and redir):
        # client_secret may legitimately be empty for public clients but
        # Google's web auth-code+PKCE flow requires it; we don't want to
        # ship a silent misconfig.
        raise OIDCError(f"sso_provider_misconfigured: {name_lower}")
    return OIDCProvider(
        name=name_lower,
        client_id=cid,
        client_secret=csec,
        discovery_url=disc,
        redirect_uri=redir,
    )
