# Armin Mehri — mehri.armin@gmail.com
"""Superadmin-only HTTP surface for app settings.

* ``GET    /admin/settings``            — every setting, where its value
  comes from, and the start-up variables that stay in ``.env``.
* ``PUT    /admin/settings/{key}``      — save a value (it takes
  precedence over ``.env``).
* ``DELETE /admin/settings/{key}``      — clear it (``.env`` applies again).
* ``POST   /admin/settings/{key}/test`` — ask the provider whether a key
  works, with a free request.
* ``POST   /admin/settings/services/model/restart`` — restart the model
  service so it starts with the saved settings.
* ``GET    /internal/service-settings/{service}`` — what the model service
  reads when it starts (service token, not a user's).

A saved API or worker value reaches every process within
``OVERRIDES_TTL_SECONDS``, without a restart.
"""
import hmac
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from carve_api.app_settings import service
from carve_api.app_settings.registry import MODEL
from carve_api.auth.models import User
from carve_api.config import OVERRIDES_TTL_SECONDS, get_settings
from carve_api.deps import get_db
from carve_api.permissions import superadmin_guard

router = APIRouter(prefix="/admin/settings", tags=["admin"])
internal_router = APIRouter(prefix="/internal", tags=["internal"])


class SettingValueIn(BaseModel):
    value: Any = None


class KeyTestIn(BaseModel):
    # A key typed but not saved yet; omitted: the key in use.
    value: str | None = None


def _invalid(exc: service.SettingError) -> HTTPException:
    return HTTPException(status_code=422, detail={"error": "invalid_setting", "message": str(exc)})


def _unknown(key: str) -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={"error": "unknown_setting", "message": f"{key} cannot be changed in the app."},
    )


def _model_status(db: Session) -> dict[str, Any]:
    """Whether the model service is up and runs with the saved settings."""
    want = service.settings_version(service.service_env(MODEL, db))
    try:
        r = httpx.get(f"{get_settings().model_base_url.rstrip('/')}/health", timeout=2)
        running = r.json().get("settings_version") if r.status_code == 200 else None
        reachable = r.status_code == 200
    except (httpx.HTTPError, ValueError):
        running, reachable = None, False
    return {"reachable": reachable, "pending_restart": reachable and running != want}


def _listing(db: Session) -> dict[str, Any]:
    return {
        "settings": service.describe(db),
        "startup": service.startup_status(),
        "applies_within_seconds": OVERRIDES_TTL_SECONDS,
        "services": {MODEL: _model_status(db)},
    }


@router.get("")
def list_settings(
    _: User = Depends(superadmin_guard), db: Session = Depends(get_db)
) -> dict[str, Any]:
    return _listing(db)


@router.put("/{key}")
def save_setting(
    key: str,
    payload: SettingValueIn,
    actor: User = Depends(superadmin_guard),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    try:
        service.save(db, key, payload.value, actor)
    except KeyError:
        raise _unknown(key) from None
    except service.SettingError as exc:
        raise _invalid(exc) from None
    db.commit()
    get_settings.cache_clear()
    return _listing(db)


@router.delete("/{key}")
def clear_setting(
    key: str, actor: User = Depends(superadmin_guard), db: Session = Depends(get_db)
) -> dict[str, Any]:
    try:
        service.clear(db, key, actor)
    except KeyError:
        raise _unknown(key) from None
    db.commit()
    get_settings.cache_clear()
    return _listing(db)


@router.post("/{key}/test")
def test_setting(
    key: str, payload: KeyTestIn, _: User = Depends(superadmin_guard)
) -> dict[str, Any]:
    try:
        return service.check_key(key, payload.value)
    except KeyError:
        raise _unknown(key) from None
    except service.SettingError as exc:
        raise _invalid(exc) from None


@router.post("/services/model/restart")
def restart_model_service(
    _: User = Depends(superadmin_guard), db: Session = Depends(get_db)
) -> dict[str, Any]:
    """The model service exits and Docker starts it again; on start it
    reads the saved settings. Requests in flight are retried by the API."""
    try:
        r = httpx.post(
            f"{get_settings().model_base_url.rstrip('/')}/system/restart",
            headers={"X-Carve-Service-Token": service.service_token()},
            timeout=10,
        )
    except httpx.HTTPError:
        raise HTTPException(
            status_code=503,
            detail={"error": "model_unreachable", "message": "The model service is not running."},
        ) from None
    if r.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail={"error": "model_restart_failed",
                    "message": f"The model service refused the restart (HTTP {r.status_code})."},
        )
    return _listing(db)


@internal_router.get("/service-settings/{service_name}")
def service_settings(
    service_name: str,
    x_carve_service_token: str = Header(default=""),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    if not hmac.compare_digest(x_carve_service_token, service.service_token()):
        raise HTTPException(status_code=403, detail={"error": "forbidden"})
    if service_name != MODEL:
        raise HTTPException(status_code=404, detail={"error": "unknown_service"})
    env = service.service_env(service_name, db)
    return {"env": env, "version": service.settings_version(env)}
