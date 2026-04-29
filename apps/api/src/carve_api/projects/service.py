import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from carve_api.auth.models import User, UserRole
from carve_api.errors import AppError
from carve_api.projects.models import Class, Project, Task, TaskKind


class ProjectNotFound(AppError):
    http_status = 404
    code = "project_not_found"


class NotProjectOwner(AppError):
    http_status = 403
    code = "not_project_owner"


class ProjectService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def create(self, *, actor: User, name: str, description: str | None = None) -> Project:
        p = Project(name=name, description=description, owner_id=actor.id)
        self.session.add(p)
        self.session.flush()
        return p

    def list_visible(
        self, *, actor: User, include_deleted: bool = False
    ) -> list[Project]:  # noqa: ARG002
        # v1 simplification: all authenticated users see all projects.
        # `actor` reserved for the future per-project ACL (Plan 03+).
        stmt = select(Project)
        if not include_deleted:
            stmt = stmt.where(Project.deleted_at.is_(None))
        stmt = stmt.order_by(Project.created_at.desc())
        return list(self.session.execute(stmt).scalars())

    def get(
        self,
        *,
        actor: User,  # noqa: ARG002
        project_id: uuid.UUID,
        include_deleted: bool = False,
    ) -> Project:
        p = self.session.get(Project, project_id)
        if p is None:
            raise ProjectNotFound("project not found")
        if not include_deleted and p.deleted_at is not None:
            raise ProjectNotFound("project not found")
        return p

    def update(
        self,
        *,
        actor: User,
        project_id: uuid.UUID,
        name: str | None = None,
        description: str | None = None,
    ) -> Project:
        p = self.get(actor=actor, project_id=project_id)
        if not _can_modify(actor, p):
            raise NotProjectOwner("only owner or admin can modify a project")
        if name is not None:
            p.name = name
        if description is not None:
            p.description = description
        self.session.flush()
        return p

    def delete(self, *, actor: User, project_id: uuid.UUID) -> None:
        """Soft-delete: set ``deleted_at = now()``. Restorable via /trash."""
        p = self.get(actor=actor, project_id=project_id)
        if not _can_modify(actor, p):
            raise NotProjectOwner("only owner or admin can delete a project")
        p.deleted_at = datetime.now(timezone.utc)
        # Cascade-soft-delete tasks belonging to this project so they stop
        # appearing in lists and stats.
        for t in self.session.execute(
            select(Task).where(Task.project_id == p.id, Task.deleted_at.is_(None))
        ).scalars():
            t.deleted_at = p.deleted_at
        self.session.flush()


def _can_modify(actor: User, p: Project) -> bool:
    return actor.role == UserRole.admin or p.owner_id == actor.id


class TaskNotFound(AppError):
    http_status = 404
    code = "task_not_found"


class TaskService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def create(self, *, actor: User, project: Project, name: str, kind: TaskKind) -> Task:
        t = Task(project_id=project.id, name=name, kind=kind)
        self.session.add(t)
        self.session.flush()
        return t

    def list_for_project(
        self, *, project: Project, include_deleted: bool = False
    ) -> list[Task]:
        stmt = select(Task).where(Task.project_id == project.id)
        if not include_deleted:
            stmt = stmt.where(Task.deleted_at.is_(None))
        stmt = stmt.order_by(Task.created_at.desc())
        return list(self.session.execute(stmt).scalars())

    def get(
        self,
        *,
        project: Project,
        task_id: uuid.UUID,
        include_deleted: bool = False,
    ) -> Task:
        t = self.session.get(Task, task_id)
        if t is None or t.project_id != project.id:
            raise TaskNotFound("task not found")
        if not include_deleted and t.deleted_at is not None:
            raise TaskNotFound("task not found")
        return t

    def delete(self, *, actor: User, project: Project, task_id: uuid.UUID) -> None:
        """Soft-delete: set ``deleted_at = now()``. Restorable via /trash."""
        if not _can_modify(actor, project):
            raise NotProjectOwner("only owner or admin can delete a task")
        t = self.get(project=project, task_id=task_id)
        t.deleted_at = datetime.now(timezone.utc)
        self.session.flush()

    def duplicate(
        self,
        *,
        actor: User,
        project: Project,
        task_id: uuid.UUID,
        count: int = 1,
        name: str | None = None,
    ) -> list[Task]:
        """Duplicate a task ``count`` times in the same project.

        Copies only the task's intrinsic shape (``name``, ``kind``).
        Assets, annotations, exports, imports, and jobs are NOT copied —
        a duplicated task starts empty so users can stage a parallel
        labelling pass without inheriting source state.

        v3.1 Bug 2 — when ``name`` is supplied it is used verbatim and
        ``count`` is ignored (forced to a single copy because one custom
        name cannot apply to multiple rows without conflict). Validated
        to ``≤ 120`` chars to match the ``tasks.name`` column. When
        ``name`` is ``None`` the legacy auto-suffix path runs: first
        copy is suffixed with " (copy)"; subsequent copies use
        " (copy 2)", " (copy 3)", etc.
        """
        if not _can_modify(actor, project):
            raise NotProjectOwner("only owner or admin can duplicate a task")
        src = self.get(project=project, task_id=task_id)
        new_tasks: list[Task] = []
        if name is not None:
            trimmed = name.strip()
            if not trimmed:
                raise ValueError("name must not be empty")
            if len(trimmed) > 120:
                raise ValueError("name must be ≤ 120 characters")
            t = Task(
                project_id=project.id,
                name=trimmed,
                kind=src.kind,
            )
            self.session.add(t)
            new_tasks.append(t)
        else:
            for i in range(count):
                suffix = " (copy)" if i == 0 else f" (copy {i + 1})"
                t = Task(
                    project_id=project.id,
                    name=(src.name + suffix)[:120],
                    kind=src.kind,
                )
                self.session.add(t)
                new_tasks.append(t)
        self.session.flush()
        return new_tasks


class ClassConflict(AppError):
    http_status = 409
    code = "class_idx_or_name_conflict"


class ClassNotFound(AppError):
    http_status = 404
    code = "class_not_found"


class ClassService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def create(
        self, *, project: Project, idx: int, name: str, color: str, attributes: dict
    ) -> Class:
        c = Class(
            project_id=project.id,
            idx=idx,
            name=name,
            color=color,
            attributes=attributes,
        )
        self.session.add(c)
        try:
            self.session.flush()
        except IntegrityError as exc:
            self.session.rollback()
            raise ClassConflict("class idx or name already used in this project") from exc
        return c

    def list_for_project(self, *, project: Project) -> list[Class]:
        return list(
            self.session.execute(
                select(Class).where(Class.project_id == project.id).order_by(Class.idx)
            ).scalars()
        )

    def get(self, *, project: Project, class_id: uuid.UUID) -> Class:
        c = self.session.get(Class, class_id)
        if c is None or c.project_id != project.id:
            raise ClassNotFound("class not found")
        return c

    def update(self, *, project: Project, class_id: uuid.UUID, **fields) -> Class:
        c = self.get(project=project, class_id=class_id)
        for k, v in fields.items():
            if v is not None:
                setattr(c, k, v)
        try:
            self.session.flush()
        except IntegrityError as exc:
            self.session.rollback()
            raise ClassConflict("class idx or name already used in this project") from exc
        return c

    def delete(self, *, project: Project, class_id: uuid.UUID) -> None:
        c = self.get(project=project, class_id=class_id)
        self.session.delete(c)
        self.session.flush()

    def import_from_project(
        self, *, source: Project, dest: Project
    ) -> tuple[int, int]:
        """Copy classes from ``source`` project into ``dest`` project.

        Skips any class whose name already exists in the destination
        (uq_classes_project_name unique constraint). Returns
        ``(imported, skipped)``.
        """
        existing_dest = self.list_for_project(project=dest)
        existing_names = {c.name for c in existing_dest}
        next_idx = max((c.idx for c in existing_dest), default=-1) + 1

        src_classes = self.list_for_project(project=source)
        imported = 0
        skipped = 0
        for src_c in src_classes:
            if src_c.name in existing_names:
                skipped += 1
                continue
            new_c = Class(
                project_id=dest.id,
                idx=next_idx,
                name=src_c.name,
                color=src_c.color,
                attributes=dict(src_c.attributes or {}),
            )
            self.session.add(new_c)
            next_idx += 1
            imported += 1
        self.session.flush()
        return imported, skipped
