# Armin Mehri — mehri.armin@gmail.com
"""Billing: what was spent, the entered credit balance, the provider's report."""

from datetime import UTC, datetime, timedelta

import httpx2
import openai
import pytest
from fastapi.testclient import TestClient

from carve_api.auth.models import UserRole
from carve_api.config import get_settings
from carve_api.deps import get_current_user, get_db
from carve_api.logo_ai import billing
from carve_api.logo_ai import jobs as jobs_mod
from carve_api.logo_ai.models import STATUS_COMPLETED, STATUS_RUNNING, LogoAiCredit, LogoAiJob
from carve_api.logo_ai.providers.base import ProviderResult
from carve_api.main import create_app
from carve_api.projects.models import ProjectMember

from .conftest import Seeded, ok, seed


@pytest.fixture(autouse=True)
def _no_report_cache():
    billing._cache.clear()
    yield
    billing._cache.clear()


def _client(db_session, seeded: Seeded) -> TestClient:
    app = create_app()

    def _db():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: seeded.user
    return TestClient(app)


def _provider_row(body: dict, provider_id: str) -> dict:
    return next(p for p in body["providers"] if p["id"] == provider_id)


def _day(days_ago: int = 0) -> int:
    today = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return int((today - timedelta(days=days_ago)).timestamp())


def _costs(*days: tuple[int, float]) -> dict:
    return {
        "object": "page",
        "has_more": False,
        "next_page": None,
        "data": [
            {
                "object": "bucket",
                "start_time": start,
                "end_time": start + 86400,
                "results": [
                    {
                        "object": "organization.costs.result",
                        "amount": {"value": value, "currency": "usd"},
                    }
                ],
            }
            for start, value in days
        ],
    }


_LIMIT = {
    "object": "organization.spend_limit", "currency": "USD", "interval": "month",
    "threshold_amount": 12000, "enforcement": {"status": "enforcing"},
}


class _Report:
    """OpenAI's admin endpoints, answering from what the test sets."""

    def __init__(self, monkeypatch) -> None:
        self.costs: tuple[int, dict] = (200, _costs())
        self.limit: tuple[int, dict] = (200, _LIMIT)
        self.requests: list[httpx2.Request] = []
        monkeypatch.setattr(billing, "admin_key_for", lambda p: "sk-admin" if p == "openai" else "")
        monkeypatch.setattr(
            billing,
            "_openai_admin_client",
            lambda: openai.OpenAI(
                admin_api_key="sk-admin",
                max_retries=0,
                http_client=openai.DefaultHttpxClient(transport=httpx2.MockTransport(self)),
            ),
        )

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        status, body = self.costs if request.url.path.endswith("/costs") else self.limit
        return httpx2.Response(status, json=body)


def test_every_booked_cost_comes_off_the_entered_balance(db_session, provider, queue) -> None:
    s = seed(db_session)
    billing.set_credit(db_session, "anthropic", 10.0, s.user.id)
    job = s.job(db_session)
    assert job.provider == "anthropic"

    jobs_mod.run_logo_ai_realtime(str(job.id))

    db_session.expire_all()
    job = db_session.get(LogoAiJob, job.id)
    assert job.status == STATUS_COMPLETED and job.cost_usd > 0
    (entry,) = [b for b in billing.summary(db_session) if b.provider.id == "anthropic"]
    assert entry.credit.used_usd == pytest.approx(job.cost_usd, abs=1e-4)
    assert entry.credit.left_usd == pytest.approx(10.0 - job.cost_usd, abs=1e-4)
    assert entry.credit.source == "carve"
    assert entry.spent_total_usd == entry.spent_month_usd == pytest.approx(job.cost_usd, abs=1e-4)
    # The other provider's balance is its own.
    assert db_session.get(LogoAiCredit, "openai") is None

    # Deleting the run does not hand the money back.
    db_session.delete(job)
    db_session.commit()
    (entry,) = [b for b in billing.summary(db_session) if b.provider.id == "anthropic"]
    assert entry.spent_total_usd == 0 and entry.credit.left_usd < 10.0


def test_the_balance_counts_what_was_billed_before_the_credit_ran_out(
    db_session, provider, queue
) -> None:
    s = seed(db_session, n_assets=6)
    billing.set_credit(db_session, "anthropic", 10.0, s.user.id)
    provider.script = [ok(), ok(), *[ProviderResult(error="out_of_credit")] * 3]
    job = s.job(db_session)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    db_session.expire_all()
    job = db_session.get(LogoAiJob, job.id)
    assert job.status == STATUS_RUNNING and "out of credit" in job.notice
    # Two requests were answered and billed; the books and the balance agree.
    row = db_session.get(LogoAiCredit, "anthropic")
    assert row.spent_usd == pytest.approx(job.cost_usd, abs=1e-6) and job.cost_usd > 0


def test_billing_endpoint_and_who_may_enter_a_balance(db_session, provider, monkeypatch) -> None:
    s = seed(db_session)
    client = _client(db_session, s)
    url = f"/inference/logo-ai/billing?task_id={s.task.id}"

    body = client.get(url).json()
    row = _provider_row(body, "openai")
    assert body["can_edit"] and body["task_usd"] == 0
    assert row["credit"] is None and row["reported"] is None
    assert row["admin_key_env"] == "OPENAI_ADMIN_KEY" and not row["admin_key_set"]
    assert _provider_row(body, "anthropic")["admin_key_env"] is None

    put = f"/inference/logo-ai/billing/openai/credit?task_id={s.task.id}"
    body = client.put(put, json={"amount_usd": 25}).json()
    credit = _provider_row(body, "openai")["credit"]
    assert (credit["amount_usd"], credit["used_usd"], credit["left_usd"]) == (25, 0, 25)
    assert client.put(put, json={"amount_usd": -1}).status_code == 422
    assert client.put(put.replace("openai", "nope"), json={"amount_usd": 1}).status_code == 404
    # Forgotten again.
    body = client.put(put, json={"amount_usd": None}).json()
    assert _provider_row(body, "openai")["credit"] is None

    # A member who may run Logo AI sees the figures but does not set them.
    monkeypatch.setattr(get_settings(), "logo_ai_allow_members", True)
    m = seed(db_session, role=UserRole.member)
    db_session.add(ProjectMember(project_id=m.project.id, user_id=m.user.id, role="member"))
    m.task.gpu_access_for_members = True
    db_session.commit()
    member = _client(db_session, m)
    seen = member.get(f"/inference/logo-ai/billing?task_id={m.task.id}")
    assert seen.status_code == 200 and not seen.json()["can_edit"]
    refused = member.put(
        f"/inference/logo-ai/billing/openai/credit?task_id={m.task.id}", json={"amount_usd": 5}
    )
    assert refused.status_code == 403
    # And one who may not run it sees nothing.
    m.task.gpu_access_for_members = False
    db_session.commit()
    assert member.get(f"/inference/logo-ai/billing?task_id={m.task.id}").status_code == 403


def test_the_providers_report_is_shown_and_catches_spending_from_elsewhere(
    db_session, provider, monkeypatch
) -> None:
    report = _Report(monkeypatch)
    s = seed(db_session)
    client = _client(db_session, s)
    url = f"/inference/logo-ai/billing?task_id={s.task.id}"

    # $3 already spent today when the balance is read off the billing page.
    report.costs = (200, _costs((_day(1), 2.0), (_day(0), 3.0)))
    put = f"/inference/logo-ai/billing/openai/credit?task_id={s.task.id}"
    row = _provider_row(client.put(put, json={"amount_usd": 20}).json(), "openai")
    assert row["admin_key_set"] and row["reported_error"] is None
    assert row["reported"]["today_usd"] == 3.0
    assert row["reported"]["spend_limit_usd"] == 120.0 and row["reported"]["limit_enforcing"]
    # Nothing since: today's $3 was already in the balance.
    assert (row["credit"]["used_usd"], row["credit"]["left_usd"]) == (0, 20)
    assert report.requests[0].headers["authorization"] == "Bearer sk-admin"

    # Something else spends $1.50 from the same account.
    billing._cache.clear()
    report.costs = (200, _costs((_day(1), 2.0), (_day(0), 4.5)))
    credit = _provider_row(client.get(url).json(), "openai")["credit"]
    assert (credit["used_usd"], credit["left_usd"], credit["source"]) == (1.5, 18.5, "provider")

    # Asked again within the minute: answered from memory, not from OpenAI.
    asked = len(report.requests)
    client.get(url)
    assert len(report.requests) == asked


def test_an_unreadable_report_does_not_take_the_rest_down(
    db_session, provider, monkeypatch
) -> None:
    report = _Report(monkeypatch)
    report.costs = (401, {"error": {"message": "bad key", "type": "invalid_request_error"}})
    s = seed(db_session)
    billing.set_credit(db_session, "openai", 5.0, s.user.id)
    r = _client(db_session, s).get(f"/inference/logo-ai/billing?task_id={s.task.id}")
    row = _provider_row(r.json(), "openai")
    assert r.status_code == 200 and row["reported"] is None
    assert "admin key" in row["reported_error"]
    assert row["credit"]["left_usd"] == 5.0

    # No spend limit set: the costs are still shown.
    billing._cache.clear()
    report.costs = (200, _costs((_day(0), 1.25)))
    report.limit = (404, {"error": {"message": "none", "type": "invalid_request_error"}})
    row = _provider_row(
        _client(db_session, s).get(f"/inference/logo-ai/billing?task_id={s.task.id}").json(),
        "openai",
    )
    assert row["reported"]["month_usd"] == 1.25 and row["reported"]["spend_limit_usd"] is None
