"""App settings — provider keys and runtime settings a superadmin saves in
the app instead of ``.env``.

What matters most: only a superadmin can read or change them, a secret is
stored encrypted and never sent back in full, a saved value takes
precedence over the environment, and clearing it goes back to the
environment.
"""
from __future__ import annotations

import uuid

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import select

from carve_api import config
from carve_api.app_settings import service
from carve_api.app_settings.models import AppSetting
from carve_api.audit.models import AuditEvent
from carve_api.auth.jwt import create_access_token
from carve_api.auth.models import User, UserRole
from carve_api.auth.passwords import hash_password
from carve_api.config import get_settings
from carve_api.deps import get_db
from carve_api.main import create_app

KEY = "sk-proj-abcdefghijklmnop1234"
URL = "/admin/settings"


def _client(db_session) -> TestClient:
    app = create_app()

    def _ov():
        yield db_session

    app.dependency_overrides[get_db] = _ov
    return TestClient(app)


def _mk(db_session, role: UserRole) -> User:
    u = User(
        email=f"{role.value}-{uuid.uuid4().hex[:6]}@settings.example.com",
        password_hash=hash_password("original-pass"),
        role=role,
    )
    db_session.add(u)
    db_session.flush()
    return u


def _hdr(u: User) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(subject=str(u.id), role=u.role.value)}"}


def _item(listing: dict, key: str) -> dict:
    return next(s for s in listing["settings"] if s["key"] == key)


@pytest.fixture(autouse=True)
def _no_model_service(monkeypatch):
    # The listing asks the model service whether it runs with the saved
    # settings; there is none in tests.
    from carve_api.app_settings import router as router_mod

    def down(*_a, **_kw):
        raise httpx.ConnectError("no model service in tests")

    monkeypatch.setattr(router_mod.httpx, "get", down)


@pytest.fixture(autouse=True)
def _fresh_settings(monkeypatch):
    # The last overrides read are kept through a failed read; no test
    # may leave its own behind.
    monkeypatch.setattr(config, "_last_overrides", {})
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_only_a_superadmin_can_see_or_change_settings(db_session) -> None:
    client = _client(db_session)
    for role in (UserRole.admin, UserRole.member, UserRole.viewer):
        h = _hdr(_mk(db_session, role))
        assert client.get(URL, headers=h).status_code == 403
        put = client.put(f"{URL}/OPENAI_API_KEY", json={"value": KEY}, headers=h)
        assert put.status_code == 403
        assert client.delete(f"{URL}/OPENAI_API_KEY", headers=h).status_code == 403
        assert client.post(f"{URL}/OPENAI_API_KEY/test", json={}, headers=h).status_code == 403
    assert client.get(URL).status_code == 401
    assert db_session.scalars(select(AppSetting)).first() is None


def test_a_saved_key_is_encrypted_and_never_sent_back(db_session) -> None:
    sa = _mk(db_session, UserRole.superadmin)
    client = _client(db_session)
    r = client.put(f"{URL}/OPENAI_API_KEY", json={"value": f"  {KEY}\n"}, headers=_hdr(sa))
    assert r.status_code == 200, r.text
    assert KEY not in r.text
    item = _item(r.json(), "OPENAI_API_KEY")
    assert (item["source"], item["hint"], item["value"]) == ("app", "…1234", None)
    assert item["updated_by"] == sa.email

    row = db_session.get(AppSetting, "OPENAI_API_KEY")
    assert row.encrypted and KEY not in row.value
    # Read back (whitespace trimmed) for the overlay.
    assert service.read_overrides(db_session)["openai_api_key"] == KEY
    # The audit trail says what changed, never the key.
    ev = db_session.scalars(select(AuditEvent).where(AuditEvent.action == "setting.updated")).one()
    assert KEY not in str(ev.metadata_) and KEY not in ev.summary
    assert KEY not in client.get(URL, headers=_hdr(sa)).text


def test_plain_settings_are_checked_and_typed(db_session) -> None:
    h = _hdr(_mk(db_session, UserRole.superadmin))
    client = _client(db_session)

    def put(key, value):
        return client.put(f"{URL}/{key}", json={"value": value}, headers=h)

    assert put("LOGO_AI_CONCURRENCY", "8").status_code == 200
    assert put("SAM_COMPILE", True).status_code == 200
    assert put("MEMBERS_LOGO_AI", "opened_tasks").status_code == 200
    assert put("SSO_PROVIDERS", " Google, google ").status_code == 200
    got = service.read_overrides(db_session)
    assert got["logo_ai_concurrency"] == 8
    assert got["members_logo_ai"] == "opened_tasks"
    assert got["sso_providers"] == "google"

    for key, value in [
        ("LOGO_AI_CONCURRENCY", 0), ("LOGO_AI_CONCURRENCY", 2.5), ("LOGO_AI_CONCURRENCY", "x"),
        ("SAM_COMPILE", "maybe"), ("MEMBERS_SAM", "everyone"),
        ("OPENAI_API_KEY", "sk-with space"),
        ("OPENAI_API_KEY", ""), ("SSO_PROVIDERS", "github"),
        ("OIDC_GOOGLE_DISCOVERY_URL", "accounts.google.com"),
    ]:
        r = put(key, value)
        assert r.status_code == 422, (key, value, r.text)
        assert r.json()["error"] == "invalid_setting" and r.json()["message"]
    assert put("LOGO_AI_ALLOW_MEMBERS", True).status_code == 404
    listing = client.get(URL, headers=h).json()
    sam = _item(listing, "MEMBERS_SAM")
    assert sam["group"] == "Member access" and sam["value"] == "opened_tasks"
    assert sam["option_labels"][0] == "Admins only"
    assert _item(listing, "OPENAI_ADMIN_KEY")["links"][0]["url"].startswith(
        "https://platform.openai.com/"
    )
    # Start-up settings cannot be changed here at all.
    for key in ("POSTGRES_PASSWORD", "JWT_SECRET", "PASSWORD_PEPPER", "CARVE_DOMAIN"):
        assert put(key, "x").status_code == 404
    # SSO can be turned off with an empty list.
    assert put("SSO_PROVIDERS", "").status_code == 200
    assert service.read_overrides(db_session)["sso_providers"] == ""


def test_clearing_goes_back_to_the_environment(db_session, monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env-old-expired-9999")
    get_settings.cache_clear()
    h = _hdr(_mk(db_session, UserRole.superadmin))
    client = _client(db_session)
    before = _item(client.get(URL, headers=h).json(), "OPENAI_API_KEY")
    assert (before["source"], before["hint"], before["env_set"]) == ("env", "…9999", True)

    client.put(f"{URL}/OPENAI_API_KEY", json={"value": KEY}, headers=h)
    after = _item(client.get(URL, headers=h).json(), "OPENAI_API_KEY")
    assert (after["source"], after["hint"], after["env_hint"]) == ("app", "…1234", "…9999")

    cleared = _item(client.delete(f"{URL}/OPENAI_API_KEY", headers=h).json(), "OPENAI_API_KEY")
    assert (cleared["source"], cleared["hint"]) == ("env", "…9999")
    assert db_session.get(AppSetting, "OPENAI_API_KEY") is None
    # A setting never saved is fine to clear.
    assert client.delete(f"{URL}/LOGO_AI_CONCURRENCY", headers=h).status_code == 200


def test_saved_values_take_precedence_over_the_environment(monkeypatch) -> None:
    from carve_api.logo_ai.providers import api_key_for

    monkeypatch.setenv("OPENAI_API_KEY", "sk-env-old-expired-9999")
    reads = iter([{"openai_api_key": KEY, "logo_ai_concurrency": 9}])
    monkeypatch.setattr(service, "read_overrides", lambda: next(reads))
    get_settings.cache_clear()
    assert api_key_for("openai") == KEY
    assert get_settings().logo_ai_concurrency == 9

    # A failed read (database blip) keeps the last values in force rather
    # than falling back to the old key in the environment.
    def broken():
        raise RuntimeError("db down")

    monkeypatch.setattr(service, "read_overrides", broken)
    get_settings.cache_clear()
    assert api_key_for("openai") == KEY


def test_a_secret_that_cannot_be_decrypted_is_ignored_and_flagged(db_session) -> None:
    db_session.add(AppSetting(
        key="GEMINI_API_KEY", encrypted=True,
        value=Fernet(Fernet.generate_key()).encrypt(b"AIza-other-pepper").decode(),
    ))
    db_session.flush()
    assert "gemini_api_key" not in service.read_overrides(db_session)
    item = next(s for s in service.describe(db_session) if s["key"] == "GEMINI_API_KEY")
    assert item["unreadable"] is True and item["source"] != "app"


def test_the_startup_list_says_only_whether_each_is_set(db_session) -> None:
    h = _hdr(_mk(db_session, UserRole.superadmin))
    listing = _client(db_session).get(URL, headers=h).json()
    startup = {s["key"]: s for s in listing["startup"]}
    assert startup["JWT_SECRET"]["set"] is True and startup["JWT_SECRET"]["secret"] is True
    assert "j" * 64 not in str(listing)
    assert set(startup["POSTGRES_PASSWORD"]) == {"key", "label", "secret", "set"}


def test_a_key_test_asks_the_provider_and_hides_the_key() -> None:
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.headers.get("authorization") == f"Bearer {KEY}":
            return httpx.Response(200, json={"data": []})
        return httpx.Response(401, json={"error": {
            "message": f"Incorrect API key provided: {request.headers['authorization'][7:]}"}})

    transport = httpx.MockTransport(handler)
    ok = service.check_key("OPENAI_API_KEY", KEY, transport=transport)
    assert ok == {"ok": True, "message": "OpenAI accepted the key."}
    assert str(seen[0].url) == "https://api.openai.com/v1/models"

    bad = service.check_key("OPENAI_API_KEY", "sk-wrong-key-0000", transport=transport)
    assert bad["ok"] is False and "HTTP 401" in bad["message"]
    assert "sk-wrong-key-0000" not in bad["message"]

    with pytest.raises(service.SettingError):
        service.check_key("LOGO_AI_CONCURRENCY", "4")


def test_model_service_settings_are_served_to_it_with_a_token(db_session, monkeypatch) -> None:
    sa = _mk(db_session, UserRole.superadmin)
    client = _client(db_session)
    h = _hdr(sa)
    assert client.put(f"{URL}/SAM_DTYPE", json={"value": "fp16"}, headers=h).status_code == 200
    assert client.put(f"{URL}/SAM_GPU_ID", json={"value": "0"}, headers=h).status_code == 200
    assert client.put(f"{URL}/SAM_COMPILE", json={"value": False}, headers=h).status_code == 200
    hf = client.put(f"{URL}/HF_TOKEN", json={"value": "hf_abcdefghijklmnop"}, headers=h)
    assert hf.status_code == 200
    assert client.put(f"{URL}/SAM_DTYPE", json={"value": "fp8"}, headers=h).status_code == 422
    # API settings never go to the model service.
    client.put(f"{URL}/LOGO_AI_CONCURRENCY", json={"value": 3}, headers=h)

    url = "/internal/service-settings/model"
    assert client.get(url).status_code == 403
    assert client.get(url, headers={"X-Carve-Service-Token": "wrong"}).status_code == 403
    r = client.get(url, headers={"X-Carve-Service-Token": service.service_token()})
    assert r.status_code == 200, r.text
    assert r.json()["env"] == {
        "SAM_DTYPE": "fp16", "CUDA_VISIBLE_DEVICES": "0", "SAM_COMPILE": "false",
        "HF_TOKEN": "hf_abcdefghijklmnop",
    }
    assert r.json()["version"] == service.settings_version(r.json()["env"])
    other = client.get("/internal/service-settings/backup",
                       headers={"X-Carve-Service-Token": service.service_token()})
    assert other.status_code == 404


def test_the_page_says_when_the_model_service_needs_a_restart(db_session, monkeypatch) -> None:
    from carve_api.app_settings import router as router_mod

    h = _hdr(_mk(db_session, UserRole.superadmin))
    client = _client(db_session)
    running = {"v": ""}
    monkeypatch.setattr(router_mod.httpx, "get", lambda *a, **kw: httpx.Response(
        200, json={"status": "ok", "settings_version": running["v"]}))
    listing = client.get(URL, headers=h).json()
    assert listing["services"]["model"]["reachable"] is True
    saved = client.put(f"{URL}/SAM_MODEL", json={"value": "sam2.1-large"}, headers=h).json()
    assert saved["services"]["model"]["pending_restart"] is True
    # The SAM variant at start also tells the API what the model loads.
    assert service.read_overrides(db_session)["sam_model"] == "sam2.1-large"
    running["v"] = service.settings_version(service.service_env("model", db_session))
    assert client.get(URL, headers=h).json()["services"]["model"]["pending_restart"] is False

    calls = []

    def post(url, headers, timeout):
        calls.append((url, headers))
        return httpx.Response(200, json={"restarting": True})

    monkeypatch.setattr(router_mod.httpx, "post", post)
    r = client.post(f"{URL}/services/model/restart", headers=h)
    assert r.status_code == 200
    assert calls[0][0].endswith("/system/restart")
    assert calls[0][1] == {"X-Carve-Service-Token": service.service_token()}
    member = _hdr(_mk(db_session, UserRole.admin))
    assert client.post(f"{URL}/services/model/restart", headers=member).status_code == 403


def test_allowed_origins_follow_the_saved_setting(monkeypatch) -> None:
    reads = {"v": {}}
    monkeypatch.setattr(service, "read_overrides", lambda: reads["v"])
    get_settings.cache_clear()
    client = TestClient(create_app())
    pre = {"Origin": "https://tools.example.com", "Access-Control-Request-Method": "GET"}
    assert client.options("/health", headers=pre).status_code == 400
    reads["v"] = {"cors_origins": "https://tools.example.com"}
    get_settings.cache_clear()
    r = client.options("/health", headers=pre)
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "https://tools.example.com"


def test_callers_never_wait_for_a_refresh(monkeypatch) -> None:
    import threading

    gate = threading.Event()
    values = iter([{"logo_ai_concurrency": 5}, {"logo_ai_concurrency": 6}])

    def slow_read():
        value = next(values)
        if value["logo_ai_concurrency"] == 6:
            gate.wait(5)
        return value

    monkeypatch.setattr(service, "read_overrides", slow_read)
    monkeypatch.setattr(config, "OVERRIDES_TTL_SECONDS", 0.0)
    get_settings.cache_clear()
    assert get_settings().logo_ai_concurrency == 5  # the first call reads
    # Stale now: the value in hand comes back at once while a background
    # thread reads (and is held up here).
    assert get_settings().logo_ai_concurrency == 5
    gate.set()
    for _ in range(100):
        if config._cached and config._cached[1].logo_ai_concurrency == 6:
            break
        threading.Event().wait(0.02)
    assert get_settings().logo_ai_concurrency == 6
