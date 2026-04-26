# Plan 02 — Projects, Tasks, Classes (CRUD + nav UI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use `- [ ]` syntax for tracking.

**Goal:** Add the core domain entities — projects, tasks (image-set or video), and per-project classes — with REST API, ORM models, Alembic migration, plus the web UI shell and pages so an annotator can create a project, define classes, and create tasks.

**Architecture:** Projects are top-level containers owned by their creator and visible to all logged-in users. Tasks are scoped to a project (`kind = image | video`). Classes are scoped to a project and have an integer `idx`, name, color, and JSON attributes. Permissions: any logged-in user can create projects; project owner OR admin can edit/delete a project; project members (= any authenticated user, v1 simplification) can create tasks and classes within projects they can see.

**Tech Stack:** Same as Plan 01. No new infra.

---

## Series context

- ✅ Plan 01 — Foundation & Auth (shipped)
- **Plan 02 — Projects, Tasks, Classes** ← *this plan*
- Plan 03 — Asset ingestion
- Plan 04 — Manual annotation canvas
- Plan 05 — YOLO model service + auto-annotate
- Plan 06 — Annotation import/export with class remap
- Plan 07 — Analytics dashboards
- Plan 08 — Deployment polish

---

## File Structure

```
apps/api/
├── alembic/versions/
│   └── 0002_projects_tasks_classes.py            (new)
├── src/carve_api/
│   ├── main.py                                   (modify — register router)
│   └── projects/                                 (new package)
│       ├── __init__.py
│       ├── models.py                             # Project, Task, Class
│       ├── schemas.py                            # Pydantic in/out
│       ├── service.py                            # Business logic
│       └── router.py                             # /projects, /tasks, /classes
└── tests/projects/                               (new)
    ├── __init__.py
    ├── test_models.py
    ├── test_project_service.py
    ├── test_project_router.py
    ├── test_task_router.py
    └── test_class_router.py

apps/web/src/
├── api/
│   ├── projects.ts                               (new)
│   ├── tasks.ts                                  (new)
│   └── classes.ts                                (new)
├── components/
│   ├── AppShell.tsx                              (new)
│   └── ProjectCard.tsx                           (new)
├── pages/
│   ├── ProjectsPage.tsx                          (new)
│   ├── ProjectDetailPage.tsx                     (new)
│   ├── ClassesEditor.tsx                         (new)
│   └── NewTaskDialog.tsx                         (new)
├── routes/
│   ├── _root.tsx                                 (modify)
│   ├── index.tsx                                 (modify)
│   ├── projects.tsx                              (new)
│   └── projects.$projectId.tsx                   (new)
└── tests/
    ├── projects-page.test.tsx                    (new)
    └── classes-editor.test.tsx                   (new)
```

---

## Conventions

- API routes mounted at root prefix (no `/v1`).
- Each ORM model has a UUID primary key.
- Hard delete in v1 (UI confirms before delete).
- TDD throughout. Each task = failing test → implementation → passing test → commit.

---

## Task 1: Domain models — Project, Task, Class + migration

**Files:**
- Create: `apps/api/src/carve_api/projects/__init__.py` (docstring only)
- Create: `apps/api/src/carve_api/projects/models.py`
- Create: `apps/api/alembic/versions/0002_projects_tasks_classes.py`
- Create: `apps/api/tests/projects/__init__.py` (empty)
- Create: `apps/api/tests/projects/test_models.py`
- Modify: `apps/api/alembic/env.py` (add new model import)

- [ ] **Step 1.1: Failing test** `apps/api/tests/projects/test_models.py`

```python
import uuid

import pytest
from sqlalchemy.exc import IntegrityError

from carve_api.auth.models import User, UserRole
from carve_api.projects.models import Class, Project, Task, TaskKind


def test_project_task_class_create(db_session) -> None:
    user = User(email="o@x.com", password_hash="x", role=UserRole.admin)
    db_session.add(user)
    db_session.flush()

    p = Project(name="Proj", description="d", owner_id=user.id)
    db_session.add(p)
    db_session.flush()
    assert p.id is not None
    assert p.created_at is not None

    t = Task(project_id=p.id, name="T1", kind=TaskKind.image)
    db_session.add(t)
    db_session.flush()
    assert t.id is not None

    c = Class(project_id=p.id, idx=0, name="car", color="#ff0000")
    db_session.add(c)
    db_session.flush()
    assert c.id is not None


def test_class_idx_unique_within_project(db_session) -> None:
    user = User(email="o2@x.com", password_hash="x", role=UserRole.admin)
    db_session.add(user)
    db_session.flush()
    p = Project(name="Proj2", owner_id=user.id)
    db_session.add(p)
    db_session.flush()
    db_session.add(Class(project_id=p.id, idx=0, name="a", color="#000000"))
    db_session.flush()
    with pytest.raises(IntegrityError):
        db_session.add(Class(project_id=p.id, idx=0, name="b", color="#111111"))
        db_session.flush()


def test_task_kind_enum_values() -> None:
    assert {k.value for k in TaskKind} == {"image", "video"}
```

- [ ] **Step 1.2: Run, verify failure**

```bash
cd apps/api && source .venv/bin/activate
pytest tests/projects/test_models.py -v
```

Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 1.3: Implement** `apps/api/src/carve_api/projects/models.py`

```python
import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from carve_api.db import Base


class TaskKind(str, enum.Enum):
    image = "image"
    video = "video"


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    kind: Mapped[TaskKind] = mapped_column(Enum(TaskKind, name="task_kind"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Class(Base):
    __tablename__ = "classes"
    __table_args__ = (
        UniqueConstraint("project_id", "idx", name="uq_classes_project_idx"),
        UniqueConstraint("project_id", "name", name="uq_classes_project_name"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    idx: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    color: Mapped[str] = mapped_column(String(7), nullable=False)
    attributes: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
```

`apps/api/src/carve_api/projects/__init__.py`:

```python
"""Projects, Tasks (image/video datasets), and Classes."""
```

`apps/api/tests/projects/__init__.py`: empty file.

- [ ] **Step 1.4: Update `apps/api/alembic/env.py`**

Find the line `import carve_api.auth.models  # noqa: F401, E402  (populate metadata)` and add a sibling import below it:

```python
import carve_api.projects.models  # noqa: F401, E402  (populate metadata)
```

- [ ] **Step 1.5: Migration `apps/api/alembic/versions/0002_projects_tasks_classes.py`**

```python
"""projects, tasks, classes

Revision ID: 0002
Revises: 0001
Create Date: 2026-04-25
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


task_kind = postgresql.ENUM("image", "video", name="task_kind")


def upgrade() -> None:
    task_kind.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "projects",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column(
            "owner_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_projects_owner_id", "projects", ["owner_id"])

    op.create_table(
        "tasks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column(
            "kind",
            postgresql.ENUM(name="task_kind", create_type=False),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_tasks_project_id", "tasks", ["project_id"])

    op.create_table(
        "classes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("idx", sa.Integer, nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("color", sa.String(7), nullable=False),
        sa.Column(
            "attributes",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("project_id", "idx", name="uq_classes_project_idx"),
        sa.UniqueConstraint("project_id", "name", name="uq_classes_project_name"),
    )
    op.create_index("ix_classes_project_id", "classes", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_classes_project_id", table_name="classes")
    op.drop_table("classes")
    op.drop_index("ix_tasks_project_id", table_name="tasks")
    op.drop_table("tasks")
    op.drop_index("ix_projects_owner_id", table_name="projects")
    op.drop_table("projects")
    task_kind.drop(op.get_bind(), checkfirst=True)
```

- [ ] **Step 1.6: Run model tests**

```bash
pytest tests/projects/test_models.py -v
```

Expected: 3 PASS.

- [ ] **Step 1.7: Full suite**

```bash
pytest tests/ -v
```

Expected: 33 PASS (30 from Plan 01 + 3 new).

- [ ] **Step 1.8: Commit**

```bash
git add apps/api/src/carve_api/projects apps/api/alembic apps/api/tests/projects
git commit -m "feat(api): Project/Task/Class models + migration with idx/name uniqueness"
```

---

## Task 2: Project service + router

**Files:**
- Create: `apps/api/src/carve_api/projects/schemas.py`
- Create: `apps/api/src/carve_api/projects/service.py`
- Create: `apps/api/src/carve_api/projects/router.py`
- Create: `apps/api/tests/projects/test_project_service.py`
- Create: `apps/api/tests/projects/test_project_router.py`
- Modify: `apps/api/src/carve_api/main.py`

- [ ] **Step 2.1: Failing service tests** `apps/api/tests/projects/test_project_service.py`

```python
import uuid

import pytest

from carve_api.auth.models import User, UserRole
from carve_api.projects.models import Project
from carve_api.projects.service import (
    NotProjectOwner,
    ProjectNotFound,
    ProjectService,
)


def _user(db, email: str, role: UserRole = UserRole.member) -> User:
    u = User(email=email, password_hash="x", role=role)
    db.add(u)
    db.flush()
    return u


def test_create_project(db_session) -> None:
    owner = _user(db_session, "o@x.com")
    svc = ProjectService(db_session)
    p = svc.create(actor=owner, name="P1", description="hello")
    assert p.name == "P1"
    assert p.owner_id == owner.id


def test_list_returns_all_projects(db_session) -> None:
    db_session.query(Project).delete()
    a = _user(db_session, "a@x.com")
    b = _user(db_session, "b@x.com")
    svc = ProjectService(db_session)
    svc.create(actor=a, name="A1")
    svc.create(actor=b, name="B1")
    rows = svc.list_visible(actor=a)
    assert {r.name for r in rows} == {"A1", "B1"}


def test_get_returns_project(db_session) -> None:
    o = _user(db_session, "o3@x.com")
    svc = ProjectService(db_session)
    p = svc.create(actor=o, name="G1")
    assert svc.get(actor=o, project_id=p.id).id == p.id


def test_get_unknown_raises(db_session) -> None:
    o = _user(db_session, "o4@x.com")
    svc = ProjectService(db_session)
    with pytest.raises(ProjectNotFound):
        svc.get(actor=o, project_id=uuid.uuid4())


def test_update_only_owner(db_session) -> None:
    o = _user(db_session, "o5@x.com")
    intruder = _user(db_session, "in@x.com")
    svc = ProjectService(db_session)
    p = svc.create(actor=o, name="X")
    with pytest.raises(NotProjectOwner):
        svc.update(actor=intruder, project_id=p.id, name="Hacked")
    updated = svc.update(actor=o, project_id=p.id, name="Renamed")
    assert updated.name == "Renamed"


def test_admin_can_edit_any(db_session) -> None:
    boss = _user(db_session, "boss@x.com", role=UserRole.admin)
    member = _user(db_session, "m@x.com")
    svc = ProjectService(db_session)
    p = svc.create(actor=member, name="M1")
    assert svc.update(actor=boss, project_id=p.id, name="Edit").name == "Edit"


def test_delete_only_owner_or_admin(db_session) -> None:
    o = _user(db_session, "od@x.com")
    other = _user(db_session, "ot@x.com")
    svc = ProjectService(db_session)
    p = svc.create(actor=o, name="D1")
    with pytest.raises(NotProjectOwner):
        svc.delete(actor=other, project_id=p.id)
    svc.delete(actor=o, project_id=p.id)
    with pytest.raises(ProjectNotFound):
        svc.get(actor=o, project_id=p.id)
```

- [ ] **Step 2.2: Run, verify failure**

- [ ] **Step 2.3: `apps/api/src/carve_api/projects/schemas.py`**

```python
from datetime import datetime

from pydantic import BaseModel, Field

from carve_api.projects.models import TaskKind


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=4000)


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=4000)


class ProjectOut(BaseModel):
    id: str
    name: str
    description: str | None
    owner_id: str
    created_at: datetime

    @classmethod
    def from_orm_project(cls, p) -> "ProjectOut":
        return cls(
            id=str(p.id),
            name=p.name,
            description=p.description,
            owner_id=str(p.owner_id),
            created_at=p.created_at,
        )
```

(Task 3 will append `TaskIn` / `TaskOut` to this file; Task 4 will append `ClassIn`, `ClassPatch`, `ClassOut`.)

- [ ] **Step 2.4: `apps/api/src/carve_api/projects/service.py`**

```python
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.auth.models import User, UserRole
from carve_api.errors import AppError
from carve_api.projects.models import Project


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
```

(Task 3 / 4 will append `TaskService` and `ClassService` to this file.)

- [ ] **Step 2.5: Run service tests, verify pass**

```bash
pytest tests/projects/test_project_service.py -v
```

Expected: 7 PASS.

- [ ] **Step 2.6: Failing router tests** `apps/api/tests/projects/test_project_router.py`

```python
import uuid

from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _login(client, email, password) -> str:
    return client.post(
        "/auth/login", json={"email": email, "password": password}
    ).json()["access_token"]


def _hdr(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_create_project_requires_auth(db_session) -> None:
    client = _client(db_session)
    r = client.post("/projects", json={"name": "P"})
    assert r.status_code == 401


def test_create_and_list_project(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "u@x.com", "password": "hunter22"})
    token = _login(client, "u@x.com", "hunter22")
    r = client.post("/projects", json={"name": "P1"}, headers=_hdr(token))
    assert r.status_code == 201
    pid = r.json()["id"]
    r = client.get("/projects", headers=_hdr(token))
    assert r.status_code == 200
    assert any(p["id"] == pid for p in r.json())


def test_get_404(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "u2@x.com", "password": "hunter22"})
    token = _login(client, "u2@x.com", "hunter22")
    r = client.get(f"/projects/{uuid.uuid4()}", headers=_hdr(token))
    assert r.status_code == 404


def test_patch_only_by_owner(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "owner@x.com", "password": "hunter22"})
    client.post("/auth/register", json={"email": "intruder@x.com", "password": "hunter22"})
    owner = _login(client, "owner@x.com", "hunter22")
    intruder = _login(client, "intruder@x.com", "hunter22")
    pid = client.post("/projects", json={"name": "Mine"}, headers=_hdr(owner)).json()["id"]
    r = client.patch(f"/projects/{pid}", json={"name": "stolen"}, headers=_hdr(intruder))
    assert r.status_code == 403
    r = client.patch(f"/projects/{pid}", json={"name": "renamed"}, headers=_hdr(owner))
    assert r.status_code == 200
    assert r.json()["name"] == "renamed"


def test_delete_only_by_owner(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "od@x.com", "password": "hunter22"})
    client.post("/auth/register", json={"email": "ot@x.com", "password": "hunter22"})
    owner = _login(client, "od@x.com", "hunter22")
    other = _login(client, "ot@x.com", "hunter22")
    pid = client.post("/projects", json={"name": "D"}, headers=_hdr(owner)).json()["id"]
    r = client.delete(f"/projects/{pid}", headers=_hdr(other))
    assert r.status_code == 403
    r = client.delete(f"/projects/{pid}", headers=_hdr(owner))
    assert r.status_code == 204
```

- [ ] **Step 2.7: `apps/api/src/carve_api/projects/router.py`**

```python
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.projects.schemas import ProjectIn, ProjectOut, ProjectPatch
from carve_api.projects.service import ProjectService

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
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ProjectOut]:
    return [
        ProjectOut.from_orm_project(p) for p in ProjectService(db).list_visible(actor=user)
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
```

(Task 3 will append the task endpoints; Task 4 will append the class endpoints.)

- [ ] **Step 2.8: Mount router in `apps/api/src/carve_api/main.py`**

After the line `app.include_router(auth_router)` add:

```python
    from carve_api.projects.router import router as projects_router
    app.include_router(projects_router)
```

- [ ] **Step 2.9: Run tests**

```bash
pytest tests/projects -v
```

Expected: 7 + 5 = 12 PASS.

- [ ] **Step 2.10: Full suite**

```bash
pytest tests/ -v
```

Expected: 45 PASS.

- [ ] **Step 2.11: Commit**

```bash
git add apps/api/src/carve_api/projects apps/api/src/carve_api/main.py apps/api/tests/projects
git commit -m "feat(api): Project CRUD with owner-or-admin guarded mutations"
```

---

## Task 3: Task router (nested under project)

**Files:**
- Create: `apps/api/tests/projects/test_task_router.py`
- Modify: `apps/api/src/carve_api/projects/schemas.py` (append `TaskIn`, `TaskOut`)
- Modify: `apps/api/src/carve_api/projects/service.py` (append `TaskService`, `TaskNotFound`)
- Modify: `apps/api/src/carve_api/projects/router.py` (append task endpoints)

- [ ] **Step 3.1: Failing tests** `apps/api/tests/projects/test_task_router.py`

```python
from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _login(client, email, pw) -> str:
    return client.post("/auth/login", json={"email": email, "password": pw}).json()[
        "access_token"
    ]


def _hdr(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def _new_project(client, token: str, name: str = "P") -> str:
    return client.post("/projects", json={"name": name}, headers=_hdr(token)).json()["id"]


def test_create_task(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "tk@x.com", "password": "hunter22"})
    token = _login(client, "tk@x.com", "hunter22")
    pid = _new_project(client, token)
    r = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "Task A", "kind": "image"},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    assert r.json()["kind"] == "image"


def test_list_tasks_for_project(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "tk2@x.com", "password": "hunter22"})
    token = _login(client, "tk2@x.com", "hunter22")
    pid = _new_project(client, token)
    client.post(f"/projects/{pid}/tasks", json={"name": "T1", "kind": "image"}, headers=_hdr(token))
    client.post(f"/projects/{pid}/tasks", json={"name": "T2", "kind": "video"}, headers=_hdr(token))
    r = client.get(f"/projects/{pid}/tasks", headers=_hdr(token))
    assert r.status_code == 200
    assert {t["name"] for t in r.json()} == {"T1", "T2"}


def test_delete_task_only_owner(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "to@x.com", "password": "hunter22"})
    client.post("/auth/register", json={"email": "to2@x.com", "password": "hunter22"})
    owner = _login(client, "to@x.com", "hunter22")
    other = _login(client, "to2@x.com", "hunter22")
    pid = _new_project(client, owner)
    r = client.post(
        f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(owner)
    )
    tid = r.json()["id"]
    r = client.delete(f"/projects/{pid}/tasks/{tid}", headers=_hdr(other))
    assert r.status_code == 403
    r = client.delete(f"/projects/{pid}/tasks/{tid}", headers=_hdr(owner))
    assert r.status_code == 204


def test_task_kind_validated(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "tv@x.com", "password": "hunter22"})
    token = _login(client, "tv@x.com", "hunter22")
    pid = _new_project(client, token, name="V")
    r = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "X", "kind": "bogus"},
        headers=_hdr(token),
    )
    assert r.status_code == 422
```

- [ ] **Step 3.2: Run, verify failure**

- [ ] **Step 3.3: Append to `apps/api/src/carve_api/projects/schemas.py`**

```python
class TaskIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: TaskKind


class TaskOut(BaseModel):
    id: str
    project_id: str
    name: str
    kind: TaskKind
    created_at: datetime

    @classmethod
    def from_orm_task(cls, t) -> "TaskOut":
        return cls(
            id=str(t.id),
            project_id=str(t.project_id),
            name=t.name,
            kind=t.kind,
            created_at=t.created_at,
        )
```

- [ ] **Step 3.4: Append to `apps/api/src/carve_api/projects/service.py`**

```python
from carve_api.projects.models import Task, TaskKind


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
```

- [ ] **Step 3.5: Append to `apps/api/src/carve_api/projects/router.py`**

```python
from carve_api.projects.schemas import TaskIn, TaskOut
from carve_api.projects.service import TaskService


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
```

- [ ] **Step 3.6: Run task tests**

```bash
pytest tests/projects/test_task_router.py -v
```

Expected: 4 PASS.

- [ ] **Step 3.7: Full suite**

```bash
pytest tests/ -v
```

Expected: 49 PASS.

- [ ] **Step 3.8: Commit**

```bash
git add apps/api/src/carve_api/projects apps/api/tests/projects/test_task_router.py
git commit -m "feat(api): Task CRUD nested under /projects/{id}/tasks"
```

---

## Task 4: Class router

**Files:**
- Create: `apps/api/tests/projects/test_class_router.py`
- Modify: `apps/api/src/carve_api/projects/schemas.py` (append `ClassIn`, `ClassPatch`, `ClassOut`, `_HEX_COLOR`)
- Modify: `apps/api/src/carve_api/projects/service.py` (append `ClassService`, `ClassConflict`, `ClassNotFound`)
- Modify: `apps/api/src/carve_api/projects/router.py` (append class endpoints)

- [ ] **Step 4.1: Failing tests** `apps/api/tests/projects/test_class_router.py`

```python
from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def _setup(client) -> tuple[str, str]:
    client.post("/auth/register", json={"email": "cl@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "cl@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post("/projects", json={"name": "C"}, headers=_hdr(token)).json()["id"]
    return pid, token


def test_create_class(db_session) -> None:
    client = _client(db_session)
    pid, token = _setup(client)
    r = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "car", "color": "#ff0000"},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["idx"] == 0
    assert body["name"] == "car"


def test_list_classes_in_idx_order(db_session) -> None:
    client = _client(db_session)
    pid, token = _setup(client)
    client.post(
        f"/projects/{pid}/classes",
        json={"idx": 1, "name": "b", "color": "#000000"},
        headers=_hdr(token),
    )
    client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "a", "color": "#111111"},
        headers=_hdr(token),
    )
    r = client.get(f"/projects/{pid}/classes", headers=_hdr(token))
    rows = r.json()
    assert [c["idx"] for c in rows] == [0, 1]


def test_class_idx_uniqueness_returns_409(db_session) -> None:
    client = _client(db_session)
    pid, token = _setup(client)
    client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "a", "color": "#111111"},
        headers=_hdr(token),
    )
    r = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "z", "color": "#222222"},
        headers=_hdr(token),
    )
    assert r.status_code == 409


def test_color_validated(db_session) -> None:
    client = _client(db_session)
    pid, token = _setup(client)
    r = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "x", "color": "not-a-hex"},
        headers=_hdr(token),
    )
    assert r.status_code == 422


def test_patch_and_delete_class(db_session) -> None:
    client = _client(db_session)
    pid, token = _setup(client)
    r = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "old", "color": "#000000"},
        headers=_hdr(token),
    )
    cid = r.json()["id"]
    r = client.patch(
        f"/projects/{pid}/classes/{cid}",
        json={"name": "new", "color": "#abcdef"},
        headers=_hdr(token),
    )
    assert r.status_code == 200
    assert r.json()["name"] == "new"
    r = client.delete(f"/projects/{pid}/classes/{cid}", headers=_hdr(token))
    assert r.status_code == 204
```

- [ ] **Step 4.2: Run, verify failure**

- [ ] **Step 4.3: Append to `apps/api/src/carve_api/projects/schemas.py`**

Add this at the top of the file (after the existing imports):

```python
import re

from pydantic import field_validator

_HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")
```

Then append at the bottom of the file:

```python
class ClassIn(BaseModel):
    idx: int = Field(ge=0, le=10000)
    name: str = Field(min_length=1, max_length=120)
    color: str
    attributes: dict = Field(default_factory=dict)

    @field_validator("color")
    @classmethod
    def _color_hex(cls, v: str) -> str:
        if not _HEX_COLOR.match(v):
            raise ValueError("color must be #RRGGBB")
        return v


class ClassPatch(BaseModel):
    idx: int | None = Field(default=None, ge=0, le=10000)
    name: str | None = Field(default=None, min_length=1, max_length=120)
    color: str | None = None
    attributes: dict | None = None

    @field_validator("color")
    @classmethod
    def _color_hex(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not _HEX_COLOR.match(v):
            raise ValueError("color must be #RRGGBB")
        return v


class ClassOut(BaseModel):
    id: str
    project_id: str
    idx: int
    name: str
    color: str
    attributes: dict
    created_at: datetime

    @classmethod
    def from_orm_class(cls, c) -> "ClassOut":
        return cls(
            id=str(c.id),
            project_id=str(c.project_id),
            idx=c.idx,
            name=c.name,
            color=c.color,
            attributes=c.attributes,
            created_at=c.created_at,
        )
```

- [ ] **Step 4.4: Append to `apps/api/src/carve_api/projects/service.py`**

```python
from sqlalchemy.exc import IntegrityError

from carve_api.projects.models import Class


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
```

- [ ] **Step 4.5: Append to `apps/api/src/carve_api/projects/router.py`**

```python
from carve_api.projects.schemas import ClassIn, ClassOut, ClassPatch
from carve_api.projects.service import ClassService


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
```

- [ ] **Step 4.6: Run class tests**

```bash
pytest tests/projects/test_class_router.py -v
```

Expected: 5 PASS.

- [ ] **Step 4.7: Full suite**

```bash
pytest tests/ -v
```

Expected: 54 PASS.

- [ ] **Step 4.8: Commit**

```bash
git add apps/api/src/carve_api/projects apps/api/tests/projects/test_class_router.py
git commit -m "feat(api): Class CRUD with idx/name uniqueness and #RRGGBB color validation"
```

---

## Task 5: Web — API client wrappers

**Files:**
- Create: `apps/web/src/api/projects.ts`
- Create: `apps/web/src/api/tasks.ts`
- Create: `apps/web/src/api/classes.ts`

- [ ] **Step 5.1: `apps/web/src/api/projects.ts`**

```ts
import { api } from "./client";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  created_at: string;
}

export interface ProjectIn {
  name: string;
  description?: string;
}

export const projectsApi = {
  list: async (): Promise<Project[]> => (await api.get<Project[]>("/projects")).data,
  get: async (id: string): Promise<Project> =>
    (await api.get<Project>(`/projects/${id}`)).data,
  create: async (input: ProjectIn): Promise<Project> =>
    (await api.post<Project>("/projects", input)).data,
  update: async (id: string, patch: Partial<ProjectIn>): Promise<Project> =>
    (await api.patch<Project>(`/projects/${id}`, patch)).data,
  delete: async (id: string): Promise<void> => {
    await api.delete(`/projects/${id}`);
  },
};
```

- [ ] **Step 5.2: `apps/web/src/api/tasks.ts`**

```ts
import { api } from "./client";

export type TaskKind = "image" | "video";

export interface Task {
  id: string;
  project_id: string;
  name: string;
  kind: TaskKind;
  created_at: string;
}

export interface TaskIn {
  name: string;
  kind: TaskKind;
}

export const tasksApi = {
  listForProject: async (projectId: string): Promise<Task[]> =>
    (await api.get<Task[]>(`/projects/${projectId}/tasks`)).data,
  create: async (projectId: string, input: TaskIn): Promise<Task> =>
    (await api.post<Task>(`/projects/${projectId}/tasks`, input)).data,
  delete: async (projectId: string, taskId: string): Promise<void> => {
    await api.delete(`/projects/${projectId}/tasks/${taskId}`);
  },
};
```

- [ ] **Step 5.3: `apps/web/src/api/classes.ts`**

```ts
import { api } from "./client";

export interface ClassRow {
  id: string;
  project_id: string;
  idx: number;
  name: string;
  color: string;
  attributes: Record<string, unknown>;
  created_at: string;
}

export interface ClassIn {
  idx: number;
  name: string;
  color: string;
  attributes?: Record<string, unknown>;
}

export const classesApi = {
  listForProject: async (projectId: string): Promise<ClassRow[]> =>
    (await api.get<ClassRow[]>(`/projects/${projectId}/classes`)).data,
  create: async (projectId: string, input: ClassIn): Promise<ClassRow> =>
    (await api.post<ClassRow>(`/projects/${projectId}/classes`, input)).data,
  update: async (
    projectId: string,
    classId: string,
    patch: Partial<ClassIn>,
  ): Promise<ClassRow> =>
    (await api.patch<ClassRow>(`/projects/${projectId}/classes/${classId}`, patch)).data,
  delete: async (projectId: string, classId: string): Promise<void> => {
    await api.delete(`/projects/${projectId}/classes/${classId}`);
  },
};
```

- [ ] **Step 5.4: Compile check**

```bash
cd apps/web
npm run build
```

Expected: build succeeds.

- [ ] **Step 5.5: Commit**

```bash
git add apps/web/src/api
git commit -m "feat(web): typed API clients for projects, tasks, classes"
```

---

## Task 6: Web — AppShell + protected layout

**Files:**
- Create: `apps/web/src/components/AppShell.tsx`
- Modify: `apps/web/src/routes/_root.tsx`

- [ ] **Step 6.1: `apps/web/src/components/AppShell.tsx`**

```tsx
import type { ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/auth/store";
import { logout } from "@/auth/api";

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuth((s) => s.user);
  const nav = useNavigate();
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 24px",
          borderBottom: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        <Link to="/" style={{ fontWeight: 700, textDecoration: "none", color: "inherit" }}>
          Carve
        </Link>
        <nav style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <Link to="/projects">Projects</Link>
          {user && (
            <>
              <span style={{ opacity: 0.7, fontSize: 13 }}>
                {user.email} ({user.role})
              </span>
              <button
                onClick={() => {
                  logout();
                  nav({ to: "/login" });
                }}
              >
                Sign out
              </button>
            </>
          )}
        </nav>
      </header>
      <main style={{ flex: 1, padding: 24 }}>{children}</main>
    </div>
  );
}
```

- [ ] **Step 6.2: Replace `apps/web/src/routes/_root.tsx`**

```tsx
import { Outlet, createRootRoute, useRouterState } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { useAuth } from "@/auth/store";

function RootComponent() {
  const token = useAuth((s) => s.accessToken);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const onAuthPage = path === "/login" || path === "/register";
  if (!token || onAuthPage) {
    return <Outlet />;
  }
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export const rootRoute = createRootRoute({ component: RootComponent });
```

- [ ] **Step 6.3: Smoke build**

```bash
npm run build
```

- [ ] **Step 6.4: Commit**

```bash
git add apps/web/src/components/AppShell.tsx apps/web/src/routes/_root.tsx
git commit -m "feat(web): AppShell with top-nav, sign-out, and auth-aware layout"
```

---

## Task 7: Web — Projects page (list + create + delete)

**Files:**
- Create: `apps/web/src/components/ProjectCard.tsx`
- Create: `apps/web/src/pages/ProjectsPage.tsx`
- Create: `apps/web/src/routes/projects.tsx`
- Modify: `apps/web/src/main.tsx` (register `projectsRoute`, mount `QueryClientProvider`)
- Create: `apps/web/tests/projects-page.test.tsx`

- [ ] **Step 7.1: Failing test** `apps/web/tests/projects-page.test.tsx`

```tsx
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

import { projectsApi } from "@/api/projects";
import { ProjectsPage } from "@/pages/ProjectsPage";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("ProjectsPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists projects from the API", async () => {
    (projectsApi.list as any).mockResolvedValue([
      { id: "p1", name: "Alpha", description: null, owner_id: "u", created_at: "2026-01-01" },
      { id: "p2", name: "Beta", description: "x", owner_id: "u", created_at: "2026-01-02" },
    ]);
    render(wrap(<ProjectsPage />));
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("creates a project via the form", async () => {
    (projectsApi.list as any).mockResolvedValue([]);
    (projectsApi.create as any).mockResolvedValue({
      id: "n",
      name: "New",
      description: null,
      owner_id: "u",
      created_at: "2026-01-01",
    });
    render(wrap(<ProjectsPage />));
    fireEvent.click(await screen.findByRole("button", { name: /new project/i }));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => {
      expect(projectsApi.create).toHaveBeenCalledWith({ name: "New", description: undefined });
    });
  });
});
```

- [ ] **Step 7.2: `apps/web/src/components/ProjectCard.tsx`**

```tsx
import { Link } from "@tanstack/react-router";
import type { Project } from "@/api/projects";

export function ProjectCard({
  project,
  onDelete,
}: {
  project: Project;
  onDelete: () => void;
}) {
  return (
    <article
      style={{
        padding: 16,
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <h3 style={{ margin: 0 }}>
        <Link to="/projects/$projectId" params={{ projectId: project.id }}>
          {project.name}
        </Link>
      </h3>
      {project.description && (
        <p style={{ margin: 0, opacity: 0.75, fontSize: 13 }}>{project.description}</p>
      )}
      <button
        onClick={() => {
          if (confirm(`Delete project "${project.name}"?`)) onDelete();
        }}
        style={{ alignSelf: "flex-start" }}
      >
        Delete
      </button>
    </article>
  );
}
```

- [ ] **Step 7.3: `apps/web/src/pages/ProjectsPage.tsx`**

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectsApi } from "@/api/projects";
import { ProjectCard } from "@/components/ProjectCard";

export function ProjectsPage() {
  const qc = useQueryClient();
  const projectsQ = useQuery({ queryKey: ["projects"], queryFn: projectsApi.list });
  const createM = useMutation({
    mutationFn: projectsApi.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
  const deleteM = useMutation({
    mutationFn: projectsApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 960, margin: "0 auto" }}>
      <header
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <h1 style={{ margin: 0 }}>Projects</h1>
        <button onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "New project"}
        </button>
      </header>

      {showForm && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await createM.mutateAsync({ name, description: description || undefined });
            setShowForm(false);
            setName("");
            setDescription("");
          }}
          style={{
            display: "grid",
            gap: 8,
            padding: 12,
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 10,
          }}
        >
          <label>
            Name
            <input
              required
              minLength={1}
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Description
            <input
              maxLength={4000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <button type="submit" disabled={createM.isPending}>
            {createM.isPending ? "Creating…" : "Create"}
          </button>
        </form>
      )}

      {projectsQ.isLoading && <p>Loading…</p>}
      {projectsQ.error && <p>Failed to load projects.</p>}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 12,
        }}
      >
        {projectsQ.data?.map((p) => (
          <ProjectCard key={p.id} project={p} onDelete={() => deleteM.mutate(p.id)} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 7.4: `apps/web/src/routes/projects.tsx`**

```tsx
import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { RequireAuth } from "@/auth/RequireAuth";
import { ProjectsPage } from "@/pages/ProjectsPage";

export const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: () => (
    <RequireAuth>
      <ProjectsPage />
    </RequireAuth>
  ),
});
```

- [ ] **Step 7.5: Replace `apps/web/src/main.tsx`** entirely with:

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { rootRoute } from "./routes/_root";
import { indexRoute } from "./routes/index";
import { loginRoute } from "./routes/login";
import { registerRoute } from "./routes/register";
import { projectsRoute } from "./routes/projects";
import "./styles/global.css";

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  projectsRoute,
]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000 } },
});

const el = document.getElementById("root");
if (!el) throw new Error("root element not found");
createRoot(el).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 7.6: Run tests + build**

```bash
cd apps/web
npm test -- --run
npm run build
```

Expected: previous 6 + 2 new = 8 tests pass; build succeeds.

- [ ] **Step 7.7: Commit**

```bash
git add apps/web/src apps/web/tests/projects-page.test.tsx
git commit -m "feat(web): Projects page (list/create/delete) with TanStack Query"
```

---

## Task 8: Web — Project detail (tasks + classes)

**Files:**
- Create: `apps/web/src/pages/ClassesEditor.tsx`
- Create: `apps/web/src/pages/NewTaskDialog.tsx`
- Create: `apps/web/src/pages/ProjectDetailPage.tsx`
- Create: `apps/web/src/routes/projects.$projectId.tsx`
- Modify: `apps/web/src/main.tsx` (register `projectDetailRoute`)
- Create: `apps/web/tests/classes-editor.test.tsx`

- [ ] **Step 8.1: Failing test** `apps/web/tests/classes-editor.test.tsx`

```tsx
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/classes", () => ({
  classesApi: {
    listForProject: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import { classesApi } from "@/api/classes";
import { ClassesEditor } from "@/pages/ClassesEditor";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("ClassesEditor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a class with idx + color", async () => {
    (classesApi.listForProject as any).mockResolvedValue([]);
    (classesApi.create as any).mockResolvedValue({
      id: "c1",
      project_id: "p1",
      idx: 0,
      name: "car",
      color: "#ff0000",
      attributes: {},
      created_at: "2026-01-01",
    });
    render(wrap(<ClassesEditor projectId="p1" />));
    fireEvent.change(await screen.findByLabelText(/class name/i), {
      target: { value: "car" },
    });
    fireEvent.change(screen.getByLabelText(/color/i), {
      target: { value: "#ff0000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add class/i }));
    await waitFor(() => {
      expect(classesApi.create).toHaveBeenCalledWith("p1", {
        idx: 0,
        name: "car",
        color: "#ff0000",
      });
    });
  });
});
```

- [ ] **Step 8.2: `apps/web/src/pages/ClassesEditor.tsx`**

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { classesApi, type ClassRow } from "@/api/classes";

export function ClassesEditor({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["classes", projectId],
    queryFn: () => classesApi.listForProject(projectId),
  });
  const create = useMutation({
    mutationFn: (input: { idx: number; name: string; color: string }) =>
      classesApi.create(projectId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["classes", projectId] }),
  });
  const remove = useMutation({
    mutationFn: (cid: string) => classesApi.delete(projectId, cid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["classes", projectId] }),
  });

  const [name, setName] = useState("");
  const [color, setColor] = useState("#ff0000");
  const nextIdx = (q.data ?? []).reduce((m, c) => Math.max(m, c.idx + 1), 0);

  return (
    <section style={{ display: "grid", gap: 12 }}>
      <h2 style={{ margin: 0 }}>Classes</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await create.mutateAsync({ idx: nextIdx, name, color });
          setName("");
        }}
        style={{ display: "flex", gap: 8, alignItems: "end" }}
      >
        <label style={{ flex: 1 }}>
          Class name
          <input
            required
            minLength={1}
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Color
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? "Adding…" : "Add class"}
        </button>
      </form>

      {q.isLoading && <p>Loading…</p>}
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 6 }}>
        {q.data?.map((c: ClassRow) => (
          <li
            key={c.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "8px 12px",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 6,
            }}
          >
            <span
              aria-label={`Class ${c.idx} color`}
              style={{
                width: 18,
                height: 18,
                background: c.color,
                borderRadius: 4,
                border: "1px solid rgba(255,255,255,0.2)",
              }}
            />
            <span style={{ width: 32, opacity: 0.6 }}>#{c.idx}</span>
            <span style={{ flex: 1 }}>{c.name}</span>
            <button
              onClick={() => {
                if (confirm(`Delete class "${c.name}"?`)) remove.mutate(c.id);
              }}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 8.3: `apps/web/src/pages/NewTaskDialog.tsx`**

```tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { tasksApi, type TaskKind } from "@/api/tasks";

export function NewTaskDialog({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TaskKind>("image");
  const create = useMutation({
    mutationFn: () => tasksApi.create(projectId, { name, kind }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks", projectId] });
      setName("");
      onCreated();
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
      style={{ display: "flex", gap: 8, alignItems: "end" }}
    >
      <label style={{ flex: 1 }}>
        Task name
        <input
          required
          minLength={1}
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        Kind
        <select value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
          <option value="image">Image set</option>
          <option value="video">Video</option>
        </select>
      </label>
      <button type="submit" disabled={create.isPending}>
        {create.isPending ? "Creating…" : "Add task"}
      </button>
    </form>
  );
}
```

- [ ] **Step 8.4: `apps/web/src/pages/ProjectDetailPage.tsx`**

```tsx
import { useQuery } from "@tanstack/react-query";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { ClassesEditor } from "./ClassesEditor";
import { NewTaskDialog } from "./NewTaskDialog";

export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId),
  });
  const tasksQ = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => tasksApi.listForProject(projectId),
  });

  if (projectQ.isLoading) return <p>Loading…</p>;
  if (projectQ.error || !projectQ.data) return <p>Project not found.</p>;
  const project = projectQ.data;

  return (
    <div style={{ display: "grid", gap: 24, maxWidth: 1100, margin: "0 auto" }}>
      <header>
        <h1 style={{ margin: 0 }}>{project.name}</h1>
        {project.description && <p style={{ opacity: 0.7 }}>{project.description}</p>}
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 24 }}>
        <section style={{ display: "grid", gap: 12 }}>
          <h2 style={{ margin: 0 }}>Tasks</h2>
          <NewTaskDialog projectId={projectId} onCreated={() => {}} />
          {tasksQ.isLoading && <p>Loading tasks…</p>}
          <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 6 }}>
            {tasksQ.data?.map((t) => (
              <li
                key={t.id}
                style={{
                  padding: 12,
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8,
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>{t.name}</span>
                <span style={{ opacity: 0.6, fontSize: 12 }}>{t.kind}</span>
              </li>
            ))}
            {(tasksQ.data?.length ?? 0) === 0 && !tasksQ.isLoading && (
              <li style={{ opacity: 0.6, fontSize: 13 }}>No tasks yet.</li>
            )}
          </ul>
        </section>
        <ClassesEditor projectId={projectId} />
      </div>
    </div>
  );
}
```

- [ ] **Step 8.5: `apps/web/src/routes/projects.$projectId.tsx`**

```tsx
import { createRoute, useParams } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { RequireAuth } from "@/auth/RequireAuth";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";

function Detail() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  return (
    <RequireAuth>
      <ProjectDetailPage projectId={projectId} />
    </RequireAuth>
  );
}

export const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: Detail,
});
```

- [ ] **Step 8.6: Update `apps/web/src/main.tsx`**

Add the import:

```ts
import { projectDetailRoute } from "./routes/projects.$projectId";
```

Update `routeTree`:

```ts
const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  projectsRoute,
  projectDetailRoute,
]);
```

- [ ] **Step 8.7: Run tests + build**

```bash
cd apps/web
npm test -- --run
npm run build
```

Expected: previous 8 + 1 new = 9 tests pass; build succeeds.

- [ ] **Step 8.8: Commit**

```bash
git add apps/web/src apps/web/tests/classes-editor.test.tsx
git commit -m "feat(web): project detail page with task list, new-task form, classes editor"
```

---

## Task 9: Home route redirect

**Files:**
- Modify: `apps/web/src/routes/index.tsx`

- [ ] **Step 9.1: Replace `apps/web/src/routes/index.tsx`**

```tsx
import { Navigate, createRoute } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { useAuth } from "@/auth/store";

function Home() {
  const token = useAuth((s) => s.accessToken);
  return <Navigate to={token ? "/projects" : "/login"} replace />;
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
});
```

- [ ] **Step 9.2: Smoke build**

```bash
npm run build
```

- [ ] **Step 9.3: Commit**

```bash
git add apps/web/src/routes/index.tsx
git commit -m "feat(web): home route redirects to /projects (or /login if anonymous)"
```

---

## Task 10: Tag the milestone

- [ ] **Step 10.1: Tag**

```bash
git tag -a v0.2.0-projects -m "Plan 02 complete: projects, tasks, classes (CRUD + nav UI)"
git log --oneline | head -15
```

---

## Self-Review

**Spec coverage cross-check:**

| Spec § | Implemented in |
|---|---|
| §5 Domain (Project, Task, Class) | Tasks 1–4 |
| §11 Class management (idx, name, color, attributes) | Task 4 (api), Task 8 (web) |
| §10 Image and video task kinds | Task 1 (`TaskKind`), Task 8 (`NewTaskDialog`) |
| §14 Auth (project ownership) | Task 2 (`_can_modify` helper) |

**Out of scope** (deferred):
- Asset upload → Plan 03
- Annotation creation → Plan 04
- Job assignment / membership table → revisit when multi-tenancy expands
- Class export-time remap → Plan 06
- Class taxonomy / parent-child → v2

**Placeholder scan:** No TBDs.

**Type consistency:** `Project`, `Task`, `TaskKind`, `Class`, `ClassIn`, `ProjectIn` types match across Pydantic schemas, ORM models, and TS interfaces.
