import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from vaa_api.annotations.models import Annotation, AnnotationKind
from vaa_api.errors import AppError
from vaa_api.projects.models import Class, Task


class AnnotationInvalid(AppError):
    http_status = 422
    code = "annotation_invalid"


class AnnotationNotFound(AppError):
    http_status = 404
    code = "annotation_not_found"


def _validate_geometry(kind: AnnotationKind, g: dict) -> None:
    if kind == AnnotationKind.bbox:
        keys = {"x", "y", "w", "h"}
        if not keys.issubset(g) or g["w"] <= 0 or g["h"] <= 0:
            raise AnnotationInvalid("bbox geometry must include x,y,w>0,h>0")
    elif kind == AnnotationKind.polygon:
        pts = g.get("points")
        if not isinstance(pts, list) or len(pts) < 3 or any(len(p) != 2 for p in pts):
            raise AnnotationInvalid("polygon geometry needs at least 3 [x,y] points")
    elif kind == AnnotationKind.mask:
        if "size" not in g or "counts" not in g:
            raise AnnotationInvalid("mask geometry needs size and counts (RLE)")
    elif kind == AnnotationKind.tag:
        if g not in ({}, {"kind": "tag"}):
            raise AnnotationInvalid("tag geometry must be empty")


class AnnotationService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def create(self, *, task: Task, actor_id, frame_id, class_id, kind, geometry, track_id) -> Annotation:
        cls = self.session.get(Class, class_id)
        if cls is None or cls.project_id != task.project_id:
            raise AnnotationInvalid("class not in this project")
        _validate_geometry(kind, geometry)
        a = Annotation(
            task_id=task.id, frame_id=frame_id, class_id=class_id,
            kind=kind, geometry=geometry, track_id=track_id, created_by=actor_id,
        )
        self.session.add(a)
        self.session.flush()
        return a

    def list_for_task(self, *, task: Task, frame_id=None) -> list[Annotation]:
        q = select(Annotation).where(Annotation.task_id == task.id)
        if frame_id is not None:
            q = q.where(Annotation.frame_id == frame_id)
        return list(self.session.execute(q.order_by(Annotation.created_at)).scalars())

    def update(self, *, task: Task, annotation_id, **patch) -> Annotation:
        a = self.session.get(Annotation, annotation_id)
        if a is None or a.task_id != task.id:
            raise AnnotationNotFound("annotation not found")
        # Cross-project class reassignment must be rejected to match create() invariant.
        if patch.get("class_id") is not None:
            cls = self.session.get(Class, patch["class_id"])
            if cls is None or cls.project_id != task.project_id:
                raise AnnotationInvalid("class not in this project")
        if patch.get("geometry") is not None:
            _validate_geometry(a.kind, patch["geometry"])
            a.geometry = patch["geometry"]
        for k in ("class_id", "track_id"):
            if patch.get(k) is not None:
                setattr(a, k, patch[k])
        self.session.flush()
        return a

    def delete(self, *, task: Task, annotation_id) -> None:
        a = self.session.get(Annotation, annotation_id)
        if a is None or a.task_id != task.id:
            raise AnnotationNotFound("annotation not found")
        self.session.delete(a)
        self.session.flush()
