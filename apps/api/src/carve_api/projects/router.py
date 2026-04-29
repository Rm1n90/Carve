import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
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
from carve_api.projects.service import ClassService, ProjectService, TaskService

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
    db.commit()
    return ProjectOut.from_orm_project(p)


@router.get("", response_model=list[ProjectOut])
def list_projects(
    include_deleted: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ProjectOut]:
    return [
        ProjectOut.from_orm_project(p)
        for p in ProjectService(db).list_visible(actor=user, include_deleted=include_deleted)
    ]


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProjectOut:
    try:
        p = ProjectService(db).get(actor=user, project_id=project_id)
    except AppError as exc:
        raise _http(exc) from exc
    return ProjectOut.from_orm_project(p)


@router.patch("/{project_id}", response_model=ProjectOut)
def patch_project(
    project_id: uuid.UUID,
    payload: ProjectPatch,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProjectOut:
    try:
        p = ProjectService(db).update(
            actor=user,
            project_id=project_id,
            name=payload.name,
            description=payload.description,
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return ProjectOut.from_orm_project(p)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    try:
        ProjectService(db).delete(actor=user, project_id=project_id)
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
        project = ProjectService(db).get(actor=user, project_id=project_id)
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
        project = ProjectService(db).get(actor=user, project_id=project_id)
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
        project = ProjectService(db).get(actor=user, project_id=project_id)
        c = ClassService(db).create(
            project=project,
            idx=payload.idx,
            name=payload.name,
            color=payload.color,
            attributes=payload.attributes,
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
        project = ProjectService(db).get(actor=user, project_id=project_id)
        c = ClassService(db).update(
            project=project,
            class_id=class_id,
            idx=payload.idx,
            name=payload.name,
            color=payload.color,
            attributes=payload.attributes,
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
        project = ProjectService(db).get(actor=user, project_id=project_id)
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
        dest = ProjectService(db).get(actor=user, project_id=project_id)
        source = ProjectService(db).get(
            actor=user, project_id=payload.source_project_id
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
        project = ProjectService(db).get(actor=user, project_id=project_id)
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
    if name_override is not None:
        count = 1
    try:
        project = ProjectService(db).get(actor=user, project_id=project_id)
        new_tasks = TaskService(db).duplicate(
            actor=user,
            project=project,
            task_id=task_id,
            count=count,
            name=name_override,
        )
    except AppError as exc:
        raise _http(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    db.commit()
    return [TaskOut.from_orm_task(t) for t in new_tasks]
