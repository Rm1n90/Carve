# Armin Mehri — mehri.armin@gmail.com
"""Every box of a task to a polygon or a mask, on the worker.

The editor's "in all assets" convert ran in the browser and had to load
every box of the task first, which a task of a million boxes cannot do
(and a tab left open for a day is not a job). This runs the same
conversion image by image on a worker: one model call per image (see
``carve_model.sam.box_convert``), one commit per image, resumable from
the cursor like the other chunked batches.

The shape of each box follows its class (spec v1), the same table as
the web client's ``samModeForClass``. A box SAM finds nothing in stays a
box; a crowd box joined into the touching crowd box is deleted (that
one now covers it). The model's scores on a converted box are kept: the
shape is the same object, not a person's correction.

Progress lives in the usual ``aa:job:`` hash, plus what the progress
dialog shows: the image in work, counts of polygons, masks, merged
crowds and boxes left, and a per-image log (newest last) the dialog
draws its latest results from.
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, Frame
from carve_api.errors import AppError
from carve_api.inference.batch import (
    _b2s,
    _run_with_admission_retry,
    _status_is_canceled,
    _truncated_repr,
    begin_chunk,
    finalize_progress,
    list_assets_for_task,
    progress_key,
    read_progress,
    write_cursor,
)
from carve_api.inference.model_client import ModelServiceError
from carve_api.projects.models import Class, Task

log = logging.getLogger(__name__)

KIND = "sam-box-convert"
# The model service takes at most this many boxes per call.
MAX_BOXES_PER_CALL = 2000
# Per-image log entries the dialog can read back.
LOG_MAX = 30000
# A converted box SAM scored below this is counted as "low score".
LOW_SCORE = 0.5
# The task's latest convert job, so a reopened dialog finds it.
_TASK_KEY = "sam-box-convert:task:"
_KEEP_SECONDS = 30 * 24 * 3600
# The conversion needs SAM 3.1's text prompts (ground, crowd, nets).
SAM_VARIANT = "sam3.1"
_SAM_WAIT_S = 600
# Longer than any one image (and the wait for SAM to come back).
STALLED_AFTER_S = 20 * 60

# Spec v1: how a class's box becomes a shape. Same table as the web
# client's ``samModeForClass`` (apps/web/src/lib/samConvert.ts).
FLAT_CLASSES = frozenset(
    {
        "board_static",
        "board_led",
        "backdrop",
        "banner_flag",
        "handheld_board",
        "ground_mat",
        "video_screen",
        "podium_step",
        "official_table",
        "boat_hull",
        "sail",
    }
)
SPECIAL_CLASSES = {
    "ground_surface": "ground",
    "crowd": "crowd",
    "graphic_overlay": "overlay",
    "glass_wall": "carrier",
    "goal_net_frame": "net",
    "ring_ropes_cage": "ropes",
}


def mode_for_class(name: str | None) -> str:
    if not name:
        return "object"
    if name in SPECIAL_CLASSES:
        return SPECIAL_CLASSES[name]
    return "flat" if name in FLAT_CLASSES else "object"


def task_key(task_id) -> str:
    return f"{_TASK_KEY}{task_id}"


def log_key(job_id: str) -> str:
    return f"{progress_key(job_id)}:log"


def assets_key(job_id: str) -> str:
    """The images a run over a selection covers, for a resume."""
    return f"{progress_key(job_id)}:assets"


@dataclass
class BoxConvertPayload:
    job_id: str
    actor_id: str
    task_id: str
    asset_ids: list[str] | None = None


def build_payload(*, actor, task: Task, asset_ids: list[str] | None = None) -> BoxConvertPayload:
    return BoxConvertPayload(
        job_id=str(uuid.uuid4()),
        actor_id=str(actor.id),
        task_id=str(task.id),
        asset_ids=list(asset_ids) if asset_ids else None,
    )


# ---------------------------------------------------------------------------
# One image
# ---------------------------------------------------------------------------


@dataclass
class ImageResult:
    boxes: int = 0
    polygons: int = 0
    masks: int = 0
    merged: int = 0
    kept: int = 0
    low_score: int = 0
    ms: int = 0

    def add(self, other: ImageResult) -> None:
        for f in ("boxes", "polygons", "masks", "merged", "kept", "low_score", "ms"):
            setattr(self, f, getattr(self, f) + getattr(other, f))


def boxes_on_asset(session: Session, task_id, asset: Asset) -> list[tuple[Annotation, str | None]]:
    """The asset's boxes with their class names, frame by frame."""
    rows = session.execute(
        select(Annotation, Class.name)
        .join(Frame, Frame.id == Annotation.frame_id)
        .outerjoin(Class, Class.id == Annotation.class_id)
        .where(
            Annotation.task_id == task_id,
            Frame.asset_id == asset.id,
            Annotation.kind == AnnotationKind.bbox,
        )
        .order_by(Frame.idx, Annotation.created_at, Annotation.id)
    ).all()
    return [(a, n) for a, n in rows]


def _xyxy(g: dict) -> list[float] | None:
    try:
        x, y, w, h = float(g["x"]), float(g["y"]), float(g["w"]), float(g["h"])
    except (KeyError, TypeError, ValueError):
        return None
    if w < 1 or h < 1:
        return None
    return [x, y, x + w, y + h]


def _apply(ann: Annotation, r: dict | None, out: ImageResult, *, deleted: list[Annotation]) -> None:
    if r is None:
        out.kept += 1
        return
    if r.get("merged_into") is not None:
        deleted.append(ann)
        out.merged += 1
        return
    mask = r.get("mask")
    if mask:
        ann.kind = AnnotationKind.mask
        ann.geometry = {"kind": "mask_rle", "size": list(mask["size"]), "counts": mask["counts"]}
        out.masks += 1
    elif len(r.get("polygon") or []) >= 3:
        ann.kind = AnnotationKind.polygon
        ann.geometry = {
            "kind": "polygon",
            "points": [[float(x), float(y)] for x, y in r["polygon"]],
        }
        out.polygons += 1
    else:
        out.kept += 1
        return
    if float(r.get("score") or 0.0) < LOW_SCORE:
        out.low_score += 1
    # A new shape is not what a reviewer signed off on.
    if ann.status in ("accepted", "rejected"):
        ann.status = "proposed"
        ann.reviewed_by_id = None
        ann.reviewed_at = None


def convert_asset(session: Session, task: Task, asset: Asset, *, convert_fn=None) -> ImageResult:
    """Convert the asset's boxes in place (not committed). ``convert_fn``
    is ``sam_boxes_to_polygons_for_asset``; tests pass a fake."""
    if convert_fn is None:
        from carve_api.inference.sam import sam_boxes_to_polygons_for_asset as convert_fn

    total = ImageResult()
    rows = boxes_on_asset(session, task.id, asset)
    by_frame: dict = {}
    for ann, name in rows:
        by_frame.setdefault(ann.frame_id, []).append((ann, name))
    deleted: list[Annotation] = []
    for frame_id, items in by_frame.items():
        usable = [(a, n, b) for a, n in items if (b := _xyxy(a.geometry or {})) is not None]
        total.boxes += len(items)
        total.kept += len(items) - len(usable)
        for i in range(0, len(usable), MAX_BOXES_PER_CALL):
            part = usable[i : i + MAX_BOXES_PER_CALL]
            res = convert_fn(
                asset,
                [b for _, _, b in part],
                frame_id=frame_id,
                modes=[mode_for_class(n) for _, n, _ in part],
            )
            results = res.get("results") or []
            if len(results) != len(part):
                raise ValueError(f"model returned {len(results)} results for {len(part)} boxes")
            total.ms += int(res.get("ms") or 0)
            for (a, _, _), r in zip(part, results, strict=True):
                _apply(a, r, total, deleted=deleted)
    for a in deleted:
        session.delete(a)
    session.flush()
    return total


# ---------------------------------------------------------------------------
# SAM readiness
# ---------------------------------------------------------------------------


def _sam_status() -> dict:
    import httpx

    from carve_api.config import get_settings

    base = get_settings().model_base_url.rstrip("/")
    with httpx.Client(timeout=5.0) as c:
        return c.get(f"{base}/sam/status").json() or {}


def ensure_sam(
    *, wait_s: float = _SAM_WAIT_S, status_fn=None, switch_fn=None, sleep=time.sleep
) -> None:
    """SAM 3.1 loaded, or raise. Loads it when the model service has
    nothing loaded (a restart, an idle unload); never replaces another
    variant someone chose (the switch guard refuses that while this job
    runs, so another variant means it was forced)."""
    import httpx

    from carve_api.config import get_settings

    status_fn = status_fn or _sam_status

    def _switch() -> None:
        base = get_settings().model_base_url.rstrip("/")
        with httpx.Client(timeout=5.0) as c:
            c.post(f"{base}/sam/switch", json={"variant": SAM_VARIANT})

    switch_fn = switch_fn or _switch
    deadline = time.monotonic() + wait_s
    asked = False
    while True:
        try:
            st = status_fn()
        except Exception:  # noqa: BLE001 -- the model service restarting
            st = {}
        state, variant = st.get("state"), st.get("variant")
        if state == "ready" and variant == SAM_VARIANT:
            return
        if state == "ready" and variant and variant != SAM_VARIANT:
            raise RuntimeError(f"SAM {variant} is loaded; this conversion needs {SAM_VARIANT}")
        if state in ("idle", "error") and not asked:
            try:
                switch_fn()
                asked = True
            except Exception:  # noqa: BLE001
                log.warning("box_convert: SAM load request failed", exc_info=True)
        if time.monotonic() > deadline:
            raise RuntimeError(
                f"SAM {SAM_VARIANT} did not become ready (state {state or 'unreachable'})"
            )
        sleep(3)


def _is_model_down(exc: Exception) -> bool:
    """The model service restarting or reloading SAM: wait, don't fail.
    A restart can also drop the request in flight ("server disconnected
    without sending a response")."""
    import httpx

    from carve_api.inference.sam import SamModelUnreachable, SamNotReady

    if isinstance(exc, SamNotReady | SamModelUnreachable | httpx.TransportError):
        return True
    return isinstance(exc, ModelServiceError) and exc.status_code in (502, 503)


# ---------------------------------------------------------------------------
# Progress
# ---------------------------------------------------------------------------

_COUNTERS = ("boxes", "polygons", "masks", "merged", "kept", "low_score", "ms", "images_with_boxes")


def _hset(redis_client, job_id: str, mapping: dict) -> None:
    if redis_client is None:
        return
    try:
        redis_client.hset(progress_key(job_id), mapping={k: str(v) for k, v in mapping.items()})
        redis_client.expire(progress_key(job_id), _KEEP_SECONDS)
    except Exception:  # noqa: BLE001 -- progress is best-effort
        log.debug("box_convert: progress write failed", exc_info=True)


def _log_image(redis_client, job_id: str, entry: dict) -> None:
    if redis_client is None:
        return
    try:
        k = log_key(job_id)
        redis_client.rpush(k, json.dumps(entry, separators=(",", ":")))
        redis_client.ltrim(k, -LOG_MAX, -1)
        redis_client.expire(k, _KEEP_SECONDS)
    except Exception:  # noqa: BLE001 -- progress is best-effort
        log.debug("box_convert: progress write failed", exc_info=True)


def read_convert_progress(redis_client, job_id: str, *, recent: int = 24) -> dict:
    """The standard batch progress plus the convert's own fields."""
    out = read_progress(redis_client, job_id)
    out["job_id"] = job_id
    raw: dict = {}
    entries: list = []
    if redis_client is not None:
        try:
            raw = {
                _b2s(k): _b2s(v)
                for k, v in (redis_client.hgetall(progress_key(job_id)) or {}).items()
            }
            if recent > 0:
                entries = [
                    json.loads(_b2s(e)) for e in redis_client.lrange(log_key(job_id), -recent, -1)
                ]
        except Exception:  # noqa: BLE001
            raw, entries = {}, []
    for c in _COUNTERS:
        try:
            out[c] = int(raw.get(c, 0) or 0)
        except ValueError:
            out[c] = 0
    out["task_id"] = raw.get("task_id")
    out["started_at"] = float(raw["started_at"]) if raw.get("started_at") else None
    out["updated_at"] = float(raw["updated_at"]) if raw.get("updated_at") else None
    out["current"] = json.loads(raw["current"]) if raw.get("current") else None
    out["recent"] = list(reversed(entries))
    out["error"] = raw.get("error") or None
    # Seconds per image so far: the model and the save, not the queue.
    done, busy = out["done"], float(raw.get("busy_s", 0) or 0)
    out["busy_s"] = busy
    out["seconds_per_image"] = round(busy / done, 2) if done else None
    # No image finished for this long while it says it runs: its worker
    # died and nothing picked the window up again. The dialog offers Resume.
    active = out["status"] in ("running", "waiting_for_gpu", "queued")
    out["stalled"] = bool(
        active and out["updated_at"] and time.time() - out["updated_at"] > STALLED_AFTER_S
    )
    left = max(0, out["total"] - done)
    out["eta_seconds"] = (
        int(left * busy / done)
        if done and out["status"] in ("running", "waiting_for_gpu", "queued")
        else None
    )
    return out


def latest_job_id(redis_client, task_id) -> str | None:
    if redis_client is None:
        return None
    try:
        v = redis_client.get(task_key(task_id))
    except Exception:  # noqa: BLE001
        return None
    return _b2s(v) if v else None


def active_job_id(redis_client, task_id) -> str | None:
    """The task's convert job while it is queued or running."""
    jid = latest_job_id(redis_client, task_id)
    if not jid:
        return None
    try:
        st = _b2s(redis_client.hget(progress_key(jid), "status"))
    except Exception:  # noqa: BLE001
        return None
    return jid if st in ("queued", "running", "waiting_for_gpu") else None


# ---------------------------------------------------------------------------
# The RQ job
# ---------------------------------------------------------------------------

# Images per RQ execution, and that execution's watchdog. Short, because
# a worker killed mid-window (a deploy) leaves its job to RQ's abandoned
# job sweep, which only runs once the job's timeout has passed.
WINDOW = 50
JOB_TIMEOUT_S = 30 * 60


def _enqueue(payload: BoxConvertPayload, rq_job_id: str, *, connection=None):
    """Retried at once if its worker dies: the workers run no RQ
    scheduler, so an interval retry would never come back."""
    from carve_api.jobs.queue import enqueue_resumable

    return enqueue_resumable(
        run_box_convert_batch,
        payload,
        rq_job_id=rq_job_id,
        connection=connection,
        job_timeout=JOB_TIMEOUT_S,
    )


def _finish(
    redis_client,
    payload: BoxConvertPayload,
    *,
    processed: int,
    total: int,
    failed: int,
    canceled: bool,
) -> str:
    write_cursor(redis_client, payload.job_id, processed)
    if canceled:
        status = "canceled"
    elif processed >= total:
        status = "completed" if failed == 0 else "completed_with_errors"
    else:
        # The next window. If this enqueue fails, raising lets RQ run this
        # window again, which resumes from the cursor and tries again.
        _enqueue(payload, f"{payload.job_id}::c{processed}")
        return "continued"
    finalize_progress(redis_client, payload.job_id, status=status)
    _hset(redis_client, payload.job_id, {"finished_at": time.time()})
    return status


def run_box_convert_batch(payload: BoxConvertPayload) -> dict:
    """RQ entry point. One window of images per execution (see
    ``inference.batch.begin_chunk``), one commit per image."""
    import redis as _redis

    from carve_api.db import get_session_factory

    redis_client = None
    try:
        redis_client = _redis.Redis(
            host=os.environ.get("REDIS_HOST", "redis"),
            port=int(os.environ.get("REDIS_PORT", "6379")),
            decode_responses=True,
        )
    except Exception:  # noqa: BLE001
        log.exception("box_convert: redis init failed; running without progress")

    session = get_session_factory()()
    try:
        task = session.get(Task, uuid.UUID(payload.task_id))
        if task is None:
            _hset(redis_client, payload.job_id, {"status": "failed"})
            return {"ok": False, "error": "task_not_found"}
        assets = list_assets_for_task(session, task.id)
        if payload.asset_ids:
            wanted = set(payload.asset_ids)
            assets = [a for a in assets if str(a.id) in wanted]

        carry = read_convert_progress(redis_client, payload.job_id, recent=0)
        failed = int(carry.get("failed", 0) or 0)
        errors: list[str] = list(carry.get("errors", []) or [])
        sums = {c: int(carry.get(c, 0) or 0) for c in _COUNTERS}
        busy_s = float(carry.get("busy_s") or 0.0)

        plan = begin_chunk(
            redis_client, payload.job_id, total=len(assets), kind=KIND, window=WINDOW
        )
        if plan.first:
            _hset(
                redis_client,
                payload.job_id,
                {"task_id": payload.task_id, "started_at": time.time()},
            )
        if plan.canceled:
            status = _finish(
                redis_client,
                payload,
                processed=plan.cursor,
                total=plan.total,
                failed=failed,
                canceled=True,
            )
            return {"ok": True, "status": status}
        try:
            ensure_sam()
        except RuntimeError as exc:
            # Without SAM 3.1 every image would come out wrong: stop.
            _hset(
                redis_client, payload.job_id, {"status": "failed", "error": str(exc), "current": ""}
            )
            return {"ok": False, "error": str(exc)}

        canceled = False
        stopped: str | None = None
        i = plan.cursor
        while i < plan.window_end:
            if _status_is_canceled(redis_client, payload.job_id):
                canceled = True
                break
            asset = assets[i]
            t0 = time.monotonic()
            _hset(
                redis_client,
                payload.job_id,
                {
                    "current": json.dumps(
                        {"index": i + 1, "asset_id": str(asset.id), "name": asset.original_name}
                    ),
                    "updated_at": time.time(),
                },
            )
            entry = {"index": i + 1, "asset_id": str(asset.id), "name": asset.original_name}
            for attempt in range(3):
                try:
                    res = _run_with_admission_retry(
                        lambda a=asset: convert_asset(session, task, a),
                        redis_client=redis_client,
                        job_id=payload.job_id,
                        asset_label=str(asset.id),
                    )
                    session.commit()
                    entry.update(
                        {
                            k: getattr(res, k)
                            for k in ("boxes", "polygons", "masks", "merged", "kept", "low_score")
                        }
                    )
                    for k in ("boxes", "polygons", "masks", "merged", "kept", "low_score", "ms"):
                        sums[k] += getattr(res, k)
                    if res.boxes:
                        sums["images_with_boxes"] += 1
                    break
                except Exception as exc:  # noqa: BLE001
                    session.rollback()
                    if attempt < 2 and _is_model_down(exc):
                        # A model restart: wait for SAM 3.1, then this
                        # image again. Another variant loaded: stop.
                        _hset(redis_client, payload.job_id, {"status": "waiting_for_gpu"})
                        try:
                            ensure_sam()
                        except RuntimeError as down:
                            stopped = str(down)
                            break
                        _hset(redis_client, payload.job_id, {"status": "running"})
                        continue
                    failed += 1
                    msg = _truncated_repr(exc, limit=180)
                    errors.append(f"{asset.original_name}: {msg}")
                    entry["error"] = msg
                    if isinstance(exc, AppError | ModelServiceError):
                        log.warning("box_convert: asset %s failed: %s", asset.id, msg)
                    else:
                        log.exception("box_convert: asset %s unexpected error", asset.id)
                    break
            if stopped:
                # Not attempted: the cursor stays on this image.
                _hset(
                    redis_client,
                    payload.job_id,
                    {"status": "failed", "error": stopped, "current": ""},
                )
                return {"ok": False, "error": stopped}
            dt = time.monotonic() - t0
            busy_s += dt
            entry["s"] = round(dt, 2)
            if entry.get("boxes") or entry.get("error"):
                _log_image(redis_client, payload.job_id, entry)
            i += 1
            _hset(
                redis_client,
                payload.job_id,
                {
                    "done": i,
                    "failed": failed,
                    "errors": json.dumps(errors[-50:]),
                    "total_annotations_created": sums["polygons"] + sums["masks"],
                    **sums,
                    "busy_s": round(busy_s, 2),
                    "updated_at": time.time(),
                },
            )
            write_cursor(redis_client, payload.job_id, i)

        _hset(redis_client, payload.job_id, {"current": ""})
        status = _finish(
            redis_client, payload, processed=i, total=plan.total, failed=failed, canceled=canceled
        )
        return {"ok": True, "status": status, "failed": failed}
    finally:
        session.close()
