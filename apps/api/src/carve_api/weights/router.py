import json
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.projects.models import Class
from carve_api.projects.service import ProjectService, TaskService, require_visible_task
from carve_api.ratelimit import limiter
from carve_api.weights.models import Weight, WeightTaskKind
from carve_api.weights.schemas import (
    WeightAssignmentCreate,
    WeightAssignmentOut,
    WeightOut,
)
from carve_api.weights.service import WeightInvalid, WeightService

router = APIRouter(tags=["weights"])
project_weights_router = APIRouter(prefix="/projects", tags=["weights"])


@router.get("/weights", response_model=list[WeightOut])
def list_workspace_weights(
    user: User = Depends(get_current_user),  # noqa: ARG001 — auth required
    db: Session = Depends(get_db),
) -> list[WeightOut]:
    """List every YOLO custom weight uploaded to this workspace.

    v3.5 Phase F5 — workspace listing has no project context, so the
    ``is_default`` flag on each row is always ``false``. Per-project
    default mappings are surfaced by the project-scoped listing.
    """
    rows = list(
        db.execute(select(Weight).order_by(Weight.created_at.desc())).scalars()
    )
    return [WeightOut.from_orm_weight(w) for w in rows]


@router.post(
    "/weights",
    response_model=WeightOut,
    status_code=status.HTTP_201_CREATED,
)
@limiter.limit("30/minute")
async def upload_workspace_weight(
    request: Request,  # noqa: ARG001 — required by slowapi limiter
    name: str = Form(...),
    task_kind: WeightTaskKind = Form(...),
    class_names: str | None = Form(
        None,
        description="Optional JSON-encoded list of class names; auto-extracted from the .pt when the model service is reachable",
    ),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WeightOut:
    """Upload a workspace-wide weight (``project_id = NULL``).

    v3.5 Phase F5 — the new default upload path. The weight is visible
    from every project in the workspace; the user can pin it as a
    project default via ``POST /weights/{wid}/default`` when desired.
    """
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
    try:
        w = WeightService(db).upload(
            project=None,
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
    """List every weight visible from ``project_id``.

    v3.5 Phase F5 — returns workspace-wide weights (``project_id IS
    NULL``) and project-scoped weights (``project_id == project_id``).
    The ``is_default`` flag on each row reflects the project's defaults
    in ``weight_project_defaults`` for the matching ``task_kind``.
    """
    project = ProjectService(db).get(actor=user, project_id=project_id)
    svc = WeightService(db)
    weights = svc.list_for_project(project=project)
    defaults_by_kind = svc.list_default_weight_ids_for_project(
        project_id=project.id
    )
    out: list[WeightOut] = []
    for w in weights:
        is_default = defaults_by_kind.get(w.task_kind.value) == w.id
        out.append(WeightOut.from_orm_weight(w, is_default=is_default))
    return out


def _weight_can_modify(user: User, w: Weight, db: Session) -> bool:
    """Permission check for delete / rename on a weight.

    Workspace-wide weights (``project_id IS NULL``) require admin role.
    Project-scoped weights use the existing per-project owner/admin
    gate. Centralising the rule here so the router endpoints don't
    drift apart.
    """
    from carve_api.auth.models import UserRole
    from carve_api.projects.service import _can_modify

    if w.project_id is None:
        return user.role == UserRole.admin
    project = ProjectService(db).get(actor=user, project_id=w.project_id)
    return _can_modify(user, project)


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
    if not _weight_can_modify(user, w, db):
        raise HTTPException(status_code=403, detail="weight_forbidden")
    try:
        svc.delete(weight_id=weight_id)
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
    if not _weight_can_modify(user, w, db):
        raise HTTPException(status_code=403, detail="weight_forbidden")
    w.name = payload.name.strip()
    db.flush()
    db.commit()
    return WeightOut.from_orm_weight(w)


# ---------------------------------------------------------------------------
# v3.5 Phase F1 — predict-time class mapping suggestions (read-only)
# ---------------------------------------------------------------------------


class MappingSuggestionAlternative(BaseModel):
    """A single project class option (used for the dropdown in the UI)."""

    id: str
    name: str


class MappingSuggestion(BaseModel):
    """One suggestion per weight class for a given task.

    ``suggested_project_class_id`` is filled by case-insensitive name match
    against the task's effective allowed classes; null when no project class
    has the same name. ``alternatives`` lists every option the user can
    choose from in the predict popover (always the task's allowed classes).
    """

    weight_class_idx: int
    weight_class_name: str
    suggested_project_class_id: str | None
    alternatives: list[MappingSuggestionAlternative]


class MappingSuggestionsOut(BaseModel):
    suggestions: list[MappingSuggestion]


@router.get(
    "/weights/{weight_id}/mapping-suggestions",
    response_model=MappingSuggestionsOut,
)
def mapping_suggestions(
    weight_id: uuid.UUID,
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MappingSuggestionsOut:
    """Suggest how to map this weight's classes to the task's allowed classes.

    Auto-name-match (case-insensitive). Returns one entry per weight class
    with the suggested project class id (or ``null`` when no name match
    exists) and the full list of alternatives the user can pick from in
    the predict popover. Read-only — no DB writes.

    v3.5 Phase F replaces the persistent ``weight_class_mappings`` table
    with this transient helper because mapping is intrinsically per-task,
    not per-weight (one weight can be predicted into many tasks, each with
    its own ``allowed_class_ids``).
    """
    weight = db.get(Weight, weight_id)
    if weight is None:
        raise HTTPException(status_code=404, detail="weight_not_found")
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    project = ProjectService(db).get(actor=user, project_id=task.project_id)
    project_classes, _allowed = TaskService(db).get_effective_classes(
        project=project, task=task
    )
    by_lower_name: dict[str, Class] = {c.name.lower(): c for c in project_classes}

    suggestions: list[MappingSuggestion] = []
    for idx, raw_name in enumerate(weight.class_names or []):
        name = str(raw_name)
        match = by_lower_name.get(name.lower())
        suggestions.append(
            MappingSuggestion(
                weight_class_idx=idx,
                weight_class_name=name,
                suggested_project_class_id=str(match.id) if match else None,
                alternatives=[
                    MappingSuggestionAlternative(id=str(c.id), name=c.name)
                    for c in project_classes
                ],
            )
        )
    return MappingSuggestionsOut(suggestions=suggestions)


class SetDefaultIn(BaseModel):
    """Body for ``POST /weights/{wid}/default`` (v3.5 Phase F5).

    The default is per-(project, task_kind), not per-weight. The user
    must specify which project + task_kind slot to pin this weight to.
    """

    project_id: uuid.UUID
    task_kind: WeightTaskKind


@router.post(
    "/weights/{weight_id}/default",
    response_model=WeightOut,
)
def set_weight_default(
    weight_id: uuid.UUID,
    payload: SetDefaultIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WeightOut:
    """Pin a weight as the default for ``(project_id, task_kind)``.

    v3.5 Phase F5 — writes to ``weight_project_defaults``. The
    ``payload.task_kind`` must match the weight's own ``task_kind``;
    the weight must be visible from the target project (workspace-wide
    or scoped to that same project).
    """
    from carve_api.projects.service import _can_modify

    svc = WeightService(db)
    try:
        w = svc.get(weight_id=weight_id)
    except AppError as exc:
        raise _http(exc) from exc
    # Permission check uses the *target* project, not the weight's
    # project, because workspace weights have no project_id of their
    # own. Owner/admin of the target project may pin any visible weight.
    project = ProjectService(db).get(actor=user, project_id=payload.project_id)
    if not _can_modify(user, project):
        raise HTTPException(status_code=403, detail="weight_forbidden")
    try:
        updated = svc.set_default(
            weight_id=weight_id,
            project_id=payload.project_id,
            task_kind=payload.task_kind,
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return WeightOut.from_orm_weight(updated, is_default=True)


# ---------------------------------------------------------------------------
# v3.7 Phase 3 Issue 4 — many-to-many weight ↔ project assignments
# ---------------------------------------------------------------------------


@router.get(
    "/weights/{weight_id}/assignments",
    response_model=list[WeightAssignmentOut],
)
def list_weight_assignments(
    weight_id: uuid.UUID,
    user: User = Depends(get_current_user),  # noqa: ARG001 — auth required
    db: Session = Depends(get_db),
) -> list[WeightAssignmentOut]:
    """List every project the weight is assigned to.

    v3.7 Phase 3 Issue 4 — read-only view of ``weight_assignments``
    rows joined to ``projects.name`` for UI convenience. Auth required;
    no further gating because membership is not sensitive (the weight
    is already visible workspace-wide via the listing endpoints).
    """
    svc = WeightService(db)
    try:
        svc.get(weight_id=weight_id)
    except AppError as exc:
        raise _http(exc) from exc
    rows = svc.list_assignments(weight_id=weight_id)
    return [
        WeightAssignmentOut(
            weight_id=row.weight_id,
            project_id=row.project_id,
            project_name=project_name,
            created_at=row.created_at,
        )
        for row, project_name in rows
    ]


@router.post(
    "/weights/{weight_id}/assignments",
    response_model=WeightAssignmentOut,
    status_code=status.HTTP_201_CREATED,
)
def add_weight_assignment(
    weight_id: uuid.UUID,
    payload: WeightAssignmentCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WeightAssignmentOut:
    """Assign ``weight_id`` to a project. Idempotent.

    v3.7 Phase 3 Issue 4 — re-posting an existing (weight, project)
    pair returns the existing row with HTTP 201 (the resource is
    "present" either way). The caller must be admin or the target
    project's owner; same gate as ``set_weight_default``.
    """
    from carve_api.projects.models import Project as _Project
    from carve_api.projects.service import _can_modify

    svc = WeightService(db)
    try:
        svc.get(weight_id=weight_id)
    except AppError as exc:
        raise _http(exc) from exc

    project = ProjectService(db).get(actor=user, project_id=payload.project_id)
    if not _can_modify(user, project):
        raise HTTPException(status_code=403, detail="weight_forbidden")

    row = svc.add_assignment(weight_id=weight_id, project_id=payload.project_id)
    db.commit()

    project_name = db.execute(
        select(_Project.name).where(_Project.id == row.project_id)
    ).scalar_one()
    return WeightAssignmentOut(
        weight_id=row.weight_id,
        project_id=row.project_id,
        project_name=project_name,
        created_at=row.created_at,
    )


@router.delete(
    "/weights/{weight_id}/assignments/{project_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_weight_assignment(
    weight_id: uuid.UUID,
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Remove the (weight, project) assignment if present. Idempotent.

    v3.7 Phase 3 Issue 4 — same admin-or-owner gate as ``add_weight_assignment``.
    A missing row is a no-op (still returns 204).
    """
    from carve_api.projects.service import _can_modify

    svc = WeightService(db)
    try:
        svc.get(weight_id=weight_id)
    except AppError as exc:
        raise _http(exc) from exc
    project = ProjectService(db).get(actor=user, project_id=project_id)
    if not _can_modify(user, project):
        raise HTTPException(status_code=403, detail="weight_forbidden")
    svc.remove_assignment(weight_id=weight_id, project_id=project_id)
    db.commit()
