import logging
import uuid
from io import BytesIO

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.errors import AppError
from carve_api.inference.model_client import ModelServiceError, yolo_inspect
from carve_api.projects.models import Project
from carve_api.projects.service import _can_modify
from carve_api.storage.client import MinioClient
from carve_api.storage.hashing import stream_xxh3_128
from carve_api.weights.models import Weight, WeightTaskKind

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
        project: Project,
        name: str,
        task_kind: WeightTaskKind,
        class_names: list[str],
        original_name: str,
        body: bytes,
        actor: User,
    ) -> Weight:
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
            project_id=project.id,
            name=name,
            task_kind=final_task_kind,
            minio_key=key,
            size_bytes=len(body),
            class_names=final_class_names,
            created_by=actor.id,
        )
        self.session.add(w)
        self.session.flush()
        return w

    def list_for_project(self, *, project: Project) -> list[Weight]:
        return list(
            self.session.execute(
                select(Weight)
                .where(Weight.project_id == project.id)
                .order_by(Weight.created_at.desc())
            ).scalars()
        )

    def get(self, *, weight_id: uuid.UUID) -> Weight:
        w = self.session.get(Weight, weight_id)
        if w is None:
            raise WeightNotFound("weight not found")
        return w

    def delete(self, *, actor: User, project: Project, weight_id: uuid.UUID) -> None:
        if not _can_modify(actor, project):
            raise WeightForbidden("only project owner or admin can delete weights")
        w = self.get(weight_id=weight_id)
        if w.project_id != project.id:
            raise WeightNotFound("weight not found")
        try:
            self.storage.remove_object(w.minio_key)
        except Exception:
            pass  # best-effort; row removal is the source of truth
        self.session.delete(w)
        self.session.flush()

    def set_default(self, *, weight_id: uuid.UUID, project_id: uuid.UUID) -> Weight:
        """Mark `weight_id` as the default for its `(project_id, task_kind)` slot.

        v3.3 Issue 4 — clears any sibling default in the same project + task
        kind first, then flips this one to default. Both writes happen in the
        same SQLAlchemy session; the partial unique index added in migration
        ``0015_weight_is_default`` guards against any race that would otherwise
        leave two defaults for the same slot.
        """
        w = self.get(weight_id=weight_id)
        if w.project_id != project_id:
            raise WeightNotFound("weight not found")
        # Clear sibling default first so the partial unique index doesn't see
        # two `is_default=true` rows mid-transaction.
        self.session.execute(
            update(Weight)
            .where(
                Weight.project_id == project_id,
                Weight.task_kind == w.task_kind,
                Weight.id != w.id,
                Weight.is_default.is_(True),
            )
            .values(is_default=False)
        )
        w.is_default = True
        self.session.flush()
        return w

    def get_default_for_kind(
        self, *, project_id: uuid.UUID, task_kind: WeightTaskKind
    ) -> Weight | None:
        """Return the project's default weight for the given task kind, if any."""
        return self.session.execute(
            select(Weight).where(
                Weight.project_id == project_id,
                Weight.task_kind == task_kind,
                Weight.is_default.is_(True),
            )
        ).scalar_one_or_none()


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
