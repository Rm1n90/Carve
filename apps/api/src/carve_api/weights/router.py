import json
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.projects.service import ProjectService
from carve_api.ratelimit import limiter
from carve_api.weights.models import Weight, WeightTaskKind
from carve_api.weights.schemas import WeightOut
from carve_api.weights.service import WeightInvalid, WeightService

router = APIRouter(tags=["weights"])
project_weights_router = APIRouter(prefix="/projects", tags=["weights"])


@router.get("/weights", response_model=list[WeightOut])
def list_workspace_weights(
    user: User = Depends(get_current_user),  # noqa: ARG001 — auth required
    db: Session = Depends(get_db),
) -> list[WeightOut]:
    """List every YOLO custom weight uploaded to this workspace.

    v1 simplification: a single workspace, so no per-workspace filter is
    applied. Returned in newest-first order for display in /models/yolo.
    """
    rows = list(
        db.execute(select(Weight).order_by(Weight.created_at.desc())).scalars()
    )
    return [WeightOut.from_orm_weight(w) for w in rows]


def _http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


@project_weights_router.post(
    "/{project_id}/weights",
    response_model=WeightOut,
    status_code=status.HTTP_201_CREATED,
)
@limiter.limit("30/minute")
async def upload_weight(
    request: Request,
    project_id: uuid.UUID,
    name: str = Form(...),
    task_kind: WeightTaskKind = Form(...),
    # v3.3 (audit issue 3a): optional. Backend now delegates to the model
    # service /yolo/inspect to extract real class names from the .pt; this
    # form value is only used as a fallback when the model service is
    # offline OR didn't return a usable name table. Older clients posting
    # the JSON-encoded array still work unchanged.
    class_names: str | None = Form(
        None,
        description="Optional JSON-encoded list of class names; auto-extracted from the .pt when the model service is reachable",
    ),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WeightOut:
    if class_names is None or class_names == "":
        names: list = []
    else:
        try:
            names = json.loads(class_names)
        except json.JSONDecodeError as exc:
            raise _http(WeightInvalid("class_names must be valid JSON")) from exc
        if not isinstance(names, list):
            raise _http(WeightInvalid("class_names must be a list"))

    body = await file.read()
    project = ProjectService(db).get(actor=user, project_id=project_id)
    try:
        w = WeightService(db).upload(
            project=project,
            name=name,
            task_kind=task_kind,
            class_names=names,
            original_name=file.filename or "",
            body=body,
            actor=user,
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return WeightOut.from_orm_weight(w)


@project_weights_router.get(
    "/{project_id}/weights",
    response_model=list[WeightOut],
)
def list_weights(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[WeightOut]:
    project = ProjectService(db).get(actor=user, project_id=project_id)
    return [WeightOut.from_orm_weight(w) for w in WeightService(db).list_for_project(project=project)]


@router.delete(
    "/weights/{weight_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_weight(
    weight_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    svc = WeightService(db)
    try:
        w = svc.get(weight_id=weight_id)
    except AppError as exc:
        raise _http(exc) from exc
    project = ProjectService(db).get(actor=user, project_id=w.project_id)
    try:
        svc.delete(actor=user, project=project, weight_id=weight_id)
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()


class WeightPatch(BaseModel):
    """Body of `PATCH /weights/{weight_id}`. Only `name` is mutable; the
    file body, `task_kind`, and `class_names` are decided at upload time."""

    name: str = Field(min_length=1, max_length=200)


@router.patch(
    "/weights/{weight_id}",
    response_model=WeightOut,
)
def update_weight(
    weight_id: uuid.UUID,
    payload: WeightPatch,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WeightOut:
    svc = WeightService(db)
    try:
        w = svc.get(weight_id=weight_id)
    except AppError as exc:
        raise _http(exc) from exc
    project = ProjectService(db).get(actor=user, project_id=w.project_id)
    # Reuse the project-modify check used by `delete` to guard the rename.
    from carve_api.projects.service import _can_modify

    if not _can_modify(user, project):
        raise HTTPException(status_code=403, detail="weight_forbidden")
    w.name = payload.name.strip()
    db.flush()
    db.commit()
    return WeightOut.from_orm_weight(w)


@router.post(
    "/weights/{weight_id}/default",
    response_model=WeightOut,
)
def set_weight_default(
    weight_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WeightOut:
    """Mark a weight as the default for its `(project, task_kind)` slot.

    v3.3 Issue 4 — admin-or-owner gated, mirrors the rename guard.
    """
    from carve_api.projects.service import _can_modify

    svc = WeightService(db)
    try:
        w = svc.get(weight_id=weight_id)
    except AppError as exc:
        raise _http(exc) from exc
    project = ProjectService(db).get(actor=user, project_id=w.project_id)
    if not _can_modify(user, project):
        raise HTTPException(status_code=403, detail="weight_forbidden")
    try:
        updated = svc.set_default(weight_id=weight_id, project_id=project.id)
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return WeightOut.from_orm_weight(updated)
