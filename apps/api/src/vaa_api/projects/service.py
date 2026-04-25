import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from vaa_api.auth.models import User, UserRole
from vaa_api.errors import AppError
from vaa_api.projects.models import Project, Task, TaskKind


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

    def list_visible(self, *, actor: User) -> list[Project]:
        return list(
            self.session.execute(
                select(Project).order_by(Project.created_at.desc())
            ).scalars()
        )

    def get(self, *, actor: User, project_id: uuid.UUID) -> Project:
        p = self.session.get(Project, project_id)
        if p is None:
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
        p = self.get(actor=actor, project_id=project_id)
        if not _can_modify(actor, p):
            raise NotProjectOwner("only owner or admin can delete a project")
        self.session.delete(p)
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

    def list_for_project(self, *, project: Project) -> list[Task]:
        return list(
            self.session.execute(
                select(Task)
                .where(Task.project_id == project.id)
                .order_by(Task.created_at.desc())
            ).scalars()
        )

    def get(self, *, project: Project, task_id: uuid.UUID) -> Task:
        t = self.session.get(Task, task_id)
        if t is None or t.project_id != project.id:
            raise TaskNotFound("task not found")
        return t

    def delete(self, *, actor: User, project: Project, task_id: uuid.UUID) -> None:
        if not _can_modify(actor, project):
            raise NotProjectOwner("only owner or admin can delete a task")
        t = self.get(project=project, task_id=task_id)
        self.session.delete(t)
        self.session.flush()
