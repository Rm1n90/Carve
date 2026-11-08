# Armin Mehri — mehri.armin@gmail.com
"""The collect run: search, download, filter, add — until each keyword
has what it should, or every source has nothing more.

One RQ job (``collect`` lane, its own worker) works a run. The main
thread searches and decides; a pool of download threads fetches and
reads the files. What the run has done is in Postgres after every step:

* every address found is written down before it is downloaded (as
  "pending"), so a restarted run starts with those and nothing found is
  lost, and an address is never downloaded twice in a task;
* an added image, its address and the counters go in one commit;
* the search position of every keyword, source and variant is kept on
  the keyword, so the next run searches on from there.

If the worker dies, RQ retries and the API's supervisor (``poller``)
restarts the run; an advisory lock keeps a second execution out.
Rejected images are never stored, only their address, why, and (for the
AI / watermark rejections) a look-alike hash so the same picture found
elsewhere is turned away without asking the filters again.
"""

from __future__ import annotations

import hashlib
import io
import logging
import threading
import time
import uuid
from collections import Counter, defaultdict, deque
from collections.abc import Iterator
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit, urlunsplit

import httpx
from PIL import Image
from redis import Redis
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from carve_api.assets.models import Asset
from carve_api.assets.service import AssetNameExists, AssetService
from carve_api.config import get_settings
from carve_api.db import get_session_factory
from carve_api.projects.models import Task
from carve_api.web_collect import images as img
from carve_api.web_collect.blocklist import Blocklist, host_of, parse_extra
from carve_api.web_collect.models import (
    ACTIVE_STATUSES,
    DEFAULT_SOURCES,
    KW_DONE,
    KW_EXHAUSTED,
    KW_LIMITED,
    KW_PENDING,
    KW_RUNNING,
    OUTCOME_ADDED,
    OUTCOME_FAILED,
    OUTCOME_PENDING,
    STATUS_CANCELED,
    STATUS_CANCELING,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_QUEUED,
    STATUS_RUNNING,
    TERMINAL_STATUSES,
    WebCollectHash,
    WebCollectJob,
    WebCollectJobKeyword,
    WebCollectKeyword,
    WebCollectUrl,
)
from carve_api.web_collect.naming import file_name
from carve_api.web_collect.pacing import Pacer
from carve_api.web_collect.quality import FiltersUnavailable, score
from carve_api.web_collect.sources import (
    BROWSER_UA,
    Candidate,
    Source,
    SourceBusy,
    SourceError,
    build_sources,
    honest_user_agent,
    step_order,
)

log = logging.getLogger(__name__)

QUEUE = "collect"
RQ_PREFIX = "webcollect-"

MODE_PER_KEYWORD = "per_keyword"
MODE_TOTAL = "total"

PER_HOST = 4  # downloads at once from one site
ACTIVE_KEYWORDS = 3  # keywords searched side by side
FILTER_BATCH = 16  # images scored in one model call
FILTER_WAIT = 3.0  # seconds a part-filled batch may wait
EMPTY_PAGES = 2  # pages with nothing new that end a variant
HEARTBEAT = 2.0
# Seconds a site that said "too many requests" is left alone (its images
# go to the back of the queue; the run never sits waiting for it).
HOST_PAUSE = 120.0
# Failed searches in a row (timeouts, 5xx) after which a source is
# dropped from the run, resting ERROR_REST × n seconds between them.
SOURCE_ERRORS = 3
ERROR_REST = 5.0
# Longest the run waits for a source's normal pace (Unsplash: 72 s).
MAX_PACING_WAIT = 75.0
# How long the image filters may be unreachable before the run stops.
FILTERS_GIVE_UP = 600.0
# Turns the sources take at searching (see _Run._next_step).
# The web search engines find the most; the others take a turn each (a
# paused or unchosen source just passes its turn, and a source not due
# yet for its pace gives it to the next one).
ROTATION = (
    "bing", "baidu", "duckduckgo", "so360", "commons",
    "bing", "baidu", "duckduckgo", "so360", "openverse",
    "bing", "baidu", "duckduckgo", "so360", "yandex",
    "bing", "baidu", "unsplash", "so360", "pexels", "pixabay",
)  # fmt: skip
FILTERS_RETRY = 20.0
_GRACE = timedelta(seconds=45)
_MAX_STALLS = 30


def _now() -> datetime:
    return datetime.now(UTC)


def url_key(url: str) -> str:
    """sha1 of the address without its fragment, scheme and host lower-cased."""
    try:
        p = urlsplit(url.strip())
        norm = urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path, p.query, ""))
    except ValueError:
        norm = url.strip()
    return hashlib.sha1(norm.encode("utf-8", "replace"), usedforsecurity=False).hexdigest()


@dataclass
class Options:
    sources: list[str]
    min_side: int = 500
    filter_ai: bool = True
    filter_watermark: bool = True
    filter_relevance: bool = False
    # Leave out images on Chinese sites (Baidu and 360 find mostly those).
    skip_chinese_sites: bool = True
    mode: str = MODE_PER_KEYWORD

    @classmethod
    def from_json(cls, d: dict) -> Options:
        return cls(
            sources=list(d.get("sources") or DEFAULT_SOURCES),
            min_side=int(d.get("min_side") or 500),
            filter_ai=bool(d.get("filter_ai", True)),
            filter_watermark=bool(d.get("filter_watermark", True)),
            # Off for runs started before the keyword check existed.
            filter_relevance=bool(d.get("filter_relevance", False)),
            # On for runs started when Chinese sites were always left out.
            skip_chinese_sites=bool(d.get("skip_chinese_sites", True)),
            mode=d.get("mode") or MODE_PER_KEYWORD,
        )

    @property
    def checks(self) -> list[str]:
        return [
            c
            for c, on in (
                ("ai", self.filter_ai),
                ("watermark", self.filter_watermark),
                ("relevance", self.filter_relevance),
            )
            if on
        ]


@dataclass
class _Item:
    kw: uuid.UUID
    cand: Candidate
    key: str


@dataclass
class _Failed:
    reason: str
    host: str = ""
    retry_after: float = 0.0


class _Stopped(Exception):
    pass


class _FiltersGone(Exception):
    """The AI / watermark filters stayed unavailable: the run ends rather
    than add unchecked images or wait indefinitely."""


@contextmanager
def _exclusive(session: Session, job_id: uuid.UUID) -> Iterator[bool]:
    """Hold the run for this execution (a session-level advisory lock on
    a connection of its own, dropped by the server if the process dies)."""
    key = int.from_bytes(job_id.bytes[8:], "big", signed=True)
    conn = session.get_bind().engine.connect()
    held = False
    try:
        held = bool(conn.execute(select(func.pg_try_advisory_lock(key))).scalar())
        conn.commit()
        yield held
    finally:
        try:
            if held:
                conn.execute(select(func.pg_advisory_unlock(key)))
                conn.commit()
            conn.close()
        except Exception:  # noqa: BLE001
            log.warning("web_collect.lock.release_failed job_id=%s", job_id, exc_info=True)
            conn.invalidate()


def run_web_collect(job_id: str) -> dict:
    """RQ entry point."""
    jid = uuid.UUID(job_id)
    session = get_session_factory()()
    try:
        with _exclusive(session, jid) as held:
            if not held:
                return {"ok": False, "busy": True}
            job = session.get(WebCollectJob, jid)
            if job is None or job.status in TERMINAL_STATUSES:
                return {"ok": True, "status": getattr(job, "status", None)}
            return _Run(session, job).run()
    finally:
        session.close()


class _Run:
    def __init__(self, session: Session, job: WebCollectJob) -> None:
        self.s = session
        self.job = job
        self.opts = Options.from_json(job.options or {})
        st = get_settings()
        self.settings = st
        self.blocklist = Blocklist(
            parse_extra(st.web_collect_blocked_sites), chinese=self.opts.skip_chinese_sites
        )
        self.redis = Redis(host=st.redis_host, port=st.redis_port)
        self.pacer = Pacer(self.redis)
        self.sources: dict[str, Source] = build_sources(
            self.opts.sources,
            st.web_collect_contact,
            pexels_key=st.web_collect_pexels_key,
            pixabay_key=st.web_collect_pixabay_key,
            unsplash_key=st.web_collect_unsplash_key,
        )
        self.order = step_order(self.sources)
        self.honest_ua = honest_user_agent(st.web_collect_contact)
        self.threads = max(1, int(st.web_collect_threads))
        self.http = httpx.Client(
            timeout=httpx.Timeout(20.0, connect=10.0),
            follow_redirects=True,
            limits=httpx.Limits(
                max_connections=self.threads + 8, max_keepalive_connections=self.threads
            ),
        )
        self.stop_flag = threading.Event()
        self._host_locks: dict[str, threading.BoundedSemaphore] = {}
        self._host_guard = threading.Lock()
        self.inflight: dict[Future, _Item] = {}
        self.inflight_kw: Counter = Counter()
        self.inflight_host: Counter = Counter()
        self.backlog: dict[uuid.UUID, deque[_Item]] = defaultdict(deque)
        self.to_score: list[tuple[_Item, img.Prepared]] = []
        self.to_score_since = 0.0
        self.outcomes: dict[str, tuple[str, int | None]] = {}
        self._turns: Counter = Counter()
        # Image hosts that answered 429 / 503, until when (monotonic).
        # They only reorder the work: nothing ever waits on them.
        self._host_pauses: dict[str, float] = {}
        # Sources out of this run (limit, CAPTCHA, block): source → why.
        self.dropped: dict[str, str] = {}
        self._errors: Counter = Counter()
        self._rest_until: dict[str, float] = {}
        self._filters_down_since: float | None = None
        self._last_beat = 0.0
        self._last_stop_check = 0.0

    # ------------------------------------------------------------------ run

    def run(self) -> dict:
        job = self.job
        if job.status == STATUS_CANCELING:
            return self._finish(STATUS_CANCELED)
        job.status = STATUS_RUNNING
        job.started_at = job.started_at or _now()
        job.heartbeat_at = _now()
        job.notice = None
        job.resume_after = None
        job.error = None
        self.s.commit()
        self.task = self.s.get(Task, job.task_id)
        self.assets = AssetService(self.s)
        self._load()
        pool = ThreadPoolExecutor(self.threads, thread_name_prefix="webcollect")
        self.pool = pool
        try:
            stopped = self._loop()
        except _Stopped:
            stopped = True
        except _FiltersGone as exc:
            self.stop_flag.set()
            pool.shutdown(wait=True, cancel_futures=True)
            self._flush_outcomes()
            self._close_keywords()
            return self._finish(
                STATUS_FAILED,
                f"Stopped: the image filters were unavailable for {FILTERS_GIVE_UP // 60:.0f} "
                f"minutes ({exc}). The images added so far are kept.",
            )
        except Exception as exc:
            self.stop_flag.set()
            pool.shutdown(wait=False, cancel_futures=True)
            self.s.rollback()
            self._note_error(exc)
            raise
        if stopped:
            self.stop_flag.set()
            pool.shutdown(wait=True, cancel_futures=True)
            self._flush_outcomes()
            return self._finish(STATUS_CANCELED)
        pool.shutdown(wait=True)
        self._flush_outcomes()
        return self._finish(STATUS_COMPLETED)

    def _loop(self) -> bool:
        """True when stopped by the user."""
        while True:
            if self._stop_requested():
                return True
            self._collect_done(timeout=0)
            searched = self._search_round()
            self._score_if_due()
            self._beat()
            if self._all_done():
                return False
            if searched:
                continue
            if self.inflight:
                self._collect_done(timeout=1.0)
            elif self.to_score:
                self._score_if_due(force=True)
            elif not self._wait_for_pacing():
                # Nothing in flight, nothing to score, no source left that
                # can search: the run ends with what it has.
                self._close_keywords()
                return False

    # ------------------------------------------------------------- loading

    def _load(self) -> None:
        job = self.job
        rows = (
            self.s.execute(
                select(WebCollectJobKeyword)
                .where(WebCollectJobKeyword.job_id == job.id)
                .order_by(WebCollectJobKeyword.position)
            )
            .scalars()
            .all()
        )
        self.rows = {r.keyword_id: r for r in rows}
        kws = (
            self.s.execute(
                select(WebCollectKeyword).where(WebCollectKeyword.id.in_(list(self.rows)))
            )
            .scalars()
            .all()
        )
        self.keywords = {k.id: k for k in kws}
        tid = job.task_id
        self.seen: set[str] = set(
            self.s.execute(
                select(WebCollectUrl.url_hash).where(WebCollectUrl.task_id == tid)
            ).scalars()
        )
        self.xxh: set[str] = set(
            self.s.execute(select(Asset.xxh3_128).where(Asset.task_id == tid)).scalars()
        )
        self._hash_existing_assets()
        hashes = list(
            self.s.execute(
                select(WebCollectHash.dhash).where(WebCollectHash.task_id == tid)
            ).scalars()
        )
        hashes += list(
            self.s.execute(
                select(WebCollectUrl.dhash).where(
                    WebCollectUrl.task_id == tid, WebCollectUrl.dhash.is_not(None)
                )
            ).scalars()
        )
        self.look = img.LookalikeIndex(hashes)
        # Found by an earlier run (or this one before a restart), not tried.
        pending = (
            self.s.execute(
                select(WebCollectUrl)
                .where(
                    WebCollectUrl.task_id == tid,
                    WebCollectUrl.outcome == OUTCOME_PENDING,
                    WebCollectUrl.keyword_id.in_(list(self.rows)),
                )
                .order_by(WebCollectUrl.created_at)
            )
            .scalars()
            .all()
        )
        for u in pending:
            cand = Candidate(url=u.url, page_url=u.page_url, source=u.source)
            self.backlog[u.keyword_id].append(_Item(u.keyword_id, cand, u.url_hash))
        log.info(
            "web_collect.load job_id=%s keywords=%d seen=%d hashes=%d pending=%d",
            job.id,
            len(self.rows),
            len(self.seen),
            len(self.look),
            len(pending),
        )

    def _hash_existing_assets(self) -> None:
        """Look-alike hashes for the task's images that do not have one
        yet (uploaded or extracted rather than collected), from their
        thumbnails. Once per image; kept in ``web_collect_hashes``."""
        missing = self.s.execute(
            select(Asset.id, Asset.xxh3_128, Asset.thumbnail_minio_key, Asset.original_name)
            .outerjoin(WebCollectHash, WebCollectHash.asset_id == Asset.id)
            .where(Asset.task_id == self.job.task_id, WebCollectHash.asset_id.is_(None))
        ).all()
        if not missing:
            return
        self.job.notice = (
            f"Reading the {len(missing):,} images already in the task to avoid duplicates."
        )
        self.s.commit()
        storage = self.assets.storage

        def one(row) -> tuple[uuid.UUID, int | None]:  # noqa: ANN001
            asset_id, h, thumb, name = row
            ext = name.rsplit(".", 1)[-1].lower() if "." in name else "jpg"
            for key in ([thumb] if thumb else []) + [f"assets/{h}/original.{ext}"]:
                try:
                    body = storage.get_object(key).read()
                    with Image.open(io.BytesIO(body)) as im:
                        return asset_id, img.dhash(im)
                except Exception:  # noqa: BLE001 — try the original next
                    log.debug("web_collect.hash_read_failed key=%s", key, exc_info=True)
                    continue
            return asset_id, None

        with ThreadPoolExecutor(8) as pool:
            results = list(pool.map(one, missing))
        values = [
            {"asset_id": a, "task_id": self.job.task_id, "dhash": d, "from_collector": False}
            for a, d in results
            if d is not None
        ]
        for i in range(0, len(values), 1000):
            self.s.execute(
                pg_insert(WebCollectHash).values(values[i : i + 1000]).on_conflict_do_nothing()
            )
        self.job.notice = None
        self.s.commit()

    # ------------------------------------------------------------ searching

    def _needs(self, kid: uuid.UUID) -> int:
        row = self.rows[kid]
        return row.want - row.added

    def _cap(self, kid: uuid.UUID) -> int:
        """Downloads worth having in flight for a keyword: about twice
        what it still needs (half are usually turned away)."""
        return max(8, min(self._needs(kid) * 2 + 4, self.threads * 2))

    def _queued_for(self, kid: uuid.UUID) -> int:
        return self.inflight_kw[kid] + sum(1 for it, _ in self.to_score if it.kw == kid)

    def _search_round(self) -> bool:
        """Top up downloads from the backlog and search one page for each
        of the first few keywords that need one. True if anything moved."""
        moved = False
        active = [r for r in self.rows.values() if r.status in (KW_PENDING, KW_RUNNING)]
        for row in active[:ACTIVE_KEYWORDS]:
            kid = row.keyword_id
            if self._needs(kid) <= 0:
                if not self._queued_for(kid):
                    row.status = KW_DONE
                    self.s.commit()
                    moved = True
                continue
            if row.status == KW_PENDING:
                row.status = KW_RUNNING
            moved |= self._fill(kid)
            if self._ready_backlog(kid) or self.inflight_kw[kid] >= self._cap(kid):
                continue
            step = self._next_step(kid)
            if step is None:
                if (
                    not self._usable_steps(kid)
                    and not self._queued_for(kid)
                    and not self._live_backlog(kid)
                ):
                    # Every source it could still use has run out or was
                    # dropped (a limit, a CAPTCHA, a block): it ends now
                    # with what it has.
                    limited = bool(self._steps_left(kid)) or bool(self.backlog[kid])
                    self._end_short(row, KW_LIMITED if limited else KW_EXHAUSTED)
                    moved = True
                continue
            moved |= self._search(kid, step)
            moved |= self._fill(kid)
        return moved

    def _steps(self, kid: uuid.UUID) -> dict:
        kw = self.keywords[kid]
        steps = dict(kw.steps or {})
        for name in self.order:
            steps.setdefault(name, {"cursor": 0, "done": False, "empty": 0, "errors": 0})
        return steps

    def _steps_left(self, kid: uuid.UUID) -> list[str]:
        steps = self._steps(kid)
        return [n for n in self.order if not steps[n].get("done")]

    def _usable_steps(self, kid: uuid.UUID) -> list[str]:
        """Searches left for a keyword on sources still in this run."""
        return [n for n in self._steps_left(kid) if n.split(":")[0] not in self.dropped]

    def _source_wait(self, source: str) -> float:
        """Seconds until ``source`` may search again: its pace across all
        runs, and a short rest after a failed search in this one."""
        rest = self._rest_until.get(source, 0.0) - time.monotonic()
        return max(self.pacer.ready_in(source), rest, 0.0)

    def _drop(self, source: str, reason: str) -> None:
        """Take ``source`` out of this run for good: it hit a limit, asked
        for a CAPTCHA or blocked us. Nothing waits for it to come back;
        the other sources go on, and when they cannot, the run ends."""
        if source in self.dropped:
            return
        self.dropped[source] = reason
        self._note_source(source, "stopped", reason)
        self.s.commit()
        log.warning(
            "web_collect.source_dropped job_id=%s source=%s: %s", self.job.id, source, reason
        )

    def _next_step(self, kid: uuid.UUID) -> str | None:
        """The next search for a keyword. Sources take turns (``ROTATION``),
        each working through its own variants in order, so a keyword gets
        a mix from the start. A source another run found blocked is
        dropped here too; one that is merely not due yet (its pace, a
        short rest after an error) is skipped for one that is due."""
        first: dict[str, str] = {}
        for name in self._usable_steps(kid):
            first.setdefault(name.split(":")[0], name)
        for source in list(first):
            if self.pacer.paused_for(source) > 0:
                self._drop(source, "blocked or at its limit (seen by another run)")
                first.pop(source)
        turn = self._turns[kid]
        for i in range(len(ROTATION)):
            source = ROTATION[(turn + i) % len(ROTATION)]
            name = first.get(source)
            if name and self._source_wait(source) <= 0:
                self._turns[kid] = (turn + i + 1) % len(ROTATION)
                return name
        return None

    def _search(self, kid: uuid.UUID, step: str) -> bool:
        source_name, variant = step.split(":", 1)
        src = self.sources[source_name]
        kw = self.keywords[kid]
        steps = self._steps(kid)
        state = dict(steps[step])
        if not self.pacer.wait_turn(source_name, src.interval, self._stop_requested):
            raise _Stopped
        try:
            page = src.search(self.http, kw.keyword, variant, int(state.get("cursor") or 0))
        except SourceBusy as exc:
            # A limit, a CAPTCHA, a block: out of this run. The pause in
            # Redis tells runs on other tasks not to try it meanwhile.
            self.pacer.pause(source_name, exc.retry_after)
            self._drop(source_name, str(exc))
            return False
        except SourceError as exc:
            # A blip (timeout, 5xx): rest the source a few seconds and try
            # again; after a few failures in a row it is dropped too.
            n = self._errors[source_name] = self._errors[source_name] + 1
            log.warning("web_collect.search_error step=%s keyword=%r: %s", step, kw.keyword, exc)
            if n >= SOURCE_ERRORS:
                self._drop(source_name, f"failed {n} times in a row ({exc})")
            else:
                self._rest_until[source_name] = time.monotonic() + ERROR_REST * n
                self._note_source(source_name, "error", str(exc))
            return False
        self._errors[source_name] = 0
        if page.off_topic:
            # Its images are about something else: none of this source's
            # searches for the keyword are made; the others fill in.
            for name in self.order:
                if name.split(":")[0] == source_name:
                    steps[name] = {**steps[name], "done": True}
            self.job.searches += 1
            self._note_source(source_name, "ok", None, searches=1, off_topic=1)
            log.info("web_collect.off_topic source=%s keyword=%r", source_name, kw.keyword)
            self._save_step(kw, steps, step, steps[step])
            return True
        new: list[_Item] = []
        records = []
        for cand in page.candidates:
            key = url_key(cand.url)
            if key in self.seen:
                continue
            self.seen.add(key)
            blocked = self.blocklist.reason(cand.url, cand.page_url)
            reason = None
            if blocked:
                reason = img.BLOCKED_PREFIX + blocked
            elif cand.width and cand.height and min(cand.width, cand.height) < self.opts.min_side:
                reason = img.REJECT_SMALL
            records.append(
                {
                    "task_id": self.job.task_id,
                    "url_hash": key,
                    "url": cand.url[:4000],
                    "page_url": (cand.page_url or "")[:4000] or None,
                    "source": cand.source,
                    "keyword_id": kid,
                    "outcome": reason or OUTCOME_PENDING,
                }
            )
            if reason:
                self._count_reject(kid, reason, row_counts=False)
            else:
                new.append(_Item(kid, cand, key))
        if records:
            self.s.execute(pg_insert(WebCollectUrl).values(records).on_conflict_do_nothing())
        self.backlog[kid].extend(new)
        self.job.found += len(records)
        self.job.searches += 1
        self._note_source(source_name, "ok", None, searches=1, found=len(records))
        state["empty"] = 0 if records else int(state.get("empty") or 0) + 1
        if page.next_cursor is None or state["empty"] >= EMPTY_PAGES:
            state["done"] = True
        else:
            state["cursor"] = page.next_cursor
        self._save_step(kw, steps, step, state)
        return True

    def _note_source(
        self,
        source: str,
        status: str | None,
        note: str | None,
        *,
        searches: int = 0,
        found: int = 0,
        added: int = 0,
        off_topic: int = 0,
    ) -> None:
        """Per-source counters and state on the run, for the progress view:
        which sources work, and which were stopped and why."""
        stats = dict(self.job.source_stats or {})
        cur = dict(stats.get(source) or {"searches": 0, "found": 0, "added": 0, "status": "ok"})
        cur["searches"] = int(cur.get("searches", 0)) + searches
        cur["found"] = int(cur.get("found", 0)) + found
        cur["added"] = int(cur.get("added", 0)) + added
        if off_topic:
            # Keywords it answered with images about something else.
            cur["off_topic"] = int(cur.get("off_topic", 0)) + off_topic
        if status is not None and cur.get("status") != "stopped":
            cur["status"] = status
            cur["note"] = (note or "")[:200] or None
        stats[source] = cur
        self.job.source_stats = stats  # reassigned: in-place JSONB edits are not tracked

    def _save_step(self, kw: WebCollectKeyword, steps: dict, step: str, state: dict) -> None:
        steps[step] = state
        kw.steps = steps  # reassigned: in-place JSONB edits are not tracked
        self.s.commit()

    def _end_short(self, row: WebCollectJobKeyword, status: str) -> None:
        """End a keyword that cannot get more: ``exhausted`` (every source
        ran out) or ``limited`` (what was left is on dropped sources)."""
        row.status = status
        short = row.want - row.added
        if self.opts.mode == MODE_TOTAL and short > 0:
            # One total over all keywords: what this one could not find
            # goes to the keywords that can still search (one that already
            # has its share can take more).
            others = [
                r
                for r in self.rows.values()
                if r.status not in (KW_EXHAUSTED, KW_LIMITED) and r.keyword_id != row.keyword_id
            ]
            if others:
                row.want = row.added
                share, extra = divmod(short, len(others))
                for i, r in enumerate(others):
                    give = share + (1 if i < extra else 0)
                    if give <= 0:
                        continue
                    r.want += give
                    if r.status == KW_DONE:
                        r.status = KW_RUNNING
                    self.keywords[r.keyword_id].target += give
                self.keywords[row.keyword_id].target -= short
        self.s.commit()

    def _close_keywords(self) -> None:
        """Nothing more can happen: every keyword still open ends now."""
        for row in self.rows.values():
            if row.status not in (KW_PENDING, KW_RUNNING):
                continue
            kid = row.keyword_id
            if self._needs(kid) <= 0:
                row.status = KW_DONE
            elif self._steps_left(kid) or self.backlog[kid]:
                row.status = KW_LIMITED
            else:
                row.status = KW_EXHAUSTED
        self.s.commit()

    def _wait_for_pacing(self) -> bool:
        """Nothing to do this instant. If a usable source is only not due
        yet (its pace, at most a minute or so), wait for it and return
        True. Never waits for a limit or a block: those sources are
        dropped, and with none usable left this returns False."""
        waits = [
            self._source_wait(name.split(":")[0])
            for row in self.rows.values()
            if row.status in (KW_PENDING, KW_RUNNING) and self._needs(row.keyword_id) > 0
            for name in self._usable_steps(row.keyword_id)
        ]
        if not waits:
            return False
        end = time.monotonic() + min(min(waits), MAX_PACING_WAIT)
        while time.monotonic() < end:
            if self._stop_requested():
                raise _Stopped
            self._beat()
            time.sleep(min(0.5, max(end - time.monotonic(), 0.0)))
        return True

    # ------------------------------------------------------------ downloads

    def _fill(self, kid: uuid.UUID) -> bool:
        """Hand a keyword's found addresses to the download threads, up to
        its cap. Addresses on a site that asked us to wait go to the back."""
        moved = False
        queue = self.backlog[kid]
        skipped = 0
        while queue and self.inflight_kw[kid] < self._cap(kid) and skipped < len(queue):
            item = queue.popleft()
            host = host_of(item.cand.url)
            if not self._host_free(host):
                queue.append(item)
                skipped += 1
                continue
            fut = self.pool.submit(self._fetch, item)
            self.inflight[fut] = item
            self.inflight_kw[kid] += 1
            self.inflight_host[host] += 1
            moved = True
        return moved

    def _host_free(self, host: str) -> bool:
        """Not paused, and not already at its share of the download
        threads (a slow, paced site such as Wikimedia must not fill the
        pool while other sites' images wait)."""
        return not self._host_paused(host) and self.inflight_host[host] < PER_HOST

    def _ready_backlog(self, kid: uuid.UUID) -> bool:
        """Found addresses that can be downloaded now (their site is not
        making us wait)."""
        return any(self._host_free(host_of(i.cand.url)) for i in self.backlog[kid])

    def _live_backlog(self, kid: uuid.UUID) -> bool:
        """Found addresses on sites that have not refused us (a site only
        busy with other downloads right now still counts)."""
        return any(not self._host_paused(host_of(i.cand.url)) for i in self.backlog[kid])

    def _host_paused(self, host: str) -> bool:
        until = self._host_pauses.get(host)
        if until is None:
            return False
        if until > time.monotonic():
            return True
        del self._host_pauses[host]
        return False

    def _host_lock(self, host: str) -> threading.BoundedSemaphore:
        with self._host_guard:
            lock = self._host_locks.get(host)
            if lock is None:
                lock = self._host_locks[host] = threading.BoundedSemaphore(PER_HOST)
            return lock

    def _fetch(self, item: _Item) -> img.Prepared | img.Rejected | _Failed:
        """In a download thread."""
        if self.stop_flag.is_set():
            return _Failed("stopped")
        host = host_of(item.cand.url)
        wikimedia = host.endswith("wikimedia.org")
        headers = {
            "User-Agent": self.honest_ua if wikimedia else BROWSER_UA,
            # No AVIF: CDNs would send it, and Pillow here cannot read it.
            "Accept": "image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5",
        }
        referer = img.referer_for(item.cand.url, item.cand.page_url)
        if referer:
            headers["Referer"] = referer
        with self._host_lock(host):
            if wikimedia and not self.pacer.wait_turn("host:wikimedia", 1.0, self.stop_flag.is_set):
                return _Failed("stopped")
            try:
                body = img.download(self.http, item.cand.url, headers)
            except img.DownloadFailed as exc:
                if exc.busy:
                    return _Failed("busy", host=host, retry_after=exc.retry_after)
                return _Failed(str(exc))
        return img.prepare(body, self.opts.min_side)

    def _collect_done(self, timeout: float) -> None:
        if not self.inflight:
            return
        done, _ = wait(list(self.inflight), timeout=timeout, return_when=FIRST_COMPLETED)
        for fut in done:
            item = self.inflight.pop(fut)
            self.inflight_kw[item.kw] -= 1
            self.inflight_host[host_of(item.cand.url)] -= 1
            try:
                result = fut.result()
            except Exception as exc:  # noqa: BLE001
                result = _Failed(type(exc).__name__)
            self._handle(item, result)

    def _handle(self, item: _Item, result) -> None:  # noqa: ANN001
        if isinstance(result, _Failed):
            if result.reason == "stopped":
                return  # left "pending": the next run tries it
            if result.reason == "busy":
                # The site asked us to wait: try this one again later.
                wait_s = min(max(result.retry_after, HOST_PAUSE), 3600.0)
                self._host_pauses[result.host] = time.monotonic() + wait_s
                self.backlog[item.kw].append(item)
                return
            self.job.failed += 1
            self.outcomes[item.key] = (OUTCOME_FAILED, None)
            return
        self.job.downloaded += 1
        if isinstance(result, img.Rejected):
            self._reject(item, result.reason)
            return
        prep: img.Prepared = result
        if prep.xxh3 in self.xxh:
            self._reject(item, img.REJECT_DUPLICATE)
            return
        if self.look.near(prep.dhash):
            self._reject(item, img.REJECT_LOOKALIKE)
            return
        # Claimed now, so a copy arriving before this one is scored is
        # turned away as a duplicate.
        self.xxh.add(prep.xxh3)
        self.look.add(prep.dhash)
        if not self.opts.checks:
            self._add(item, prep)
            return
        if not self.to_score:
            self.to_score_since = time.monotonic()
        self.to_score.append((item, prep))
        self._score_if_due()

    # ------------------------------------------------------------- filters

    def _score_if_due(self, force: bool = False) -> None:
        if not self.to_score:
            return
        due = (
            force
            or len(self.to_score) >= FILTER_BATCH
            or time.monotonic() - self.to_score_since >= FILTER_WAIT
            or not self.inflight
        )
        if not due:
            return
        batch, self.to_score = self.to_score[:FILTER_BATCH], self.to_score[FILTER_BATCH:]
        self.to_score_since = time.monotonic()
        while True:
            try:
                scores = score(
                    [p.body for _, p in batch],
                    self.opts.checks,
                    [self.keywords[item.kw].keyword for item, _ in batch],
                )
                self._filters_down_since = None
                break
            except FiltersUnavailable as exc:
                now = time.monotonic()
                self._filters_down_since = self._filters_down_since or now
                if now - self._filters_down_since > FILTERS_GIVE_UP:
                    raise _FiltersGone(str(exc)) from exc
                self.job.notice = (
                    f"Image filters unavailable ({exc}); nothing is added unfiltered. "
                    "Retrying by itself."
                )[:500]
                self.s.commit()
                log.warning("web_collect.filters_unavailable job_id=%s: %s", self.job.id, exc)
                end = time.monotonic() + FILTERS_RETRY
                while time.monotonic() < end:
                    if self._stop_requested():
                        raise _Stopped from None
                    self._beat()
                    time.sleep(1.0)
        if self.job.notice and self.job.notice.startswith("Image filters"):
            self.job.notice = None
        st = self.settings
        for (item, prep), sc in zip(batch, scores, strict=True):
            if "ai" in sc and float(sc["ai"]) >= st.web_collect_ai_threshold:
                self._reject(item, img.REJECT_AI, prep.dhash)
            elif "watermark" in sc and float(sc["watermark"]) >= st.web_collect_watermark_threshold:
                self._reject(item, img.REJECT_WATERMARK, prep.dhash)
            elif "relevance" in sc and float(sc["relevance"]) < st.web_collect_relevance_threshold:
                self._reject(item, img.REJECT_OFF_TOPIC, prep.dhash)
            else:
                self._add(item, prep)

    # ------------------------------------------------------------- outcome

    def _count_reject(self, kid: uuid.UUID, reason: str, row_counts: bool = True) -> None:
        self.job.rejected += 1
        by = dict(self.job.rejected_by or {})
        by[reason] = int(by.get(reason, 0)) + 1
        self.job.rejected_by = by
        if row_counts:
            self.rows[kid].rejected += 1

    def _reject(self, item: _Item, reason: str, dhash: int | None = None) -> None:
        self._count_reject(item.kw, reason)
        self.outcomes[item.key] = (reason, dhash)

    def _add(self, item: _Item, prep: img.Prepared) -> None:
        row = self.rows[item.kw]
        kw = self.keywords[item.kw]
        if row.added >= row.want:
            # More arrived than needed: forget the address so a later
            # run (a raised target) can use it.
            self.s.execute(
                WebCollectUrl.__table__.delete().where(
                    WebCollectUrl.task_id == self.job.task_id, WebCollectUrl.url_hash == item.key
                )
            )
            self.s.commit()
            self.xxh.discard(prep.xxh3)
            return
        asset = None
        for _ in range(1000):
            name = file_name(kw.slug, kw.next_index, prep.ext)
            kw.next_index += 1
            try:
                asset = self.assets.upload(
                    task=self.task, original_name=name, mime=prep.mime, body=prep.body
                )
                break
            except AssetNameExists:
                continue
        if asset is None:
            self._reject(item, "name_taken")
            return
        self.s.add(WebCollectHash(asset_id=asset.id, task_id=self.job.task_id, dhash=prep.dhash))
        self.s.execute(
            update(WebCollectUrl)
            .where(WebCollectUrl.task_id == self.job.task_id, WebCollectUrl.url_hash == item.key)
            .values(outcome=OUTCOME_ADDED, asset_id=asset.id)
        )
        row.added += 1
        kw.added += 1
        self.job.added += 1
        self._note_source(item.cand.source, None, None, added=1)
        self.s.commit()
        _enqueue_thumbnail(asset.xxh3_128, prep.ext, str(asset.id))

    def _flush_outcomes(self) -> None:
        if not self.outcomes:
            return
        items, self.outcomes = self.outcomes, {}
        for key, (outcome, dhash) in items.items():
            self.s.execute(
                update(WebCollectUrl)
                .where(WebCollectUrl.task_id == self.job.task_id, WebCollectUrl.url_hash == key)
                .values(outcome=outcome, dhash=dhash)
            )
        self.s.commit()

    # ---------------------------------------------------------- bookkeeping

    def _beat(self) -> None:
        now = time.monotonic()
        if now - self._last_beat < HEARTBEAT:
            return
        self._last_beat = now
        self._flush_outcomes()
        self.job.heartbeat_at = _now()
        self.s.commit()

    def _stop_requested(self) -> bool:
        if self.stop_flag.is_set():
            return True
        now = time.monotonic()
        if now - self._last_stop_check < 1.0:
            return False
        self._last_stop_check = now
        status = self.s.execute(
            select(WebCollectJob.status).where(WebCollectJob.id == self.job.id)
        ).scalar_one_or_none()
        if status is None or status == STATUS_CANCELING or status in TERMINAL_STATUSES:
            self.stop_flag.set()
            return True
        return False

    def _all_done(self) -> bool:
        if self.inflight or self.to_score:
            return False
        return all(r.status in (KW_DONE, KW_EXHAUSTED, KW_LIMITED) for r in self.rows.values())

    def _note_error(self, exc: Exception) -> None:
        try:
            job = self.s.get(WebCollectJob, self.job.id)
            if job is not None:
                job.notice = f"Restarting after an error: {type(exc).__name__}: {exc}"[:500]
                self.s.commit()
        except Exception:  # noqa: BLE001
            self.s.rollback()

    def _finish(self, status: str, error: str | None = None) -> dict:
        job = self.s.get(WebCollectJob, self.job.id)
        job.status = status
        job.completed_at = _now()
        job.notice = None
        if error:
            job.error = error[:1000]
        job.resume_after = None
        self.s.commit()
        log.info(
            "web_collect.finished job_id=%s status=%s added=%s rejected=%s failed=%s",
            job.id,
            status,
            job.added,
            job.rejected,
            job.failed,
        )
        return {"ok": True, "status": status, "added": job.added}


def _enqueue_thumbnail(content_hash: str, ext: str, asset_id: str) -> None:
    try:
        from carve_api.jobs.queue import enqueue_with_defaults, get_queue
        from carve_api.jobs.thumbs import generate_image_thumbnail

        enqueue_with_defaults(
            get_queue(), generate_image_thumbnail, content_hash, ext, asset_id=asset_id
        )
    except Exception:  # noqa: BLE001 — the image is in; a thumbnail can be made later
        log.warning("web_collect.thumbnail_enqueue_failed asset_id=%s", asset_id, exc_info=True)


# --------------------------------------------------------------------------
# Enqueue and the supervisor
# --------------------------------------------------------------------------


def enqueue(job_id: str, attempt: int = 0, connection=None) -> None:  # noqa: ANN001
    from carve_api.jobs.queue import enqueue_resumable

    enqueue_resumable(
        run_web_collect, job_id, rq_job_id=f"{RQ_PREFIX}{job_id}-{attempt}", connection=connection
    )


def _rq_alive(conn, job_id: str) -> bool:  # noqa: ANN001
    from rq import Queue
    from rq.registry import StartedJobRegistry

    reg = StartedJobRegistry(QUEUE, connection=conn)
    reg.cleanup()  # frees jobs whose worker died
    ids = list(Queue(QUEUE, connection=conn).job_ids) + reg.get_job_ids()
    prefix = f"{RQ_PREFIX}{job_id}-"
    return any(i.split(":")[0].startswith(prefix) for i in ids)


def supervise(session: Session, connection) -> int:  # noqa: ANN001
    """Restart every run that should be working and has nothing behind
    it in RQ (worker killed, machine restarted, Redis flushed). Called
    from the API's poller thread every few seconds. A run is restarted
    the second time it is seen idle, so one between two RQ attempts is
    left alone; its lock keeps a duplicate out anyway."""
    now = _now()
    jobs = (
        session.execute(
            select(WebCollectJob).where(WebCollectJob.status.in_(list(ACTIVE_STATUSES)))
        )
        .scalars()
        .all()
    )
    started = 0
    for job in jobs:
        if job.created_at > now - _GRACE:
            continue
        if job.resume_after is not None and job.resume_after > now:
            continue
        jid = str(job.id)
        if _rq_alive(connection, jid):
            connection.delete(f"webcollect:idle:{jid}")
            continue
        if job.status == STATUS_CANCELING:
            job.status = STATUS_CANCELED
            job.completed_at = now
            job.notice = None
            session.commit()
            continue
        if not connection.set(f"webcollect:idle:{jid}", "1", nx=True, ex=120):
            connection.delete(f"webcollect:idle:{jid}")
            if job.stalls >= _MAX_STALLS:
                job.status = STATUS_FAILED
                job.error = "The run kept stopping without finishing; see the worker logs."
                job.completed_at = now
                session.commit()
                continue
            job.stalls += 1
            if job.status == STATUS_RUNNING:
                job.status = STATUS_QUEUED
            session.commit()
            enqueue(jid, job.stalls, connection)
            started += 1
            log.warning("web_collect.restarted job_id=%s stalls=%s", jid, job.stalls)
    return started
