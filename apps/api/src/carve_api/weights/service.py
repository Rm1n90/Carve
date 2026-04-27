import uuid
from io import BytesIO

from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.errors import AppError
from carve_api.projects.models import Project
from carve_api.projects.service import _can_modify
from carve_api.storage.client import MinioClient
from carve_api.storage.hashing import stream_xxh3_128
from carve_api.weights.models import Weight, WeightTaskKind


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

        w = Weight(
            id=weight_id,
            project_id=project.id,
            name=name,
            task_kind=task_kind,
            minio_key=key,
            size_bytes=len(body),
            class_names=class_names,
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
