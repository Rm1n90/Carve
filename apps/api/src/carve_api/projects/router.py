import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.projects.models import ProjectMember
from carve_api.projects.schemas import (
    ClassIn,
    ClassOut,
    ClassPatch,
    DuplicateTaskIn,
    ImportClassesIn,
    ImportClassesOut,
    ProjectIn,
    ProjectOut,
    ProjectPatch,
    TaskClassesIn,
    TaskClassesOut,
    TaskIn,
    TaskOut,
)
from carve_api.projects.service import (
    ClassService,
    ProjectService,
    TaskService,
    _MUTATING_ROLES,
    require_project_role,
)

router = APIRouter(prefix="/projects", tags=["projects"])


def _http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProjectOut:
    p = ProjectService(db).create(
        actor=user, name=payload.name, description=payload.description
    )
    # Plan-13 Phase 7 Task 2 — auto-insert the creator as ``owner`` so
    # the membership-aware ACL recognises them. Then add any explicit
    # members from the payload (skipping the creator if they appear, so
    # we never collide with the implicit owner row).
    db.add(
        ProjectMember(
            project_id=p.id, user_id=user.id, role="owner", added_by=user.id
        )
    )
    if payload.members:
        seen_user_ids = {user.id}
        for m in payload.members:
            if m.user_id in seen_user_ids:
                continue
            seen_user_ids.add(m.user_id)
            db.add(
                ProjectMember(
                    project_id=p.id,
                    user_id=m.user_id,
                    role=m.role,
                    added_by=user.id,
                )
            )
    db.commit()
    # v3.3 Issue 2 — newly-created project's owner is the current actor;
    # surface their email so the response shape matches list/get.
    return ProjectOut.from_orm_project(p, owner_email=user.email)


@router.get("", response_model=list[ProjectOut])
def list_projects(
    include_deleted: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ProjectOut]:
    # v3.3 Issue 2 — single JOIN'd query yields (Project, owner_email) so
    # the response includes a friendly owner label without per-row lookups.
    return [
        ProjectOut.from_orm_project(p, owner_email=email)
        for p, email in ProjectService(db).list_visible_with_owner_email(
            actor=user, include_deleted=include_deleted
        )
    ]


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProjectOut:
    try:
        p, owner_email = ProjectService(db).get_with_owner_email(
            actor=user, project_id=project_id
        )
    except AppError as exc:
        raise _http(exc) from exc
    return ProjectOut.from_orm_project(p, owner_email=owner_email)


@router.patch("/{project_id}", response_model=ProjectOut)
def patch_project(
    project_id: uuid.UUID,
    payload: ProjectPatch,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProjectOut:
    try:
        # Plan-13 Phase 7 Task 2 — membership gate. Non-members get 403
        # NotProjectMember; viewers get 403 InsufficientRole.
        require_project_role(db, user, project_id, _MUTATING_ROLES)
        p = ProjectService(db).update(
            actor=user,
            project_id=project_id,
            name=payload.name,
            description=payload.description,
            skip_owner_check=True,
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    # v3.3 Issue 2 — resolve the owner email after the update so the
    # response carries the same shape as list/get.
    _, owner_email = ProjectService(db).get_with_owner_email(
        actor=user, project_id=project_id
    )
    return ProjectOut.from_orm_project(p, owner_email=owner_email)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    try:
        # Plan-13 Phase 7 Task 2 — only owner/admin/member may delete a project.
        require_project_role(db, user, project_id, _MUTATING_ROLES)
        ProjectService(db).delete(
            actor=user, project_id=project_id, skip_owner_check=True
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()


@router.post(
    "/{project_id}/tasks",
    response_model=TaskOut,
    status_code=status.HTTP_201_CREATED,
)
def create_task(
    project_id: uuid.UUID,
    payload: TaskIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TaskOut:
    try:
        # Plan-13 Phase 7 Task 2 — gate task creation behind the
        # membership role check. ``require_project_role`` returns the
        # live Project so we don't pay a second ``session.get`` here.
        project = require_project_role(db, user, project_id, _MUTATING_ROLES)
        task = TaskService(db).create(
            actor=user, project=project, name=payload.name, kind=payload.kind
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return TaskOut.from_orm_task(task)


@router.get("/{project_id}/tasks", response_model=list[TaskOut])
def list_tasks(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[TaskOut]:
    try:
        project = ProjectService(db).get(actor=user, project_id=project_id)
    except AppError as exc:
        raise _http(exc) from exc
    return [
        TaskOut.from_orm_task(t)
        for t in TaskService(db).list_for_project(project=project)
    ]


@router.delete(
    "/{project_id}/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_task(
    project_id: uuid.UUID,
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    try:
        # Plan-13 Phase 7 Task 2 — gate task deletion on membership.
        project = require_project_role(db, user, project_id, _MUTATING_ROLES)
        TaskService(db).delete(actor=user, project=project, task_id=task_id)
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()


@router.post(
    "/{project_id}/classes",
    response_model=ClassOut,
    status_code=status.HTTP_201_CREATED,
)
def create_class(
    project_id: uuid.UUID,
    payload: ClassIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ClassOut:
    try:
        # Plan-13 Phase 7 Task 2 — class CRUD is a project mutation.
        project = require_project_role(db, user, project_id, _MUTATING_ROLES)
        c = ClassService(db).create(
            project=project,
            idx=payload.idx,
            name=payload.name,
            color=payload.color,
            attributes=payload.attributes,
            text_prompt=payload.text_prompt,
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return ClassOut.from_orm_class(c)


@router.get("/{project_id}/classes", response_model=list[ClassOut])
def list_classes(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ClassOut]:
    try:
        project = ProjectService(db).get(actor=user, project_id=project_id)
    except AppError as exc:
        raise _http(exc) from exc
    return [
        ClassOut.from_orm_class(c)
        for c in ClassService(db).list_for_project(project=project)
    ]


@router.patch(
    "/{project_id}/classes/{class_id}", response_model=ClassOut
)
def patch_class(
    project_id: uuid.UUID,
    class_id: uuid.UUID,
    payload: ClassPatch,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ClassOut:
    try:
        # Plan-13 Phase 7 Task 2 — class PATCH is a project mutation.
        project = require_project_role(db, user, project_id, _MUTATING_ROLES)
        # v3.8 Phase 3 — text_prompt uses Pydantic's `model_fields_set`
        # so an explicit `null` from the client clears the prompt while
        # an omitted field preserves the current value.
        update_kwargs: dict = {
            "idx": payload.idx,
            "name": payload.name,
            "color": payload.color,
            "attributes": payload.attributes,
        }
        if "text_prompt" in payload.model_fields_set:
            update_kwargs["text_prompt"] = payload.text_prompt
        c = ClassService(db).update(
            project=project,
            class_id=class_id,
            **update_kwargs,
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return ClassOut.from_orm_class(c)


@router.delete(
    "/{project_id}/classes/{class_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_class(
    project_id: uuid.UUID,
    class_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    try:
        # Plan-13 Phase 7 Task 2 — class DELETE is a project mutation.
        project = require_project_role(db, user, project_id, _MUTATING_ROLES)
        ClassService(db).delete(project=project, class_id=class_id)
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()


@router.post(
    "/{project_id}/classes/import",
    response_model=ImportClassesOut,
    status_code=status.HTTP_201_CREATED,
)
def import_classes(
    project_id: uuid.UUID,
    payload: ImportClassesIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ImportClassesOut:
    """Bulk-copy classes from another project into this project.

    Skips any class whose name already exists in the destination so the
    unique constraint never fails. Returns counts. ACL: caller must be
    able to read both projects (v1 ACL = all authenticated users).
    """
    try:
        # Plan-13 Phase 7 Task 2 — caller must be a project member of
        # BOTH the source and destination (any role suffices for the
        # source read; the destination write requires a mutating role).
        dest = require_project_role(db, user, project_id, _MUTATING_ROLES)
        source = require_project_role(
            db, user, payload.source_project_id, _MUTATING_ROLES
        )
        imported, skipped = ClassService(db).import_from_project(
            source=source, dest=dest
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return ImportClassesOut(imported=imported, skipped=skipped)


@router.get(
    "/{project_id}/tasks/{task_id}/classes",
    response_model=TaskClassesOut,
)
def get_task_classes(
    project_id: uuid.UUID,
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TaskClassesOut:
    """Effective class list for a task (v3.1 Issue 3, Option A).

    Returns ``classes`` (the effective list — all project classes when
    no subset is set, otherwise the subset filtered by the task's
    ``allowed_class_ids``) and the raw ``allowed_class_ids`` so the UI
    can distinguish "all" (``null``) from "explicit subset".
    """
    try:
        project = ProjectService(db).get(actor=user, project_id=project_id)
        task_svc = TaskService(db)
        task = task_svc.get(project=project, task_id=task_id)
        classes, allowed = task_svc.get_effective_classes(
            project=project, task=task
        )
    except AppError as exc:
        raise _http(exc) from exc
    return TaskClassesOut(
        classes=[ClassOut.from_orm_class(c) for c in classes],
        allowed_class_ids=allowed,
    )


@router.put(
    "/{project_id}/tasks/{task_id}/classes",
    response_model=TaskClassesOut,
)
def set_task_classes(
    project_id: uuid.UUID,
    task_id: uuid.UUID,
    payload: TaskClassesIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TaskClassesOut:
    """Set the task's class subset (v3.1 Issue 3, Option A).

    Admin or project owner only. ``None`` clears the subset (back to
    "all project classes"); ``[]`` is the legal empty-subset state;
    a populated list scopes the editor + exports to those classes.

    Validation: every id must belong to the *same* project. Cross-
    project ids return 422.

    Annotations referencing classes that are now disallowed are NOT
    deleted — they remain in the DB. The UI may hide them, but the API
    does not destroy data on this call.
    """
    try:
        # Plan-13 Phase 7 Task 2 — editing a task's class subset is a mutation.
        project = require_project_role(db, user, project_id, _MUTATING_ROLES)
        task_svc = TaskService(db)
        task = task_svc.get(project=project, task_id=task_id)
        task_svc.set_allowed_classes(
            actor=user,
            project=project,
            task=task,
            allowed_class_ids=payload.allowed_class_ids,
        )
        classes, allowed = task_svc.get_effective_classes(
            project=project, task=task
        )
    except AppError as exc:
        raise _http(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    db.commit()
    return TaskClassesOut(
        classes=[ClassOut.from_orm_class(c) for c in classes],
        allowed_class_ids=allowed,
    )


@router.post(
    "/{project_id}/tasks/{task_id}/duplicate",
    response_model=list[TaskOut],
    status_code=status.HTTP_201_CREATED,
)
def duplicate_task(
    project_id: uuid.UUID,
    task_id: uuid.UUID,
    payload: DuplicateTaskIn | None = None,
    count: int = Query(default=1, ge=1, le=10),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[TaskOut]:
    """Duplicate a task in the same project.

    Copies only ``name`` and ``kind``. Assets/annotations/exports/imports
    /jobs are NOT copied. Cap of 10 (via ``count`` query param) prevents
    accidental fan-out.

    v3.1 Bug 2 — when an optional ``payload.name`` is provided the new
    task is created with that exact name and ``count`` is forced to 1
    (a single custom name cannot be applied to multiple copies without
    conflict).
    """
    name_override = payload.name if payload is not None else None
    classes_override = payload.allowed_class_ids if payload is not None else None
    if name_override is not None:
        count = 1
    try:
        # Plan-13 Phase 7 Task 2 — duplicate creates new tasks; mutation gate.
        project = require_project_role(db, user, project_id, _MUTATING_ROLES)
        new_tasks = TaskService(db).duplicate(
            actor=user,
            project=project,
            task_id=task_id,
            count=count,
            name=name_override,
            allowed_class_ids=classes_override,
        )
    except AppError as exc:
        raise _http(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    db.commit()
    return [TaskOut.from_orm_task(t) for t in new_tasks]
