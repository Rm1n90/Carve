# Armin Mehri — mehri.armin@gmail.com
import uuid
from datetime import datetime, timezone

from sqlalchemy import delete as sa_delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from carve_api.auth.models import User, UserRole
from carve_api.errors import AppError, InsufficientRole, NotProjectMember
from carve_api.projects.models import Class, Project, ProjectMember, Task, TaskKind


# Plan-13 Phase 7 Task 2 — canonical role tuples used by ``require_project_role``.
# Mirror the CHECK constraint on ``project_members.role`` (see models.py).
_MUTATING_ROLES: tuple[str, ...] = ("owner", "admin", "member")
_READ_ROLES: tuple[str, ...] = ("owner", "admin", "member", "viewer")
_ADMIN_ROLES: tuple[str, ...] = ("owner", "admin")

# v3.32 -- mirror of ``_AVAILABLE_SAM_VARIANTS`` in
# models_info/router.py. Kept here as a separate literal (rather than
# imported) so the projects package does not develop a circular
# dependency on models_info, and so adding a new variant requires a
# deliberate edit in both places (intentional friction).
_ALLOWED_SAM_VARIANTS: frozenset[str] = frozenset(
    {
        "sam2.1-tiny",
        "sam2.1-small",
        "sam2.1-base+",
        "sam2.1-large",
        "sam3.1",
    }
)

# v3.32 -- sentinel used by ``ProjectService.update`` to distinguish
# "omitted (skip)" from "explicit None (clear)". A bare ``None`` cannot
# carry that distinction on its own, and ``Optional[Optional[str]]``
# isn't expressible in Python's type system without a marker.
_UNSET: object = object()


class ProjectNotFound(AppError):
    http_status = 404
    code = "project_not_found"


class NotProjectOwner(AppError):
    http_status = 403
    code = "not_project_owner"


class InvalidSamVariant(AppError):
    """Raised when ``default_sam_variant`` isn't in the API allow-list.

    v3.32. Surfaced to the client as 422 with the same allow-list the
    POST /models/sam-active endpoint validates against so the user gets
    a consistent error story regardless of which endpoint they touched.
    """

    http_status = 422
    code = "invalid_sam_variant"


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
    ) -> list[Project]:
        # Plan-13 Phase 7 Task 2 — workspace admins still see every project;
        # non-admin users see only projects with a matching ``project_members``
        # row (any role suffices for read).
        stmt = select(Project)
        if actor.role != UserRole.admin:
            stmt = stmt.join(
                ProjectMember, ProjectMember.project_id == Project.id
            ).where(ProjectMember.user_id == actor.id)
        if not include_deleted:
            stmt = stmt.where(Project.deleted_at.is_(None))
        stmt = stmt.order_by(Project.created_at.desc())
        return list(self.session.execute(stmt).scalars().unique())

    def list_visible_with_owner_email(
        self, *, actor: User, include_deleted: bool = False
    ) -> list[tuple[Project, str | None]]:
        """v3.3 Issue 2 — list visible projects with each owner's email.

        JOINs ``users`` to populate ``owner_email`` so the API can return
        a friendly label without forcing the client to N+1 GET each user.
        Uses an outer join so a soft-deleted owner row still yields the
        project with ``owner_email = None``.

        Plan-13 Phase 7 Task 2 — additionally filters by project membership
        for non-admin users so the listing matches ``list_visible``.
        """
        stmt = select(Project, User.email).outerjoin(
            User, User.id == Project.owner_id
        )
        if actor.role != UserRole.admin:
            stmt = stmt.join(
                ProjectMember, ProjectMember.project_id == Project.id
            ).where(ProjectMember.user_id == actor.id)
        if not include_deleted:
            stmt = stmt.where(Project.deleted_at.is_(None))
        stmt = stmt.order_by(Project.created_at.desc())
        rows = self.session.execute(stmt).unique().all()
        return [(p, email) for p, email in rows]

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

    def get_with_owner_email(
        self,
        *,
        actor: User,
        project_id: uuid.UUID,
        include_deleted: bool = False,
    ) -> tuple[Project, str | None]:
        """v3.3 Issue 2 — get a single project with its owner email.

        Re-uses :meth:`get` for the project lookup + permission semantics,
        then resolves the owner email in a separate ``session.get`` so
        existing tests for :meth:`get` are unaffected.
        """
        p = self.get(actor=actor, project_id=project_id, include_deleted=include_deleted)
        owner = self.session.get(User, p.owner_id)
        owner_email = owner.email if owner is not None else None
        return p, owner_email

    def update(
        self,
        *,
        actor: User,
        project_id: uuid.UUID,
        name: str | None = None,
        description: str | None = None,
        # v3.32 -- ``default_sam_variant`` uses a (set, value) pair so
        # the router can express "omitted" (skip the field) vs.
        # "explicit null" (clear the preference). ``_UNSET`` lives at
        # the module level; the router translates Pydantic's
        # ``model_fields_set`` into this contract.
        default_sam_variant: str | None | object = _UNSET,
        skip_owner_check: bool = False,
    ) -> Project:
        p = self.get(actor=actor, project_id=project_id)
        # Plan-13 Phase 7 Task 2 — when called from the router the
        # ``require_project_role`` gate has already authenticated the
        # caller against the project_members table. The legacy owner
        # check below remains for any direct service caller that has
        # not migrated yet (e.g. older test fixtures).
        if not skip_owner_check and not _can_modify(actor, p):
            raise NotProjectOwner("only owner or admin can modify a project")
        if name is not None:
            p.name = name
        if description is not None:
            p.description = description
        if default_sam_variant is not _UNSET:
            # Validate against the allow-list when a value is supplied.
            # ``None`` clears the preference; non-allowed strings raise.
            if default_sam_variant is not None:
                v = str(default_sam_variant).strip()
                if v == "":
                    p.default_sam_variant = None
                elif v not in _ALLOWED_SAM_VARIANTS:
                    raise InvalidSamVariant(
                        f"unknown SAM variant {v!r}; allowed: "
                        f"{sorted(_ALLOWED_SAM_VARIANTS)}"
                    )
                else:
                    p.default_sam_variant = v
            else:
                p.default_sam_variant = None
        self.session.flush()
        return p

    def delete(
        self, *, actor: User, project_id: uuid.UUID, skip_owner_check: bool = False
    ) -> None:
        """Soft-delete: set ``deleted_at = now()``. Restorable via /trash."""
        p = self.get(actor=actor, project_id=project_id)
        # Plan-13 Phase 7 Task 2 — see ``update`` for the rationale.
        if not skip_owner_check and not _can_modify(actor, p):
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


def require_visible_task(
    db: Session, user: User, task_id: uuid.UUID
) -> "Task":
    """Resolve a task only if visible to ``user``.

    Canonical helper shared by ``annotations.router`` and
    ``reviews.service`` so the visibility check has one home. Raises
    :class:`TaskNotFound` (404) when the task doesn't exist; relies on
    :class:`ProjectService.get` / :class:`TaskService.get` to surface
    project-level access failures as their own AppErrors. The caller is
    responsible for translating those AppErrors to HTTP responses (e.g.
    via the ``_http()`` mapper in routers).

    Plan-13 Phase 7 Task 2 — additionally enforces project membership.
    A user with no ``project_members`` row on the task's project gets
    :class:`TaskNotFound` (NOT a 403) so we never leak project existence
    via the auth boundary. Workspace admins are implicit members.
    """
    task = db.get(Task, task_id)
    if task is None:
        raise TaskNotFound("task not found")
    project = ProjectService(db).get(actor=user, project_id=task.project_id)
    TaskService(db).get(project=project, task_id=task.id)
    role = get_project_role(db, user.id, task.project_id)
    if role is None:
        # IDOR-safe: non-members must not be able to distinguish "task
        # exists in another project" from "task does not exist".
        raise TaskNotFound("task not found")
    return task


def get_project_role(
    db: Session, user_id: uuid.UUID, project_id: uuid.UUID
) -> str | None:
    """Return the user's role on the project, or ``None`` if not a member.

    Plan-13 Phase 7 Task 2 — workspace admins get an implicit ``"owner"``
    role on every project so existing test fixtures (and break-glass
    workspace admin operations) keep working without backfilling rows.
    """
    user = db.get(User, user_id)
    if user is not None and user.role == UserRole.admin:
        return "owner"
    return db.execute(
        select(ProjectMember.role).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == user_id,
        )
    ).scalar_one_or_none()


def require_project_role(
    db: Session,
    user: User,
    project_id: uuid.UUID,
    allowed: tuple[str, ...] = _MUTATING_ROLES,
) -> "Project":
    """Resolve a project and enforce that ``user`` has one of ``allowed`` roles.

    Plan-13 Phase 7 Task 2. Raises:
      * :class:`ProjectNotFound` (404) if the project doesn't exist or is soft-deleted
      * :class:`NotProjectMember` (403) if the user has no membership row
      * :class:`InsufficientRole` (403) if their role is not in ``allowed``

    Returns the live :class:`Project` so callers don't pay a second
    ``session.get`` round-trip.
    """
    project = db.get(Project, project_id)
    if project is None or project.deleted_at is not None:
        raise ProjectNotFound("project not found")
    role = get_project_role(db, user.id, project.id)
    if role is None:
        raise NotProjectMember("not a project member")
    if role not in allowed:
        raise InsufficientRole("insufficient role for this action")
    return project


class TaskService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def create(
        self,
        *,
        actor: User,
        project: Project,
        name: str,
        kind: TaskKind,
        due_date: datetime | None = None,
    ) -> Task:
        # v3.2 Issue 3 — snapshot the project's current class ids onto the
        # new task. Previously ``allowed_class_ids`` defaulted to ``NULL``,
        # which the effective-classes resolver treats as "all current
        # project classes" → adding a class to the project after the fact
        # made it appear in every existing task automatically. By
        # snapshotting at creation time, new project classes added later
        # are *not* injected into already-created tasks. The user can
        # explicitly clear the subset back to ``NULL`` (legacy "all" mode)
        # via the Edit-classes dialog.
        project_class_ids = [
            c.id for c in ClassService(self.session).list_for_project(project=project)
        ]
        t = Task(
            project_id=project.id,
            name=name,
            kind=kind,
            allowed_class_ids=project_class_ids,
            due_date=due_date,
        )
        self.session.add(t)
        self.session.flush()
        return t

    def list_for_project(
        self,
        *,
        project: Project,
        include_deleted: bool = False,
        include_archived: bool = False,
        only_archived: bool = False,
    ) -> list[Task]:
        stmt = select(Task).where(Task.project_id == project.id)
        if not include_deleted:
            stmt = stmt.where(Task.deleted_at.is_(None))
        if only_archived:
            stmt = stmt.where(Task.archived_at.is_not(None))
        elif not include_archived:
            stmt = stmt.where(Task.archived_at.is_(None))
        stmt = stmt.order_by(Task.created_at.desc())
        return list(self.session.execute(stmt).scalars())

    def update(
        self,
        *,
        project: Project,
        task_id: uuid.UUID,
        name: str | None = None,
        due_date: datetime | None = None,
        clear_due_date: bool = False,
        archived: bool | None = None,
        completed: bool | None = None,
        completed_by: uuid.UUID | None = None,
    ) -> Task:
        """Patch a task. ``clear_due_date`` distinguishes "leave alone"
        from "explicitly set to NULL" so the router can translate a
        payload ``due_date=null`` (key present) into the latter.
        ``archived=True`` sets ``archived_at`` to now; ``False`` clears.
        Plan-21 — ``completed=True`` stamps ``completed_at`` plus
        ``completed_by`` (supplied by the router from the current user);
        ``False`` clears both. ``None`` leaves the completion state alone.
        """
        t = self.get(project=project, task_id=task_id, include_deleted=False)
        if name is not None:
            t.name = name
        if clear_due_date:
            t.due_date = None
        elif due_date is not None:
            t.due_date = due_date
        if archived is True and t.archived_at is None:
            t.archived_at = datetime.now(timezone.utc)
        elif archived is False:
            t.archived_at = None
        if completed is True and t.completed_at is None:
            t.completed_at = datetime.now(timezone.utc)
            t.completed_by = completed_by
        elif completed is False:
            t.completed_at = None
            t.completed_by = None
        self.session.flush()
        return t

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

    def delete(self, *, actor: User, project: Project, task_id: uuid.UUID) -> None:  # noqa: ARG002
        """Soft-delete: set ``deleted_at = now()``. Restorable via /trash.

        Plan-13 Phase 7 Task 2 — authorisation moved to the router via
        ``require_project_role(_MUTATING_ROLES)``. The ``actor`` argument
        is retained for API stability but no longer drives the gate.
        """
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
        allowed_class_ids: list[uuid.UUID] | None = None,
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

        v3.2 Issue 4 — ``allowed_class_ids`` lets the caller override
        the duplicate's class subset. ``None`` (default) means "clone
        the source task's snapshot verbatim". ``[]`` means "duplicate
        with zero classes". A populated list is validated against the
        source project's class ids — cross-project ids raise
        ``ValueError`` so the router can return 422.
        """
        # Plan-13 Phase 7 Task 2 — authorisation moved to the router via
        # ``require_project_role(_MUTATING_ROLES)``. The ``actor`` argument
        # is retained for API stability but no longer drives the gate.
        _ = actor
        src = self.get(project=project, task_id=task_id)
        # v3.2 Issue 4 — override path. ``None`` = "keep source snapshot";
        # any list (including ``[]``) replaces it.
        if allowed_class_ids is None:
            # v3.1 Issue 3 — copy the task-scoped class subset onto the
            # new row so a duplicated task starts with the same scope.
            # ``None`` stays as ``None`` (legacy "all project classes").
            cloned_allowed = (
                list(src.allowed_class_ids)
                if src.allowed_class_ids is not None
                else None
            )
        else:
            # Validate the override ids belong to the source project —
            # cross-project ids must surface as 422 at the router layer.
            project_class_ids = {
                c.id
                for c in ClassService(self.session).list_for_project(project=project)
            }
            unique_override = list({cid for cid in allowed_class_ids})
            for cid in unique_override:
                if cid not in project_class_ids:
                    raise ValueError(
                        "allowed_class_ids contains an id that does not belong to "
                        "this project"
                    )
            cloned_allowed = unique_override
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
                allowed_class_ids=cloned_allowed,
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
                    allowed_class_ids=(
                        list(cloned_allowed) if cloned_allowed is not None else None
                    ),
                )
                self.session.add(t)
                new_tasks.append(t)
        self.session.flush()
        return new_tasks

    def get_effective_classes(
        self, *, project: Project, task: Task
    ) -> tuple[list["Class"], list[uuid.UUID] | None]:
        """Return the task's effective class list and its subset config.

        v3.1 Issue 3 (Option A). When ``task.allowed_class_ids`` is
        ``None`` we return *all* project classes — the default
        backward-compatible behaviour. Otherwise we return the project
        classes whose ids appear in ``allowed_class_ids`` (preserving the
        canonical project ordering by ``idx``).
        """
        all_classes = ClassService(self.session).list_for_project(project=project)
        if task.allowed_class_ids is None:
            return all_classes, None
        allowed = set(task.allowed_class_ids)
        effective = [c for c in all_classes if c.id in allowed]
        return effective, list(task.allowed_class_ids)

    def set_allowed_classes(
        self,
        *,
        actor: User,
        project: Project,
        task: Task,
        allowed_class_ids: list[uuid.UUID] | None,
    ) -> Task:
        """Update a task's class subset.

        Validates that every id in ``allowed_class_ids`` belongs to the
        same project — cross-project ids raise ``ValueError`` so the
        router can surface a 422.
        """
        # Plan-13 Phase 7 Task 2 — authorisation moved to the router via
        # ``require_project_role(_MUTATING_ROLES)``. The ``actor`` argument
        # is retained for API stability but no longer drives the gate.
        _ = actor
        if allowed_class_ids is not None:
            project_class_ids = {
                c.id
                for c in ClassService(self.session).list_for_project(project=project)
            }
            unique_ids = list({cid for cid in allowed_class_ids})
            for cid in unique_ids:
                if cid not in project_class_ids:
                    raise ValueError(
                        "allowed_class_ids contains an id that does not belong to "
                        "this project"
                    )
            task.allowed_class_ids = unique_ids
        else:
            task.allowed_class_ids = None
        self.session.flush()
        return task


class ClassConflict(AppError):
    http_status = 409
    code = "class_idx_or_name_conflict"


class ClassNotFound(AppError):
    http_status = 404
    code = "class_not_found"


class ClassHierarchyError(AppError):
    """v3.31 -- invalid parent_class_id assignment.

    Raised when the proposed parent is the class itself, lives in a
    different project, doesn't exist, or would create a cycle / exceed
    the depth limit of 8 levels in the IS-A chain.
    """

    http_status = 422
    code = "class_hierarchy_invalid"


# v3.31 -- bound on the parent-class chain depth. Deep enough for
# realistic ontologies (Vehicle -> Car -> Racing Car -> Formula 1 Car ->
# Formula 1 2024 Car) without letting the resolver walk a pathological
# chain forever. The same bound is enforced by ClassService and used by
# the resolver's ancestor walk.
MAX_CLASS_HIERARCHY_DEPTH: int = 8


class ClassService:
    def __init__(self, session: Session) -> None:
        self.session = session

    # v3.31 -- shared validation helper for parent_class_id. Raises
    # ClassHierarchyError when:
    #   * the proposed parent doesn't exist
    #   * lives in a different project
    #   * is the class itself (self-parent)
    #   * walking the proposed parent's chain UP would cycle back into
    #     ``class_id`` (the candidate child) or exceed MAX_CLASS_HIERARCHY_DEPTH
    #
    # ``class_id`` may be None when validating a brand-new class (which
    # has no id yet); in that case only the "parent exists, same project,
    # depth <= max" checks run and cycle prevention is structurally
    # impossible (a new class can't yet be referenced as anyone's parent).
    def _validate_parent(
        self,
        *,
        project: Project,
        class_id: uuid.UUID | None,
        parent_class_id: uuid.UUID,
    ) -> None:
        if class_id is not None and parent_class_id == class_id:
            raise ClassHierarchyError(
                "a class cannot be its own parent",
            )
        parent = self.session.get(Class, parent_class_id)
        if parent is None or parent.project_id != project.id:
            raise ClassHierarchyError(
                "parent class not found in this project",
            )
        # Walk the proposed parent's own chain UP. Detect cycles and
        # enforce the depth bound. Counting ``parent`` as level 1 means
        # MAX_CLASS_HIERARCHY_DEPTH=8 admits chains of up to 8 ancestors
        # above the new child -- a 9-level tree including the child
        # itself, comfortably above realistic ontologies.
        seen: set[uuid.UUID] = {parent.id}
        depth = 1
        cur = parent
        while cur.parent_class_id is not None:
            if depth >= MAX_CLASS_HIERARCHY_DEPTH:
                raise ClassHierarchyError(
                    f"parent chain would exceed depth limit "
                    f"({MAX_CLASS_HIERARCHY_DEPTH} levels)",
                )
            next_id = cur.parent_class_id
            if next_id == class_id:
                raise ClassHierarchyError(
                    "parent assignment would create a cycle",
                )
            if next_id in seen:
                # Defensive -- DB shouldn't carry a cycle but if a prior
                # bug introduced one, reject the new assignment loudly
                # rather than spinning forever.
                raise ClassHierarchyError(
                    "existing parent chain is cyclic; fix the data first",
                )
            seen.add(next_id)
            cur = self.session.get(Class, next_id)
            if cur is None:
                # Orphan reference -- treat as end of chain.
                break
            depth += 1

    def create(
        self,
        *,
        project: Project,
        idx: int,
        name: str,
        color: str,
        attributes: dict,
        text_prompt: str | None = None,
        parent_class_id: uuid.UUID | None = None,
    ) -> Class:
        if parent_class_id is not None:
            self._validate_parent(
                project=project,
                class_id=None,
                parent_class_id=parent_class_id,
            )
        c = Class(
            project_id=project.id,
            idx=idx,
            name=name,
            color=color,
            attributes=attributes,
            text_prompt=text_prompt,
            parent_class_id=parent_class_id,
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
        # v3.8 Phase 3 -- text_prompt is the one nullable patchable field
        # where None means "clear it", not "skip". Apply it directly when
        # the caller passed the key (router uses model_fields_set to
        # signal intent); the None-skip filter still protects every other
        # field from accidental clears via omitted PATCH bodies.
        # v3.31 -- parent_class_id follows the same explicit-None-clears
        # contract. When the caller supplies the key, we either clear
        # (None) or re-validate then apply.
        for k, v in fields.items():
            if k == "text_prompt":
                setattr(c, k, v)
                continue
            if k == "parent_class_id":
                if v is None:
                    c.parent_class_id = None
                else:
                    self._validate_parent(
                        project=project,
                        class_id=c.id,
                        parent_class_id=v,
                    )
                    c.parent_class_id = v
                continue
            if v is not None:
                setattr(c, k, v)
        try:
            self.session.flush()
        except IntegrityError as exc:
            self.session.rollback()
            raise ClassConflict("class idx or name already used in this project") from exc
        return c

    def delete(self, *, project: Project, class_id: uuid.UUID) -> None:
        # Plan-16 — cascade-delete annotations referencing this class.
        # The annotations.class_id FK is `RESTRICT`, so without this step
        # the class delete fails whenever any annotation still uses it.
        # User-visible behaviour: deleting a class also discards every
        # annotation that referenced it.
        from carve_api.annotations.models import Annotation

        c = self.get(project=project, class_id=class_id)
        self.session.execute(
            sa_delete(Annotation).where(Annotation.class_id == class_id)
        )
        self.session.delete(c)
        self.session.flush()

        # Plan-20.15 — re-densify the remaining classes' ``idx`` values
        # to a contiguous 0..N-1 sequence. Without this, deleting a
        # middle class leaves a hole in the index space (e.g. 0,1,3,4)
        # which (a) confuses the user — the third class still has idx=3
        # but is rendered second; and (b) means newly added classes get
        # sparse idx values, drifting further from what the export
        # produces (export already densifies). Annotations reference
        # ``class_id`` (UUID), not idx, so reindexing only changes the
        # display ordering — no data is moved or rewritten.
        #
        # ``UNIQUE(project_id, idx)`` forbids two classes sharing an
        # idx mid-update, so we use a two-phase approach: stage new
        # values into a guaranteed-empty negative-offset region, flush,
        # then apply the final 0..N-1 values.
        remaining = list(
            self.session.execute(
                select(Class)
                .where(Class.project_id == project.id)
                .order_by(Class.idx)
            ).scalars()
        )
        for parked_offset, cls in enumerate(remaining, start=1):
            cls.idx = -parked_offset
        self.session.flush()
        for new_idx, cls in enumerate(remaining):
            cls.idx = new_idx
        self.session.flush()

    def import_from_project(
        self, *, source: Project, dest: Project
    ) -> tuple[int, int]:
        """Copy classes from ``source`` project into ``dest`` project.

        Skips any class whose name already exists in the destination
        (uq_classes_project_name unique constraint). Returns
        ``(imported, skipped)``.

        v3.31 — two-pass so the IS-A hierarchy survives the import:

          1. Create every class without a parent (records src.id -> new.id
             mapping). Skips any name that already exists in dest.
          2. For each newly-imported class whose source had a parent,
             remap to the destination's equivalent class id. If the
             source's parent was itself skipped (because dest already had
             a class with that name) we point at the EXISTING dest class
             of the same name so the hierarchy still resolves -- the user
             likely just re-used the parent and expected it to apply.
        """
        existing_dest = self.list_for_project(project=dest)
        existing_names_to_dest_id: dict[str, uuid.UUID] = {
            c.name: c.id for c in existing_dest
        }
        next_idx = max((c.idx for c in existing_dest), default=-1) + 1

        src_classes = self.list_for_project(project=source)
        # Map ``source class id`` -> ``destination class id`` for any
        # source row that resolves to a dest row -- whether we just
        # imported it or it already existed under the same name.
        src_id_to_dest_id: dict[uuid.UUID, uuid.UUID] = {}
        # Track only the rows we ACTUALLY inserted so the parent remap
        # pass below doesn't try to patch dest classes that pre-existed.
        new_classes_with_src: list[tuple[Class, Class]] = []
        imported = 0
        skipped = 0
        for src_c in src_classes:
            if src_c.name in existing_names_to_dest_id:
                src_id_to_dest_id[src_c.id] = existing_names_to_dest_id[
                    src_c.name
                ]
                skipped += 1
                continue
            new_c = Class(
                project_id=dest.id,
                idx=next_idx,
                name=src_c.name,
                color=src_c.color,
                attributes=dict(src_c.attributes or {}),
                # v3.8 Phase 3 — carry the source's SAM 3 text prompt so
                # the duplicated project keeps its Text-SAM eligibility.
                text_prompt=src_c.text_prompt,
            )
            self.session.add(new_c)
            new_classes_with_src.append((src_c, new_c))
            next_idx += 1
            imported += 1
        # Flush so the inserted rows have stable PKs we can reference
        # from the second pass.
        self.session.flush()
        for src_c, new_c in new_classes_with_src:
            src_id_to_dest_id[src_c.id] = new_c.id
        # Second pass -- wire parents. Walking via the dest's id map
        # avoids self-referential races in the same transaction.
        for src_c, new_c in new_classes_with_src:
            if src_c.parent_class_id is None:
                continue
            mapped = src_id_to_dest_id.get(src_c.parent_class_id)
            if mapped is None:
                # Source's parent didn't make it across (skipped + no
                # name match in dest). Leave the new class as top-level.
                continue
            new_c.parent_class_id = mapped
        self.session.flush()
        return imported, skipped
