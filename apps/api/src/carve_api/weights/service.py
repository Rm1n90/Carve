import logging
import uuid
from io import BytesIO

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.errors import AppError
from carve_api.inference.model_client import ModelServiceError, yolo_inspect
from carve_api.projects.models import Project
from carve_api.projects.service import _can_modify
from carve_api.storage.client import MinioClient
from carve_api.storage.hashing import stream_xxh3_128
from carve_api.weights.models import (
    Weight,
    WeightAssignment,
    WeightProjectDefault,
    WeightTaskKind,
)

log = logging.getLogger(__name__)

# Task kinds the model service is allowed to override the user's choice with.
# Anything outside this set is ignored — keeps the enum in sync with
# ``WeightTaskKind`` without coupling the inspect contract to SQLAlchemy.
_VALID_TASK_KINDS: frozenset[str] = frozenset(k.value for k in WeightTaskKind)


_MAX_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB cap on .pt files


class WeightTooLarge(AppError):
    http_status = 413
    code = "weight_too_large"


class WeightInvalid(AppError):
    http_status = 400
    code = "weight_invalid"


class WeightNotFound(AppError):
    http_status = 404
    code = "weight_not_found"


class WeightForbidden(AppError):
    http_status = 403
    code = "weight_forbidden"


class WeightService:
    def __init__(self, session: Session) -> None:
        self.session = session
        self.storage = MinioClient.from_settings()

    def upload(
        self,
        *,
        project: Project | None,
        name: str,
        task_kind: WeightTaskKind,
        class_names: list[str],
        original_name: str,
        body: bytes,
        actor: User,
    ) -> Weight:
        """Upload a new YOLO weight.

        v3.5 Phase F5 — ``project`` is optional. When ``None`` the
        weight is workspace-wide (visible/usable from every project);
        legacy callers that pass a project keep the per-project
        scoping. The upload endpoint decides which mode to use based
        on whether the request hits the project-scoped or the
        workspace-scoped URL.
        """
        if len(body) > _MAX_BYTES:
            raise WeightTooLarge("weight exceeds 2 GiB")
        if not original_name.lower().endswith(".pt"):
            raise WeightInvalid("only .pt files are accepted")
        # `class_names` is allowed to be empty — the model itself ships its
        # `names` dict and the auto-annotate path reads `det.class_name`
        # to map back to project classes by name. The frontend dialog
        # therefore submits `[]` and lets the user manage class mapping
        # via project classes. Non-empty lists must still be all-strings.
        if any(not isinstance(n, str) or not n for n in class_names):
            raise WeightInvalid("class_names must be a list of non-empty strings")
        # Lightweight pickle sanity check: a real .pt file is a zip archive (PK\x03\x04)
        # or a legacy pickle (\x80\x02-style). Bytes shorter than ~16 bytes can't be valid.
        if len(body) < 16:
            raise WeightInvalid("file too small to be a YOLO weight")

        h = stream_xxh3_128(BytesIO(body))
        weight_id = uuid.uuid4()
        key = f"weights/{h}/{weight_id}.pt"
        self.storage.ensure_bucket()
        self.storage.put_object(key, BytesIO(body), len(body), "application/octet-stream")

        # v3.3 fix (audit issue 3a): ask the model service to parse the .pt
        # for ``model.names`` so the row gets the real class table instead of
        # the form-supplied ``[]``. The model service is opt-in via the
        # ``inference`` docker-compose profile, so a 503 / connect failure
        # here is expected on dev rigs without it — we log and fall back to
        # the user-supplied ``class_names`` rather than failing the upload.
        inspected_names, inspected_task = _inspect_weight(body, original_name)
        final_class_names = inspected_names if inspected_names else class_names
        final_task_kind = task_kind
        if inspected_task is not None and inspected_task != task_kind.value:
            try:
                final_task_kind = WeightTaskKind(inspected_task)
            except ValueError:
                final_task_kind = task_kind

        w = Weight(
            id=weight_id,
            project_id=project.id if project is not None else None,
            name=name,
            task_kind=final_task_kind,
            minio_key=key,
            size_bytes=len(body),
            class_names=final_class_names,
            created_by=actor.id,
        )
        self.session.add(w)
        self.session.flush()
        # v3.5 Phase F4 — historical name-match seeding into
        # ``weight_class_mappings`` is gone (the table is dropped in
        # migration 0017). The predict popover now fetches per-task
        # mapping suggestions on demand and persists user picks via
        # ``class_overrides`` on the auto-annotate request body.
        return w

    def list_for_project(self, *, project: Project) -> list[Weight]:
        """Return weights visible from this project.

        v3.5 Phase F5 — both workspace-wide weights (``project_id IS
        NULL``) and project-scoped weights (``project_id == project.id``)
        are returned, newest first.

        v3.7 Phase 3 Issue 4 — also unions weights joined via
        ``weight_assignments`` so a weight explicitly assigned to this
        project is visible regardless of its ``Weight.project_id``.
        """
        assigned_ids_subq = (
            select(WeightAssignment.weight_id)
            .where(WeightAssignment.project_id == project.id)
            .scalar_subquery()
        )
        return list(
            self.session.execute(
                select(Weight)
                .where(
                    or_(
                        Weight.project_id.is_(None),
                        Weight.project_id == project.id,
                        Weight.id.in_(assigned_ids_subq),
                    )
                )
                .order_by(Weight.created_at.desc())
            ).scalars()
        )

    def list_assignments(self, *, weight_id: uuid.UUID) -> list[tuple[WeightAssignment, str]]:
        """v3.7 Phase 3 Issue 4 — list ``(assignment_row, project_name)``
        pairs for the given weight, newest assignment first.

        The router serialises this into ``WeightAssignmentOut`` so the UI
        gets ``project_name`` without an extra round-trip.
        """
        from carve_api.projects.models import Project as _Project

        rows = self.session.execute(
            select(WeightAssignment, _Project.name)
            .join(_Project, _Project.id == WeightAssignment.project_id)
            .where(WeightAssignment.weight_id == weight_id)
            .order_by(WeightAssignment.created_at.desc())
        ).all()
        return [(row[0], row[1]) for row in rows]

    def add_assignment(
        self, *, weight_id: uuid.UUID, project_id: uuid.UUID
    ) -> WeightAssignment:
        """v3.7 Phase 3 Issue 4 — assign ``weight_id`` to ``project_id``.

        Idempotent: when the (weight, project) pair already exists, the
        existing row is returned unchanged. Validates that both the
        weight and the project exist; raises :class:`WeightNotFound` on
        a missing weight (the project existence is enforced by the FK
        ``ON DELETE CASCADE`` constraint at write time).
        """
        # Touch the weight first so missing-weight errors stay 404.
        _ = self.get(weight_id=weight_id)
        existing = self.session.get(WeightAssignment, (weight_id, project_id))
        if existing is not None:
            return existing
        row = WeightAssignment(weight_id=weight_id, project_id=project_id)
        self.session.add(row)
        self.session.flush()
        return row

    def remove_assignment(
        self, *, weight_id: uuid.UUID, project_id: uuid.UUID
    ) -> None:
        """v3.7 Phase 3 Issue 4 — remove the (weight, project) assignment
        if present. Idempotent: a missing row is a no-op.
        """
        existing = self.session.get(WeightAssignment, (weight_id, project_id))
        if existing is None:
            return
        self.session.delete(existing)
        self.session.flush()

    def is_assigned(
        self, *, weight_id: uuid.UUID, project_id: uuid.UUID
    ) -> bool:
        """v3.7 Phase 3 Issue 4 — does ``weight_id`` have an assignment
        row for ``project_id``? Used by the auto-annotate access check.
        """
        row = self.session.get(WeightAssignment, (weight_id, project_id))
        return row is not None

    def list_workspace(self) -> list[Weight]:
        """All weights in the workspace, newest first."""
        return list(
            self.session.execute(
                select(Weight).order_by(Weight.created_at.desc())
            ).scalars()
        )

    def list_default_weight_ids_for_project(
        self, *, project_id: uuid.UUID
    ) -> dict[str, uuid.UUID]:
        """Return ``{task_kind_value: weight_id}`` for the project's
        defaults. Used by the listing endpoints to flag which weights
        currently serve as a default for the given project.
        """
        rows = list(
            self.session.execute(
                select(WeightProjectDefault).where(
                    WeightProjectDefault.project_id == project_id
                )
            ).scalars()
        )
        return {row.task_kind.value: row.weight_id for row in rows}

    def get(self, *, weight_id: uuid.UUID) -> Weight:
        w = self.session.get(Weight, weight_id)
        if w is None:
            raise WeightNotFound("weight not found")
        return w

    def delete(self, *, weight_id: uuid.UUID) -> None:
        """Delete a weight + its blob.

        v3.5 Phase F5 — caller is responsible for the permission check
        (workspace-wide weights need admin; project-scoped weights use
        the per-project owner/admin gate). Centralised in the router's
        ``_weight_can_modify`` helper.
        """
        w = self.get(weight_id=weight_id)
        try:
            self.storage.remove_object(w.minio_key)
        except Exception:
            pass  # best-effort; row removal is the source of truth
        self.session.delete(w)
        self.session.flush()

    def set_default(
        self,
        *,
        weight_id: uuid.UUID,
        project_id: uuid.UUID,
        task_kind: WeightTaskKind,
    ) -> Weight:
        """Pin ``weight_id`` as the project's default for ``task_kind``.

        v3.5 Phase F5 — writes to ``weight_project_defaults``. The
        ``(project_id, task_kind)`` primary key replaces v3.3's partial
        unique index on ``weights.is_default``. The weight's own
        ``project_id`` is unchanged so a workspace-wide weight can serve
        as a default in many projects without losing its workspace
        scope.

        Validates that the weight is visible from this project (either
        workspace-wide or scoped to this same project) and that its
        ``task_kind`` matches the slot.
        """
        w = self.get(weight_id=weight_id)
        if w.project_id is not None and w.project_id != project_id:
            raise WeightNotFound("weight not found")
        if w.task_kind != task_kind:
            raise WeightInvalid(
                "weight task_kind does not match the requested default slot"
            )
        existing = self.session.get(
            WeightProjectDefault, (project_id, task_kind)
        )
        if existing is None:
            self.session.add(
                WeightProjectDefault(
                    project_id=project_id,
                    task_kind=task_kind,
                    weight_id=weight_id,
                )
            )
        else:
            existing.weight_id = weight_id
        self.session.flush()
        return w

    def get_default_for_kind(
        self, *, project_id: uuid.UUID, task_kind: WeightTaskKind
    ) -> Weight | None:
        """Return the project's default weight for the given task kind, if any."""
        row = self.session.execute(
            select(WeightProjectDefault).where(
                WeightProjectDefault.project_id == project_id,
                WeightProjectDefault.task_kind == task_kind,
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        return self.session.get(Weight, row.weight_id)


def _inspect_weight(body: bytes, original_name: str) -> tuple[list[str], str | None]:
    """Best-effort call to the model service to extract ``names`` from a .pt.

    Returns ``(class_names, task_kind)``. On any failure (model service down,
    422 from the parser, malformed pickle, etc.) returns ``([], None)`` so
    the caller falls back to its existing values. The upload path treats
    this as enrichment, never as a hard requirement.
    """
    try:
        result = yolo_inspect(body, filename=original_name or "weight.pt")
    except ModelServiceError as exc:
        if exc.status_code == 503:
            log.warning(
                "weight upload: model service unavailable; class names not extracted"
            )
        else:
            log.warning(
                "weight upload: yolo_inspect returned %s: %r",
                exc.status_code,
                exc.body,
            )
        return [], None
    except Exception as exc:  # noqa: BLE001 — never fail upload for an enrichment call
        log.warning("weight upload: yolo_inspect raised %s: %s", type(exc).__name__, exc)
        return [], None

    raw_names = result.get("class_names") or []
    names = [str(n) for n in raw_names if isinstance(n, str)]
    task = result.get("task_kind")
    if isinstance(task, str) and task in _VALID_TASK_KINDS:
        return names, task
    return names, None
