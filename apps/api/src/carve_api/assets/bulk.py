# Armin Mehri — mehri.armin@gmail.com
"""Bulk delete and bulk move of a task's images, with a preview first.

The grid shows the preview before either runs: how many of the selected
images are annotated and with how many annotations (a delete takes them
too), and for a move which annotation classes the target task does not
use, which file names it already has and which images it already holds.

Both refuse while a job is working through either task: a Logo AI run
or a batch (auto-annotate, YOLO/YOLOE, SAM, export) walks the task's
images by position, so taking images out of the list or adding some
under it would make it skip or repeat images.
"""

from __future__ import annotations

import logging
import uuid
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation
from carve_api.assets.models import Asset, Frame
from carve_api.errors import AppError
from carve_api.projects.models import Class, Task

log = logging.getLogger(__name__)

# One request at a time is bounded; a larger selection goes in batches.
MAX_ASSETS = 20_000


class BulkError(AppError):
    http_status = 409
    code = "bulk_refused"


class SelectionChanged(BulkError):
    """The images or their annotations changed since the preview."""

    code = "selection_changed"


class BadTarget(BulkError):
    code = "bad_target"


def busy_reason(session: Session, task_ids: list[uuid.UUID]) -> str | None:
    """Why images cannot be taken out of or put into these tasks now."""
    from carve_api.logo_ai.models import TERMINAL_STATUSES, LogoAiJob

    running = session.execute(
        select(LogoAiJob.task_id).where(
            LogoAiJob.task_id.in_(task_ids), LogoAiJob.status.notin_(TERMINAL_STATUSES)
        )
    ).first()
    if running:
        return "logo_ai_running"
    try:
        from rq.job import Job
        from rq.queue import Queue
        from rq.registry import StartedJobRegistry

        from carve_api.jobs.queue import _LANES, rq_connection

        conn = rq_connection()
        ids: list[str] = []
        for lane in _LANES:
            ids += Queue(lane, connection=conn).job_ids
            ids += StartedJobRegistry(lane, connection=conn).get_job_ids()
        needles = [str(t) for t in task_ids]
        for job in Job.fetch_many(ids, connection=conn):
            if job is not None and any(n in (job.description or "") for n in needles):
                return "job_running"
    except Exception:  # noqa: BLE001 -- no Redis, no worker running a batch either
        log.warning("bulk: could not read the job queues", exc_info=True)
    return None


@dataclass
class Selection:
    assets: list[Asset]
    missing: int
    annotations_by_class: Counter = field(default_factory=Counter)
    annotated_assets: int = 0

    @property
    def annotations(self) -> int:
        return sum(self.annotations_by_class.values())


def load_selection(session: Session, task: Task, asset_ids: list[uuid.UUID]) -> Selection:
    wanted = list(dict.fromkeys(asset_ids))
    assets = list(
        session.execute(
            select(Asset).where(Asset.task_id == task.id, Asset.id.in_(wanted))
        ).scalars()
    )
    sel = Selection(assets=assets, missing=len(wanted) - len(assets))
    if not assets:
        return sel
    rows = session.execute(
        select(Frame.asset_id, Annotation.class_id, func.count())
        .join(Annotation, Annotation.frame_id == Frame.id)
        .where(Frame.asset_id.in_([a.id for a in assets]), Annotation.task_id == task.id)
        .group_by(Frame.asset_id, Annotation.class_id)
    ).all()
    annotated = set()
    for asset_id, class_id, n in rows:
        sel.annotations_by_class[class_id] += n
        annotated.add(asset_id)
    sel.annotated_assets = len(annotated)
    return sel


def class_names(session: Session, class_ids) -> dict[uuid.UUID, str]:
    ids = list(class_ids)
    if not ids:
        return {}
    return dict(session.execute(select(Class.id, Class.name).where(Class.id.in_(ids))).all())


@dataclass
class MovePlan:
    move: list[Asset]
    already_in_target: list[Asset]
    renames: dict[uuid.UUID, str]
    missing_classes: Counter


def renamed(name: str, asset_id: uuid.UUID) -> str:
    p = Path(name)
    return f"{p.stem}_{str(asset_id)[:8]}{p.suffix}"


def plan_move(
    session: Session, sel: Selection, source: Task, target: Task, *, skip_duplicates: bool
) -> MovePlan:
    hashes = {a.xxh3_128 for a in sel.assets}
    in_target = set(
        session.execute(
            select(Asset.xxh3_128).where(Asset.task_id == target.id, Asset.xxh3_128.in_(hashes))
        ).scalars()
    )
    dup = [a for a in sel.assets if a.xxh3_128 in in_target] if skip_duplicates else []
    dup_ids = {a.id for a in dup}
    move = [a for a in sel.assets if a.id not in dup_ids]
    # Exports write files by their original name: a name the target
    # already has, or one two moved images share, gets the asset id.
    names = {a.original_name for a in move}
    taken = set(
        session.execute(
            select(Asset.original_name).where(
                Asset.task_id == target.id, Asset.original_name.in_(names)
            )
        ).scalars()
    )
    seen: Counter = Counter(a.original_name for a in move)
    renames = {
        a.id: renamed(a.original_name, a.id)
        for a in move
        if a.original_name in taken or seen[a.original_name] > 1
    }
    missing: Counter = Counter()
    if target.allowed_class_ids is not None and move:
        allowed = set(target.allowed_class_ids)
        rows = session.execute(
            select(Annotation.class_id, func.count())
            .join(Frame, Frame.id == Annotation.frame_id)
            .where(Frame.asset_id.in_([a.id for a in move]), Annotation.task_id == source.id)
            .group_by(Annotation.class_id)
        ).all()
        for class_id, n in rows:
            if class_id not in allowed:
                missing[class_id] += n
    return MovePlan(move=move, already_in_target=dup, renames=renames, missing_classes=missing)


def apply_move(
    session: Session, source: Task, target: Task, plan: MovePlan, *, missing_classes: str
) -> dict[str, int]:
    """Move the images, their frames' annotations with them. Not committed."""
    ids = [a.id for a in plan.move]
    if not ids:
        return {"moved": 0, "annotations_moved": 0, "annotations_dropped": 0, "classes_enabled": 0}
    frame_ids = select(Frame.id).where(Frame.asset_id.in_(ids))
    dropped = enabled = 0
    if plan.missing_classes:
        if missing_classes == "drop":
            dropped = session.execute(
                delete(Annotation).where(
                    Annotation.task_id == source.id,
                    Annotation.frame_id.in_(frame_ids),
                    Annotation.class_id.in_(list(plan.missing_classes)),
                )
            ).rowcount
        else:
            add = [c for c in plan.missing_classes if c not in set(target.allowed_class_ids or [])]
            target.allowed_class_ids = [*(target.allowed_class_ids or []), *add]
            enabled = len(add)
    moved_anns = session.execute(
        update(Annotation)
        .where(Annotation.task_id == source.id, Annotation.frame_id.in_(frame_ids))
        .values(task_id=target.id)
        .execution_options(synchronize_session=False)
    ).rowcount
    session.execute(
        update(Asset)
        .where(Asset.id.in_(ids), Asset.task_id == source.id)
        .values(task_id=target.id)
        .execution_options(synchronize_session=False)
    )
    for asset_id, name in plan.renames.items():
        session.execute(
            update(Asset)
            .where(Asset.id == asset_id)
            .values(original_name=name)
            .execution_options(synchronize_session=False)
        )
    session.flush()
    return {
        "moved": len(ids),
        "annotations_moved": moved_anns,
        "annotations_dropped": dropped,
        "classes_enabled": enabled,
    }


def delete_assets(session: Session, assets: list[Asset]) -> list[str]:
    """Delete the rows (frames and annotations go with them by cascade).

    Not committed. Returns the storage keys no other asset uses any more;
    the caller removes them after the commit, so a failed commit leaves
    every image whole.
    """
    keys: list[tuple[str, str]] = []
    for a in assets:
        ext = a.original_name.rsplit(".", 1)[-1] if "." in a.original_name else "bin"
        keys.append((a.xxh3_128, f"assets/{a.xxh3_128}/original.{ext}"))
        if a.thumbnail_minio_key:
            keys.append((a.xxh3_128, a.thumbnail_minio_key))
    ids = [a.id for a in assets]
    session.execute(
        delete(Asset).where(Asset.id.in_(ids)).execution_options(synchronize_session=False)
    )
    session.flush()
    hashes = {h for h, _ in keys}
    still_used = set(
        session.execute(select(Asset.xxh3_128).where(Asset.xxh3_128.in_(hashes))).scalars()
    )
    return sorted({k for h, k in keys if h not in still_used})
