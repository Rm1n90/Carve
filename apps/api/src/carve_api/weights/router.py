import json
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.annotations.router import _require_visible_task
from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.projects.models import Class
from carve_api.projects.service import ProjectService, TaskService
from carve_api.ratelimit import limiter
from carve_api.weights.models import Weight, WeightClassMapping, WeightTaskKind
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


# ---------------------------------------------------------------------------
# v3.3 Issue 3c — class-mapping CRUD
# ---------------------------------------------------------------------------


class WeightClassMappingOut(BaseModel):
    """Single ``weight_class_mappings`` row, exposed to the client.

    The frontend renders one row per ``(weight_class_idx, weight_class_name)``
    in the YOLO weight detail panel and lets the user pick a project class
    (or "None") for each row."""

    id: str
    weight_id: str
    weight_class_idx: int
    weight_class_name: str
    project_class_id: str | None

    @classmethod
    def from_orm_mapping(cls, m: WeightClassMapping) -> "WeightClassMappingOut":
        return cls(
            id=str(m.id),
            weight_id=str(m.weight_id),
            weight_class_idx=m.weight_class_idx,
            weight_class_name=m.weight_class_name,
            project_class_id=str(m.project_class_id) if m.project_class_id else None,
        )


class MappingUpdateIn(BaseModel):
    """PATCH-style body for ``PUT /weights/{wid}/mappings/{mid}``.

    ``project_class_id`` is the only mutable field. ``None`` disconnects
    the row (so the auto-annotate path will skip detections for that
    weight class and surface them in the "skipped" tally)."""

    project_class_id: uuid.UUID | None = Field(default=None)


@router.get(
    "/weights/{weight_id}/mappings",
    response_model=list[WeightClassMappingOut],
)
def list_weight_mappings(
    weight_id: uuid.UUID,
    user: User = Depends(get_current_user),  # noqa: ARG001 — auth required
    db: Session = Depends(get_db),
) -> list[WeightClassMappingOut]:
    """List every weight-class → project-class mapping row for a weight.

    Returned in ``weight_class_idx`` order so the frontend table renders
    in the same order the YOLO model exposed at upload time.
    """
    weight = db.get(Weight, weight_id)
    if weight is None:
        raise HTTPException(status_code=404, detail="weight_not_found")
    rows = list(
        db.execute(
            select(WeightClassMapping)
            .where(WeightClassMapping.weight_id == weight_id)
            .order_by(WeightClassMapping.weight_class_idx)
        ).scalars()
    )
    return [WeightClassMappingOut.from_orm_mapping(m) for m in rows]


@router.put(
    "/weights/{weight_id}/mappings/{mapping_id}",
    response_model=WeightClassMappingOut,
)
def update_weight_mapping(
    weight_id: uuid.UUID,
    mapping_id: uuid.UUID,
    payload: MappingUpdateIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WeightClassMappingOut:
    """Update a weight-class mapping's ``project_class_id``.

    Pass ``project_class_id: null`` to disconnect a mapping. Owner / admin
    only — same gate as rename/delete on the parent weight."""
    from carve_api.projects.service import _can_modify

    weight = db.get(Weight, weight_id)
    if weight is None:
        raise HTTPException(status_code=404, detail="weight_not_found")
    project = ProjectService(db).get(actor=user, project_id=weight.project_id)
    if not _can_modify(user, project):
        raise HTTPException(status_code=403, detail="weight_forbidden")
    mapping = db.get(WeightClassMapping, mapping_id)
    if mapping is None or mapping.weight_id != weight_id:
        raise HTTPException(status_code=404, detail="mapping_not_found")
    if payload.project_class_id is not None:
        target = db.get(Class, payload.project_class_id)
        if target is None or target.project_id != weight.project_id:
            raise HTTPException(status_code=400, detail="class_not_in_project")
    mapping.project_class_id = payload.project_class_id
    db.flush()
    db.commit()
    return WeightClassMappingOut.from_orm_mapping(mapping)


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
    task = _require_visible_task(db, user, task_id)
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
