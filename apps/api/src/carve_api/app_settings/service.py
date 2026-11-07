# Armin Mehri — mehri.armin@gmail.com
"""Reading, checking, encrypting and saving app settings.

Secrets are encrypted with a key derived from ``PASSWORD_PEPPER``: it
never changes (changing it would already invalidate every password), so
the saved secrets stay readable, and a database dump or backup alone
does not reveal them.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import math
import os
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

import httpx
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.app_settings.models import AppSetting
from carve_api.app_settings.registry import (
    API,
    BOOL,
    BY_KEY,
    CHOICE,
    FLOAT,
    INT,
    SECRET,
    SETTINGS,
    STARTUP,
    TEXT,
    URL,
    SettingDef,
)
from carve_api.audit import actions
from carve_api.audit.service import record as audit_record
from carve_api.auth.models import User
from carve_api.config import get_env_settings, get_settings

log = logging.getLogger(__name__)

SOURCE_APP = "app"
SOURCE_ENV = "env"
SOURCE_DEFAULT = "default"

_MAX_SECRET = 4096
_MAX_TEXT = 2000


class SettingError(ValueError):
    """A value the setting does not accept; the message is for the user."""


def _fernet() -> Fernet:
    pepper = get_env_settings().password_pepper.encode()
    key = HKDF(
        algorithm=hashes.SHA256(), length=32, salt=None, info=b"carve app_settings v1"
    ).derive(pepper)
    return Fernet(base64.urlsafe_b64encode(key))


# --- checking -----------------------------------------------------------------


def parse(d: SettingDef, raw: Any) -> Any:
    """The value ``raw`` stands for, typed for ``Settings``, or
    :class:`SettingError` saying why it is not accepted."""
    if d.kind == BOOL:
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, str) and raw.strip().lower() in ("true", "false"):
            return raw.strip().lower() == "true"
        raise SettingError("Choose on or off.")
    if d.kind in (INT, FLOAT):
        if isinstance(raw, bool) or not isinstance(raw, int | float | str):
            raise SettingError("Enter a number.")
        try:
            num = int(raw) if d.kind == INT and not isinstance(raw, float) else float(raw)
        except ValueError:
            msg = "Enter a whole number." if d.kind == INT else "Enter a number."
            raise SettingError(msg) from None
        if d.kind == INT and isinstance(num, float):
            if not num.is_integer():
                raise SettingError("Enter a whole number.")
            num = int(num)
        if not math.isfinite(num):
            raise SettingError("Enter a number.")
        if d.minimum is not None and num < d.minimum or d.maximum is not None and num > d.maximum:
            raise SettingError(f"Enter a value from {_num(d.minimum)} to {_num(d.maximum)}.")
        return num
    if not isinstance(raw, str):
        raise SettingError("Enter text.")
    value = raw.strip()
    if d.kind == CHOICE:
        if value not in d.options:
            raise SettingError(f"Choose one of: {', '.join(d.options)}.")
        return value
    if not value:
        if d.allow_empty:
            return ""
        raise SettingError("Enter a value, or use Clear to go back to the .env value.")
    if d.kind == SECRET:
        if len(value) > _MAX_SECRET:
            raise SettingError("That is too long for a key.")
        if any(c.isspace() for c in value):
            raise SettingError("A key has no spaces or line breaks; check what was pasted.")
        return value
    if len(value) > _MAX_TEXT:
        raise SettingError("That is too long.")
    if d.kind == URL:
        u = urlparse(value)
        if u.scheme not in ("http", "https") or not u.netloc:
            raise SettingError("Enter a full URL starting with https://.")
        return value
    if d.kind == TEXT and d.choices:
        items = list(dict.fromkeys(p.strip().lower() for p in value.split(",") if p.strip()))
        unknown = [p for p in items if p not in d.choices]
        if unknown:
            raise SettingError(
                f"Unknown: {', '.join(unknown)}. Choose from {', '.join(d.choices)}."
            )
        return ",".join(items)
    return value


def _num(x: float | None) -> str:
    return "" if x is None else f"{x:,.0f}" if float(x).is_integer() else f"{x:g}"


# --- storage ------------------------------------------------------------------


def _encode(d: SettingDef, value: Any) -> tuple[str, bool]:
    if d.kind == SECRET:
        return _fernet().encrypt(value.encode()).decode(), True
    return json.dumps(value), False


def _decode(d: SettingDef, stored: str, encrypted: bool) -> Any:
    """The saved value, or ``ValueError`` when it cannot be read back."""
    try:
        raw = _fernet().decrypt(stored.encode()).decode() if encrypted else json.loads(stored)
    except (InvalidToken, ValueError) as exc:
        raise ValueError(f"unreadable {d.key}") from exc
    return parse(d, raw)


def read_overrides(session: Session | None = None) -> dict[str, Any]:
    """``Settings`` attribute → saved value, for every saved setting that
    can be read back. One that cannot (e.g. encrypted under a different
    pepper) is left out, so the environment's value applies."""
    query = select(AppSetting.key, AppSetting.value, AppSetting.encrypted)
    if session is not None:
        rows = session.execute(query).all()
    else:
        from carve_api.db import get_engine

        with get_engine().connect() as conn:
            rows = conn.execute(query).all()
    out: dict[str, Any] = {}
    for key, stored, encrypted in rows:
        d = BY_KEY.get(key)
        if d is None or d.field is None:
            continue
        try:
            out[d.field] = _decode(d, stored, encrypted)
        except ValueError:
            log.warning("app_settings.unreadable key=%s", key)
    return out


def _env_value(d: SettingDef) -> tuple[Any, str]:
    raw = os.environ.get(d.key, "")
    source = SOURCE_ENV if raw != "" else SOURCE_DEFAULT
    if d.field is not None:
        return getattr(get_env_settings(), d.field), source
    # Another service's setting: the API is given the same variable (see
    # docker-compose.yml) so the page can show what that service runs with.
    if raw == "" or d.kind == SECRET:
        return raw, source
    try:
        return parse(d, raw), source
    except SettingError:
        return raw, source


def _mask(secret: str) -> str:
    return f"…{secret[-4:]}" if len(secret) >= 12 else "set"


def describe(db: Session) -> list[dict[str, Any]]:
    """Every setting as the page shows it. Secrets only as their last
    four characters."""
    rows = {r.key: r for r in db.scalars(select(AppSetting))}
    emails = dict(
        db.execute(
            select(User.id, User.email).where(
                User.id.in_([r.updated_by for r in rows.values() if r.updated_by])
            )
        ).all()
    ) if rows else {}
    out = []
    for d in SETTINGS:
        row = rows.get(d.key)
        env_value, env_source = _env_value(d)
        value, source, unreadable = env_value, env_source, False
        if row is not None:
            try:
                value, source = _decode(d, row.value, row.encrypted), SOURCE_APP
            except ValueError:
                unreadable = True
        item: dict[str, Any] = {
            "key": d.key,
            "group": d.group,
            "label": d.label,
            "help": d.help,
            "kind": d.kind,
            "minimum": d.minimum,
            "maximum": d.maximum,
            "unit": d.unit,
            "choices": list(d.choices),
            "allow_empty": d.allow_empty,
            "testable": d.test_provider is not None,
            "service": d.service,
            "options": list(d.options),
            "option_labels": list(d.option_labels),
            "links": [{"label": label, "url": url} for label, url in d.links],
            "source": source,
            "env_set": env_source == SOURCE_ENV,
            "unreadable": unreadable,
            "updated_at": row.updated_at if row is not None else None,
            "updated_by": emails.get(row.updated_by) if row is not None else None,
        }
        if d.kind == SECRET:
            item["value"] = None
            item["hint"] = _mask(value) if value else None
            item["env_hint"] = _mask(env_value) if env_value else None
        else:
            item["value"] = value
            item["hint"] = None
            item["env_hint"] = None
        out.append(item)
    return out


def startup_status() -> list[dict[str, Any]]:
    """The start-up variables, whether each is set (never the value)."""
    return [
        {"key": k, "label": label, "secret": secret, "set": os.environ.get(k, "") != ""}
        for k, label, secret in STARTUP
    ]


def _as_env(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def service_env(service: str, session: Session) -> dict[str, str]:
    """The variables another service is to run with, from the values
    saved for it: what it puts into its environment when it starts."""
    rows = session.execute(select(AppSetting.key, AppSetting.value, AppSetting.encrypted)).all()
    out: dict[str, str] = {}
    for key, stored, encrypted in rows:
        d = BY_KEY.get(key)
        if d is None or d.service != service or d.service == API:
            continue
        try:
            out[d.target_env] = _as_env(_decode(d, stored, encrypted))
        except ValueError:
            log.warning("app_settings.unreadable key=%s", key)
    return out


def settings_version(env: dict[str, str]) -> str:
    """A short fingerprint of a service's saved variables, so the page
    can tell whether the running service has the latest ones."""
    blob = json.dumps(sorted(env.items())).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


def service_token() -> str:
    """Shared by the API and the model service, which both hold the
    storage password; nothing else on the network does."""
    secret = get_env_settings().minio_root_password.encode()
    return hmac.new(secret, b"carve service settings v1", hashlib.sha256).hexdigest()


def _definition(key: str) -> SettingDef:
    d = BY_KEY.get(key)
    if d is None:
        raise KeyError(key)
    return d


def save(db: Session, key: str, raw: Any, actor: User) -> None:
    """Check and store one value. The caller commits, then calls
    ``get_settings.cache_clear()``."""
    d = _definition(key)
    value = parse(d, raw)
    stored, encrypted = _encode(d, value)
    row = db.get(AppSetting, key)
    if row is None:
        row = AppSetting(key=key, value=stored, encrypted=encrypted)
        db.add(row)
    row.value, row.encrypted = stored, encrypted
    row.updated_by, row.updated_at = actor.id, datetime.now(UTC)
    db.flush()
    audit_record(
        db, actor_id=actor.id, action=actions.SETTING_UPDATED, target_type="setting",
        target_id=None, project_id=None, summary=f"Changed {d.label}",
        metadata={"key": key} if d.kind == SECRET else {"key": key, "value": value},
    )


def clear(db: Session, key: str, actor: User) -> None:
    """Remove the saved value: the environment's applies again."""
    d = _definition(key)
    row = db.get(AppSetting, key)
    if row is None:
        return
    db.delete(row)
    db.flush()
    audit_record(
        db, actor_id=actor.id, action=actions.SETTING_CLEARED, target_type="setting",
        target_id=None, project_id=None, summary=f"Cleared {d.label} (back to .env)",
        metadata={"key": key},
    )


# --- checking a provider key -------------------------------------------------

# Listing models is free with every provider and needs a valid key.
_KEY_CHECKS: dict[str, tuple[str, str, Any]] = {
    "openai": ("OpenAI", "https://api.openai.com/v1/models",
               lambda k: {"Authorization": f"Bearer {k}"}),
    "anthropic": ("Anthropic", "https://api.anthropic.com/v1/models?limit=1",
                  lambda k: {"x-api-key": k, "anthropic-version": "2023-06-01"}),
    "gemini": ("Google", "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
               lambda k: {"x-goog-api-key": k}),
}


def check_key(key: str, value: str | None, *, transport: httpx.BaseTransport | None = None
              ) -> dict[str, Any]:
    """Ask the provider whether a key works, with a free request. ``value``
    is a key typed but not saved yet; ``None`` checks the one in use."""
    d = _definition(key)
    if d.test_provider is None:
        raise SettingError("This setting cannot be tested.")
    secret = parse(d, value) if value is not None else getattr(get_settings(), d.field)
    if not secret:
        raise SettingError("There is no key to test.")
    name, url, headers = _KEY_CHECKS[d.test_provider]
    try:
        with httpx.Client(timeout=15, transport=transport) as client:
            r = client.get(url, headers=headers(secret))
    except httpx.HTTPError as exc:
        return {"ok": False, "message": f"Could not reach {name} ({type(exc).__name__})."}
    if r.status_code == 200:
        return {"ok": True, "message": f"{name} accepted the key."}
    try:
        body = r.json()
        err = body.get("error") if isinstance(body, dict) else None
        detail = (err.get("message") if isinstance(err, dict) else None) or ""
    except ValueError:
        detail = ""
    detail = detail.replace(secret, "***")[:300]
    return {"ok": False, "message": f"{name} refused the key (HTTP {r.status_code})"
            + (f": {detail}" if detail else ".")}

