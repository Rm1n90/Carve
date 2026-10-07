# Armin Mehri — mehri.armin@gmail.com
"""What Logo AI has spent, and what is left to spend.

Three sources, in order of how much they can be trusted for what:

* Carve's own books: every request's tokens are priced when its answer
  is read and added to its run (``logo_ai_jobs.cost_usd``). Always
  there, exact for what Carve sent, blind to anything else that uses
  the same provider account.
* The provider's cost report, where it has one and an admin key is set
  (OpenAI: ``OPENAI_ADMIN_KEY``). Covers the whole organization, in
  whole UTC days, and trails real time by some minutes.
* The credit balance. No provider tells an API client what is left of a
  prepaid balance, so an admin copies it from the provider's billing
  page once (:func:`set_credit`), and what is spent after that moment
  is taken off it: by Carve's books, or by the provider's report when
  that shows more (someone else spending from the same account).
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from carve_api.config import get_settings
from carve_api.logo_ai import catalog
from carve_api.logo_ai.models import LogoAiCredit, LogoAiJob

log = logging.getLogger(__name__)

# The provider's report is asked for at most this often; the dialog
# polls, the report does not change by the second.
_REPORT_FRESH_SECONDS = 60
_REPORT_TIMEOUT = 10.0
# As far back as one page of daily buckets reaches.
_REPORT_MAX_DAYS = 180
_REPORT_MAX_PAGES = 4

# Providers whose cost report can be read, and the setting that holds
# the admin key for it.
ADMIN_KEY_ENV = {catalog.OPENAI: "OPENAI_ADMIN_KEY"}


@dataclass
class Reported:
    """A provider's own account of what the organization has spent."""

    days: dict[date, float] = field(default_factory=dict)  # per UTC day
    # The hard monthly spend limit, when one is set.
    spend_limit_usd: float | None = None
    limit_enforcing: bool = False
    fetched_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def since(self, day: date) -> float:
        return round(sum(v for d, v in self.days.items() if d >= day), 6)

    @property
    def today_usd(self) -> float:
        return round(self.days.get(datetime.now(UTC).date(), 0.0), 6)

    @property
    def month_usd(self) -> float:
        return self.since(datetime.now(UTC).date().replace(day=1))


class ReportUnavailable(Exception):
    """The provider's report could not be read; the message says why."""


def admin_key_for(provider_id: str) -> str:
    return {catalog.OPENAI: get_settings().openai_admin_key}.get(provider_id, "")


def _openai_admin_client():  # noqa: ANN202 — SDK client
    import openai

    return openai.OpenAI(
        admin_api_key=admin_key_for(catalog.OPENAI), max_retries=1, timeout=_REPORT_TIMEOUT
    )


def _openai_report(start: datetime) -> Reported:
    import openai

    client = _openai_admin_client()
    report = Reported()
    try:
        page: str | None = None
        for _ in range(_REPORT_MAX_PAGES):
            costs = client.admin.organization.usage.costs(
                start_time=int(start.timestamp()),
                bucket_width="1d",
                limit=_REPORT_MAX_DAYS,
                **({"page": page} if page else {}),
            )
            for bucket in costs.data:
                day = datetime.fromtimestamp(bucket.start_time, UTC).date()
                amounts = (getattr(r, "amount", None) for r in bucket.results)
                report.days[day] = report.days.get(day, 0.0) + sum(
                    float(a.value or 0.0) for a in amounts if a is not None
                )
            page = costs.next_page
            if not costs.has_more or not page:
                break
    except (openai.AuthenticationError, openai.PermissionDeniedError) as exc:
        raise ReportUnavailable(
            "OpenAI rejected OPENAI_ADMIN_KEY. It has to be an admin key "
            "(Organization settings, Admin keys), not a project key."
        ) from exc
    except openai.APIError as exc:
        raise ReportUnavailable("OpenAI's cost report could not be read just now.") from exc
    try:
        limit = client.admin.organization.spend_limit.retrieve()
        report.spend_limit_usd = limit.threshold_amount / 100  # cents
        report.limit_enforcing = limit.enforcement.status == "enforcing"
    except openai.APIError:
        pass  # none set, or not readable: the costs are still worth showing
    return report


_cache: dict[tuple[str, int], tuple[float, Reported]] = {}
_cache_lock = threading.Lock()


def reported(provider_id: str, *, since: datetime | None = None, fresh: bool = False) -> Reported:
    """The provider's cost report from the start of this month, or from
    ``since`` if that is earlier. Raises :class:`ReportUnavailable`."""
    if not admin_key_for(provider_id):
        raise ReportUnavailable("no admin key")
    now = datetime.now(UTC)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if since is not None:
        start = min(start, since.replace(hour=0, minute=0, second=0, microsecond=0))
    start = max(start, now - timedelta(days=_REPORT_MAX_DAYS - 1))
    key = (provider_id, int(start.timestamp()))
    with _cache_lock:
        hit = _cache.get(key)
        if hit and not fresh and time.monotonic() - hit[0] < _REPORT_FRESH_SECONDS:
            return hit[1]
    report = _openai_report(start)
    with _cache_lock:
        _cache[key] = (time.monotonic(), report)
    return report


def book(session: Session | None, provider_id: str, cost_usd: float) -> None:
    """Take a booked cost off the provider's credit balance, if one has
    been entered. Part of the caller's transaction: it is kept or undone
    together with the run's own counters."""
    if session is None or cost_usd <= 0:
        return
    session.execute(
        update(LogoAiCredit)
        .where(LogoAiCredit.provider == provider_id)
        .values(spent_usd=LogoAiCredit.spent_usd + cost_usd)
    )


def set_credit(
    session: Session, provider_id: str, amount_usd: float | None, user_id: uuid.UUID | None
) -> None:
    """Record the provider's credit balance as of now (``None`` forgets
    it). Commits."""
    row = session.get(LogoAiCredit, provider_id)
    if amount_usd is None:
        if row is not None:
            session.delete(row)
        session.commit()
        return
    if row is None:
        row = LogoAiCredit(provider=provider_id)
        session.add(row)
    now = datetime.now(UTC)
    row.amount_usd = amount_usd
    row.as_of = now
    row.spent_usd = 0.0
    # What the provider had already reported for today: today's bucket
    # holds spending from before this moment too, and that part is
    # already in the balance just entered.
    row.reported_day_usd = None
    try:
        row.reported_day_usd = reported(provider_id, fresh=True).today_usd
    except ReportUnavailable:
        pass
    row.updated_by = user_id
    session.commit()


@dataclass
class Credit:
    amount_usd: float
    as_of: datetime
    used_usd: float
    left_usd: float
    # Whose figure ``used_usd`` is: "carve" or "provider".
    source: str


@dataclass
class ProviderBilling:
    provider: catalog.ProviderSpec
    spent_month_usd: float = 0.0
    spent_total_usd: float = 0.0
    credit: Credit | None = None
    report: Reported | None = None
    report_error: str | None = None


def _credit(row: LogoAiCredit, report: Reported | None) -> Credit:
    used, source = row.spent_usd or 0.0, "carve"
    if report is not None and row.reported_day_usd is not None:
        theirs = report.since(row.as_of.astimezone(UTC).date()) - row.reported_day_usd
        if theirs > used:
            used, source = theirs, "provider"
    used = round(max(used, 0.0), 4)
    return Credit(
        amount_usd=row.amount_usd,
        as_of=row.as_of,
        used_usd=used,
        left_usd=round(row.amount_usd - used, 4),
        source=source,
    )


def summary(session: Session) -> list[ProviderBilling]:
    month = datetime.now(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    in_month = func.sum(LogoAiJob.cost_usd).filter(LogoAiJob.created_at >= month)
    books = {
        provider: (float(total or 0.0), float(this_month or 0.0))
        for provider, total, this_month in session.execute(
            select(LogoAiJob.provider, func.sum(LogoAiJob.cost_usd), in_month).group_by(
                LogoAiJob.provider
            )
        )
    }
    out: list[ProviderBilling] = []
    for spec in catalog.PROVIDERS.values():
        total, this_month = books.get(spec.id, (0.0, 0.0))
        entry = ProviderBilling(
            provider=spec, spent_total_usd=round(total, 4), spent_month_usd=round(this_month, 4)
        )
        row = session.get(LogoAiCredit, spec.id)
        if admin_key_for(spec.id):
            try:
                entry.report = reported(spec.id, since=row.as_of if row else None)
            except ReportUnavailable as exc:
                entry.report_error = str(exc)
        if row is not None:
            entry.credit = _credit(row, entry.report)
        out.append(entry)
    return out


def task_spent(session: Session, task_id: uuid.UUID) -> float:
    return round(
        float(
            session.execute(
                select(func.coalesce(func.sum(LogoAiJob.cost_usd), 0.0)).where(
                    LogoAiJob.task_id == task_id
                )
            ).scalar_one()
        ),
        4,
    )
