# Armin Mehri — mehri.armin@gmail.com
"""Database backups (superadmin): what is on disk, and "Back up now".

The dumps are written by the ``db-backup`` service into ``./backups``,
which the API sees read-only. The API never runs ``pg_dump`` itself: a
request is a row in ``app_settings`` (``BACKUP_REQUESTED_AT``, not a
setting, so the settings page never lists it) that the backup service
takes off and acts on within 30 seconds (see infra/backup/pg_backup.sh).
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from carve_api.app_settings.models import AppSetting
from carve_api.audit import service as audit_service
from carve_api.audit.actions import BACKUP_REQUESTED
from carve_api.auth.models import User
from carve_api.deps import get_db
from carve_api.permissions import superadmin_guard

router = APIRouter(prefix="/admin/backups", tags=["backups"])

REQUEST_KEY = "BACKUP_REQUESTED_AT"
TIERS = ("daily", "weekly", "monthly")


class BackupFile(BaseModel):
    tier: str
    name: str
    size_bytes: int
    created_at: datetime


class BackupsOut(BaseModel):
    # False when the API cannot see the backups folder (not mounted).
    available: bool
    # A dump is being written right now.
    running: bool
    # "Back up now" was pressed and the backup service has not taken it yet.
    requested_at: datetime | None
    files: list[BackupFile]


def _root() -> Path:
    return Path(os.environ.get("BACKUP_DIR", "/backups"))


def _listing(db: Session) -> BackupsOut:
    root = _root()
    files: list[BackupFile] = []
    running = False
    for tier in TIERS:
        folder = root / tier
        if not folder.is_dir():
            continue
        for f in folder.iterdir():
            if f.name.endswith(".partial"):
                running = True
                continue
            if not f.name.endswith(".sql.gz"):
                continue
            try:
                st = f.stat()
            except OSError:  # pruned while we looked
                continue
            files.append(
                BackupFile(
                    tier=tier,
                    name=f.name,
                    size_bytes=st.st_size,
                    created_at=datetime.fromtimestamp(st.st_mtime, tz=timezone.utc),
                )
            )
    files.sort(key=lambda b: b.created_at, reverse=True)
    request = db.get(AppSetting, REQUEST_KEY)
    return BackupsOut(
        available=root.is_dir(),
        running=running,
        requested_at=request.updated_at if request is not None else None,
        files=files,
    )


@router.get("", response_model=BackupsOut)
def list_backups(_: User = Depends(superadmin_guard), db: Session = Depends(get_db)) -> BackupsOut:
    return _listing(db)


@router.post("/run", response_model=BackupsOut)
def request_backup(
    actor: User = Depends(superadmin_guard), db: Session = Depends(get_db)
) -> BackupsOut:
    """Ask the backup service for a dump now. Pressing it again while one
    is waiting does nothing more."""
    if db.get(AppSetting, REQUEST_KEY) is None:
        db.add(
            AppSetting(
                key=REQUEST_KEY,
                value=datetime.now(timezone.utc).isoformat(),
                encrypted=False,
                updated_by=actor.id,
            )
        )
        audit_service.record(
            db,
            actor_id=actor.id,
            action=BACKUP_REQUESTED,
            target_type="backup",
            target_id=None,
            project_id=None,
            summary="database backup requested",
        )
        db.commit()
    return _listing(db)
