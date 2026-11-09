# Armin Mehri — mehri.armin@gmail.com
"""Collect from web — a task's keywords and runs.

    GET  /tasks/{id}/web-collect                    keywords, runs, defaults
    PUT  /tasks/{id}/web-collect/keywords           replace the keyword list
    POST /tasks/{id}/web-collect/jobs               start a run
    GET  /tasks/{id}/web-collect/jobs/{job}         one run, per keyword
    POST /tasks/{id}/web-collect/jobs/{job}/cancel  stop it (images added stay)

Admins only, like uploading: it brings outside files into the task.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.config import get_settings
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.permissions import require_data_movement
from carve_api.projects.models import Task, TaskKind
from carve_api.projects.service import require_visible_task
from carve_api.web_collect.blocklist import DEFAULT_GROUPS
from carve_api.web_collect.jobs import MODE_PER_KEYWORD, MODE_TOTAL, enqueue
from carve_api.web_collect.models import (
    ACTIVE_STATUSES,
    DEFAULT_SOURCES,
    OUTCOME_ADDED,
    SOURCE_BAIDU,
    SOURCE_BING,
    SOURCE_COMMONS,
    SOURCE_DUCKDUCKGO,
    SOURCE_OPENVERSE,
    SOURCE_PEXELS,
    SOURCE_PIXABAY,
    SOURCE_SO360,
    SOURCE_UNSPLASH,
    SOURCE_YANDEX,
    SOURCES,
    STATUS_CANCELED,
    STATUS_CANCELING,
    STATUS_QUEUED,
    WebCollectJob,
    WebCollectJobKeyword,
    WebCollectKeyword,
    WebCollectUrl,
)
from carve_api.web_collect.naming import clean_keyword, slugify
from carve_api.web_collect.sources import unavailable
from carve_api.web_collect.translate import clean_zh, fill_chinese

log = logging.getLogger(__name__)

router = APIRouter(prefix="/tasks", tags=["web-collect"])

MAX_KEYWORDS = 500
# Saving the list waits this long at most for new keywords' Chinese.
SAVE_TRANSLATE_TIMEOUT = 12.0
MAX_TARGET = 100_000
SOURCE_LABELS = {
    SOURCE_BING: "Bing",
    SOURCE_DUCKDUCKGO: "DuckDuckGo",
    SOURCE_BAIDU: "Baidu",
    SOURCE_SO360: "360 Search",
    SOURCE_YANDEX: "Yandex",
    SOURCE_COMMONS: "Wikimedia Commons",
    SOURCE_OPENVERSE: "Openverse",
    SOURCE_UNSPLASH: "Unsplash",
    SOURCE_PEXELS: "Pexels",
    SOURCE_PIXABAY: "Pixabay",
}
SOURCE_KINDS = {
    SOURCE_BING: "web",
    SOURCE_DUCKDUCKGO: "web",
    SOURCE_BAIDU: "web",
    SOURCE_SO360: "web",
    SOURCE_YANDEX: "web",
    SOURCE_COMMONS: "open",
    SOURCE_OPENVERSE: "open",
    SOURCE_UNSPLASH: "photos",
    SOURCE_PEXELS: "photos",
    SOURCE_PIXABAY: "photos",
}


def _http(err: AppError) -> HTTPException:
    return HTTPException(
        status_code=err.http_status, detail={"error": err.code, "message": err.message}
    )


def _bad(code: str, message: str, http: int = status.HTTP_400_BAD_REQUEST) -> HTTPException:
    return HTTPException(status_code=http, detail={"error": code, "message": message})


def _task(db: Session, user: User, task_id: uuid.UUID) -> Task:
    require_data_movement(user)
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    if task.kind != TaskKind.image:
        raise _bad("web_collect_image_tasks_only", "Collecting from the web is for image tasks.")
    return task


# ------------------------------------------------------------------ schemas


class KeywordOut(BaseModel):
    id: uuid.UUID
    keyword: str
    slug: str
    target: int
    # Collected images of this keyword still in the task.
    have: int
    # Every source and variant searched to the end.
    exhausted: bool
    # What Baidu and 360 search for it, and who wrote that ("user", or the
    # model that translated it).
    zh: str | None = None
    zh_by: str | None = None


class JobKeywordOut(BaseModel):
    keyword_id: uuid.UUID
    keyword: str
    want: int
    added: int
    rejected: int
    status: str


class JobOut(BaseModel):
    id: uuid.UUID
    status: str
    options: dict
    target: int
    added: int
    found: int
    downloaded: int
    failed: int
    rejected: int
    rejected_by: dict
    # Per source: searches, found, added, status (ok / error / stopped),
    # note (why it was stopped).
    source_stats: dict
    searches: int
    notice: str | None
    error: str | None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    keywords: list[JobKeywordOut] = Field(default_factory=list)


class SourceOut(BaseModel):
    name: str
    label: str
    # "web" search engines, "open" licence archives, free "photos" sites.
    kind: str
    # Ticked in a new run unless changed.
    default: bool
    # What it still needs before it can be used ("a Pexels API key").
    needs: str | None = None


class StateOut(BaseModel):
    keywords: list[KeywordOut]
    active: JobOut | None
    recent: list[JobOut]
    sources: list[SourceOut]
    blocked_counts: dict[str, int]
    min_side_default: int = 500


class KeywordIn(BaseModel):
    id: uuid.UUID | None = None
    keyword: str = Field(..., min_length=1, max_length=200)
    target: int = Field(100, ge=0, le=MAX_TARGET)
    # The keyword in Chinese, written by the user: None leaves it as it
    # is, "" goes back to the automatic translation.
    zh: str | None = Field(None, max_length=200)


class KeywordsIn(BaseModel):
    keywords: list[KeywordIn] = Field(default_factory=list, max_length=MAX_KEYWORDS)


class RunOptionsIn(BaseModel):
    sources: list[
        Literal[
            "bing",
            "duckduckgo",
            "baidu",
            "so360",
            "yandex",
            "commons",
            "openverse",
            "unsplash",
            "pexels",
            "pixabay",
        ]
    ] = Field(default_factory=lambda: list(DEFAULT_SOURCES), min_length=1)
    min_side: int = Field(500, ge=64, le=4096)
    filter_ai: bool = True
    filter_watermark: bool = True
    # Drop images that do not show what the keyword names.
    filter_relevance: bool = True
    # Drop drawings, charts, signs and renders (not for keywords that name
    # a graphic, such as "… logo").
    filter_photo: bool = True
    # Leave out images on Chinese sites (most of what Baidu and 360 find).
    skip_chinese_sites: bool = False
    # "total": what a keyword cannot find goes to the others.
    mode: Literal["per_keyword", "total"] = MODE_PER_KEYWORD
    # Search every source again from its first page (new images appear
    # over time; already-tried addresses are still skipped).
    restart_search: bool = False


class StartIn(BaseModel):
    # None: every keyword short of its target.
    keyword_ids: list[uuid.UUID] | None = None
    options: RunOptionsIn = Field(default_factory=RunOptionsIn)


# ------------------------------------------------------------------ helpers


def _have_counts(db: Session, task_id: uuid.UUID) -> dict[uuid.UUID, int]:
    rows = db.execute(
        select(WebCollectUrl.keyword_id, func.count())
        .where(
            WebCollectUrl.task_id == task_id,
            WebCollectUrl.outcome == OUTCOME_ADDED,
            WebCollectUrl.asset_id.is_not(None),
            WebCollectUrl.keyword_id.is_not(None),
        )
        .group_by(WebCollectUrl.keyword_id)
    ).all()
    return {k: n for k, n in rows}


def _set_chinese(kw: WebCollectKeyword, zh: str) -> None:
    """The user's Chinese for a keyword ("" goes back to the automatic
    one). Different words are a different search: Baidu's and 360's
    Chinese searches start again from their first page."""
    zh = clean_zh(zh)
    if zh == (kw.terms or {}).get("zh", ""):
        return
    kw.terms = {"zh": zh, "zh_by": "user"} if zh else {}
    kw.steps = {k: v for k, v in (kw.steps or {}).items() if not k.endswith(":zh")}


def _exhausted(kw: WebCollectKeyword) -> bool:
    """Every variant searched so far is searched to the end."""
    steps = kw.steps or {}
    return bool(steps) and all(st.get("done") for st in steps.values())


def _keywords(db: Session, task_id: uuid.UUID) -> list[WebCollectKeyword]:
    return list(
        db.execute(
            select(WebCollectKeyword)
            .where(WebCollectKeyword.task_id == task_id)
            .order_by(WebCollectKeyword.position, WebCollectKeyword.created_at)
        ).scalars()
    )


def _job_out(db: Session, job: WebCollectJob, with_keywords: bool = True) -> JobOut:
    out = JobOut.model_validate(job, from_attributes=True)
    if with_keywords:
        rows = db.execute(
            select(WebCollectJobKeyword)
            .where(WebCollectJobKeyword.job_id == job.id)
            .order_by(WebCollectJobKeyword.position)
        ).scalars()
        out.keywords = [JobKeywordOut.model_validate(r, from_attributes=True) for r in rows]
    return out


def _active(db: Session, task_id: uuid.UUID) -> WebCollectJob | None:
    return db.execute(
        select(WebCollectJob)
        .where(WebCollectJob.task_id == task_id, WebCollectJob.status.in_(list(ACTIVE_STATUSES)))
        .order_by(WebCollectJob.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()


def _state(db: Session, task_id: uuid.UUID) -> StateOut:
    st = get_settings()
    missing = unavailable(
        st.web_collect_contact,
        st.web_collect_pexels_key,
        st.web_collect_pixabay_key,
        st.web_collect_unsplash_key,
    )
    have = _have_counts(db, task_id)
    kws = _keywords(db, task_id)
    active = _active(db, task_id)
    recent = (
        db.execute(
            select(WebCollectJob)
            .where(WebCollectJob.task_id == task_id)
            .order_by(WebCollectJob.created_at.desc())
            .limit(10)
        )
        .scalars()
        .all()
    )
    return StateOut(
        keywords=[
            KeywordOut(
                id=k.id,
                keyword=k.keyword,
                slug=k.slug,
                target=k.target,
                have=have.get(k.id, 0),
                exhausted=_exhausted(k),
                zh=(k.terms or {}).get("zh"),
                zh_by=(k.terms or {}).get("zh_by"),
            )
            for k in kws
        ],
        active=_job_out(db, active) if active else None,
        recent=[_job_out(db, j) for j in recent],
        sources=[
            SourceOut(
                name=n,
                label=SOURCE_LABELS[n],
                kind=SOURCE_KINDS[n],
                default=n in DEFAULT_SOURCES,
                needs=missing.get(n),
            )
            for n in SOURCES
        ],
        blocked_counts={g: len(d) for g, d in DEFAULT_GROUPS.items()},
    )


# ---------------------------------------------------------------- endpoints


@router.get("/{task_id}/web-collect", response_model=StateOut)
def get_state(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StateOut:
    _task(db, user, task_id)
    return _state(db, task_id)


@router.put("/{task_id}/web-collect/keywords", response_model=StateOut)
def put_keywords(
    task_id: uuid.UUID,
    payload: KeywordsIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StateOut:
    """Replace the task's keyword list (in the order given). Removing a
    keyword keeps its images. A keyword in the running run cannot be
    renamed or removed until the run ends."""
    _task(db, user, task_id)
    existing = {k.id: k for k in _keywords(db, task_id)}
    by_text = {k.keyword.lower(): k for k in existing.values()}
    active = _active(db, task_id)
    locked: set[uuid.UUID] = set()
    if active is not None:
        locked = set(
            db.execute(
                select(WebCollectJobKeyword.keyword_id).where(
                    WebCollectJobKeyword.job_id == active.id
                )
            ).scalars()
        )
    seen: set[str] = set()
    keep: set[uuid.UUID] = set()
    for pos, item in enumerate(payload.keywords):
        text = clean_keyword(item.keyword)
        if not text:
            continue
        low = text.lower()
        if low in seen:
            raise _bad("web_collect_duplicate_keyword", f'"{text}" is in the list twice.')
        seen.add(low)
        kw = existing.get(item.id) if item.id else None
        if kw is None:
            kw = by_text.get(low)  # the same words typed again: same keyword
        if kw is None:
            kw = WebCollectKeyword(
                task_id=task_id,
                keyword=text,
                slug=slugify(text),
                target=item.target,
                position=pos,
                steps={},
                terms={},
            )
            db.add(kw)
            db.flush()
        else:
            if kw.keyword.lower() != low:
                if kw.id in locked:
                    raise _bad(
                        "web_collect_keyword_in_run",
                        f'"{kw.keyword}" is being collected; rename it after the run.',
                        status.HTTP_409_CONFLICT,
                    )
                # Different words: a different search, numbered afresh.
                kw.slug = slugify(text)
                kw.next_index = 1
                kw.steps = {}
                kw.terms = {}
            kw.keyword = text
            kw.target = item.target
            kw.position = pos
        if item.zh is not None:
            _set_chinese(kw, item.zh)
        keep.add(kw.id)
    for kid, kw in existing.items():
        if kid in keep:
            continue
        if kid in locked:
            raise _bad(
                "web_collect_keyword_in_run",
                f'"{kw.keyword}" is being collected; remove it after the run.',
                status.HTTP_409_CONFLICT,
            )
        db.delete(kw)
    db.commit()
    # New keywords get their Chinese now, so it can be checked before a
    # run (which translates any still missing). Best effort and quick.
    if fill_chinese(
        [k for k in _keywords(db, task_id) if k.id in keep],
        get_settings(),
        timeout=SAVE_TRANSLATE_TIMEOUT,
        after_failure=False,
    ):
        log.info("web_collect.translate_on_save_failed task_id=%s", task_id)
    db.commit()
    return _state(db, task_id)


@router.post(
    "/{task_id}/web-collect/jobs", response_model=JobOut, status_code=status.HTTP_201_CREATED
)
def start_job(
    task_id: uuid.UUID,
    payload: StartIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobOut:
    _task(db, user, task_id)
    if _active(db, task_id) is not None:
        raise _bad(
            "web_collect_run_active",
            "A collection is already running on this task. Stop it or wait for it to end.",
            status.HTTP_409_CONFLICT,
        )
    opts = payload.options
    kws = _keywords(db, task_id)
    if payload.keyword_ids is not None:
        wanted = set(payload.keyword_ids)
        kws = [k for k in kws if k.id in wanted]
    have = _have_counts(db, task_id)
    rows: list[tuple[WebCollectKeyword, int]] = []
    for k in kws:
        if opts.restart_search:
            k.steps = {
                name: {**st, "done": False, "cursor": 0, "empty": 0, "errors": 0}
                for name, st in (k.steps or {}).items()
            }
        want = max(k.target - have.get(k.id, 0), 0)
        if want > 0:
            rows.append((k, want))
    if not rows:
        raise _bad(
            "web_collect_nothing_to_do",
            "Every keyword already has its images. Raise a target or add keywords.",
        )
    sources = [s for s in SOURCES if s in opts.sources]
    job = WebCollectJob(
        task_id=task_id,
        created_by=user.id,
        status=STATUS_QUEUED,
        options={
            "sources": sources,
            "min_side": opts.min_side,
            "filter_ai": opts.filter_ai,
            "filter_watermark": opts.filter_watermark,
            "filter_relevance": opts.filter_relevance,
            "skip_chinese_sites": opts.skip_chinese_sites,
            "mode": MODE_TOTAL if opts.mode == "total" else MODE_PER_KEYWORD,
        },
        target=sum(w for _, w in rows),
        rejected_by={},
    )
    db.add(job)
    db.flush()
    for pos, (k, want) in enumerate(rows):
        db.add(
            WebCollectJobKeyword(
                job_id=job.id,
                keyword_id=k.id,
                keyword=k.keyword,
                position=pos,
                want=want,
            )
        )
    db.commit()
    try:
        enqueue(str(job.id))
    except Exception:  # noqa: BLE001 — the supervisor starts it within a minute
        log.warning("web_collect.enqueue_failed job_id=%s", job.id, exc_info=True)
    return _job_out(db, job)


@router.get("/{task_id}/web-collect/jobs/{job_id}", response_model=JobOut)
def get_job(
    task_id: uuid.UUID,
    job_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobOut:
    _task(db, user, task_id)
    job = db.get(WebCollectJob, job_id)
    if job is None or job.task_id != task_id:
        raise _bad("web_collect_job_not_found", "No such run.", status.HTTP_404_NOT_FOUND)
    return _job_out(db, job)


@router.post("/{task_id}/web-collect/jobs/{job_id}/cancel", response_model=JobOut)
def cancel_job(
    task_id: uuid.UUID,
    job_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobOut:
    """Stop a run. The images it already added stay in the task; what it
    found and had not tried yet is kept for the next run."""
    _task(db, user, task_id)
    job = db.get(WebCollectJob, job_id)
    if job is None or job.task_id != task_id:
        raise _bad("web_collect_job_not_found", "No such run.", status.HTTP_404_NOT_FOUND)
    if job.status == STATUS_QUEUED and job.started_at is None:
        job.status = STATUS_CANCELED
        job.completed_at = func.now()
    elif job.status in ACTIVE_STATUSES:
        # The run sees this within a second and winds down; the
        # supervisor closes it if no worker is behind it.
        job.status = STATUS_CANCELING
    db.commit()
    db.refresh(job)
    return _job_out(db, job)
