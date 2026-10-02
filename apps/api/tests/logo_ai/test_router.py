# Armin Mehri — mehri.armin@gmail.com
"""HTTP surface: config, single-image detect, estimate, job lifecycle."""

import json
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from carve_api.annotations.models import Annotation
from carve_api.auth.models import UserRole
from carve_api.config import get_settings
from carve_api.deps import get_current_user, get_db
from carve_api.logo_ai import jobs as jobs_mod
from carve_api.logo_ai import providers as providers_mod
from carve_api.logo_ai import router as router_mod
from carve_api.logo_ai.models import (
    PART_FAILED,
    STATUS_CANCELED,
    STATUS_CANCELING,
    STATUS_QUEUED,
    STATUS_RUNNING,
    STATUS_SUBMITTED,
    LogoAiBatchPart,
    LogoAiJob,
)
from carve_api.logo_ai.providers.base import ProviderResult
from carve_api.main import create_app
from carve_api.projects.models import ProjectMember

from .conftest import Seeded, answer, ok, seed


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


@pytest.fixture
def redis(monkeypatch):
    monkeypatch.setattr(router_mod, "_redis_or_503", lambda: object())


def _member(db_session, *, task_grant: bool) -> Seeded:
    s = seed(db_session, role=UserRole.member)
    db_session.add(ProjectMember(project_id=s.project.id, user_id=s.user.id, role="member"))
    s.task.gpu_access_for_members = task_grant
    db_session.commit()
    return s


# --- config -----------------------------------------------------------------


def test_config_lists_providers_and_what_is_configured(db_session) -> None:
    s = seed(db_session)
    body = _client(db_session, s).get(
        "/inference/logo-ai/config", params={"task_id": str(s.task.id)}
    ).json()
    assert body["allowed"] is True
    by_id = {p["id"]: p for p in body["providers"]}
    assert set(by_id) == {"anthropic", "openai"}
    # No keys in the test environment.
    assert not by_id["anthropic"]["configured"] and not by_id["openai"]["configured"]
    assert by_id["anthropic"]["default_model"] == "claude-opus-5-5"
    assert by_id["openai"]["supports_flex"] and not by_id["anthropic"]["supports_flex"]
    haiku = next(m for m in by_id["anthropic"]["models"] if m["id"] == "claude-haiku-4-5")
    assert haiku["efforts"] == [] and haiku["default_effort"] is None
    assert body["default_detail"] in body["details"]


def test_config_reflects_keys_from_the_environment(db_session, monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    get_settings.cache_clear()
    try:
        s = seed(db_session)
        body = _client(db_session, s).get("/inference/logo-ai/config").json()
        by_id = {p["id"]: p for p in body["providers"]}
        assert by_id["openai"]["configured"] and not by_id["anthropic"]["configured"]
        # No task given: nothing to be allowed on.
        assert body["allowed"] is False
    finally:
        monkeypatch.delenv("OPENAI_API_KEY")
        get_settings.cache_clear()


# --- permissions ------------------------------------------------------------


def test_members_are_refused_even_with_the_ai_grant(db_session, provider) -> None:
    s = _member(db_session, task_grant=True)
    client = _client(db_session, s)
    r = client.post(f"/tasks/{s.task.id}/logo-ai/estimate", json=s.params())
    assert r.status_code == 403 and r.json()["error"] == "logo_ai_forbidden"
    r = client.post(f"/assets/{s.assets[0].id}/logo-ai/detect", json=s.params())
    assert r.status_code == 403
    assert client.get(
        "/inference/logo-ai/config", params={"task_id": str(s.task.id)}
    ).json()["allowed"] is False
    assert provider.sent == []


def test_members_allowed_when_the_deployment_opts_in(db_session, provider, monkeypatch) -> None:
    monkeypatch.setenv("LOGO_AI_ALLOW_MEMBERS", "true")
    get_settings.cache_clear()
    try:
        granted = _member(db_session, task_grant=True)
        r = _client(db_session, granted).post(
            f"/tasks/{granted.task.id}/logo-ai/estimate", json=granted.params()
        )
        assert r.status_code == 200
        # The opt-in does not replace the per-task grant.
        ungranted = _member(db_session, task_grant=False)
        r = _client(db_session, ungranted).post(
            f"/tasks/{ungranted.task.id}/logo-ai/estimate", json=ungranted.params()
        )
        assert r.status_code == 403
    finally:
        monkeypatch.delenv("LOGO_AI_ALLOW_MEMBERS")
        get_settings.cache_clear()


# --- single image -----------------------------------------------------------


def test_detect_writes_boxes_and_reports_cost(db_session, provider) -> None:
    s = seed(db_session)
    provider.script = [ok(answer((49, 49, 147, 98), confidence=0.95))]
    r = _client(db_session, s).post(
        f"/assets/{s.assets[0].id}/logo-ai/detect", json=s.params(min_confidence=0.5)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["annotations_created"] == 1 and body["below_threshold"] == 0
    assert body["annotations"][0]["kind"] == "bbox"
    assert body["annotations"][0]["class_id"] == str(s.classes[0].id)
    assert body["usage"]["input_tokens"] == 1000 and body["cost_usd"] > 0
    assert db_session.execute(select(Annotation)).scalars().one().frame_id == s.frames[0].id

    # The run is on the books: it cost money like any other.
    job = db_session.execute(select(LogoAiJob)).scalars().one()
    assert (job.delivery, job.status, job.annotations_created) == ("single", "completed", 1)
    assert job.usage["output_tokens"] == 100 and job.usage["requests"] == 1
    assert job.cost_usd == pytest.approx(body["cost_usd"])
    listed = _client(db_session, s).get(f"/tasks/{s.task.id}/logo-ai/jobs").json()
    assert listed[0]["label"] == "img-0.jpg" and listed[0]["progress"] == 1


def test_detect_reports_what_the_thresholds_left_out(db_session, provider) -> None:
    s = seed(db_session)
    rows = {
        "detections": [
            [10, 10, 60, 60, 95, 100],
            [70, 10, 120, 60, 95, 30],    # mostly hidden
            [130, 10, 180, 60, 20, 100],  # not confident
        ]
    }
    provider.script = [ok(json.dumps(rows))]
    body = _client(db_session, s).post(
        f"/assets/{s.assets[0].id}/logo-ai/detect",
        json=s.params(min_confidence=0.5, min_visible=50),
    ).json()
    assert (body["annotations_created"], body["below_threshold"], body["mostly_hidden"]) == (1, 1, 1)


def test_detect_surfaces_a_provider_failure(db_session, provider) -> None:
    s = seed(db_session)
    provider.script = [ProviderResult(error="refusal")]
    r = _client(db_session, s).post(
        f"/assets/{s.assets[0].id}/logo-ai/detect", json=s.params()
    )
    assert r.status_code == 502
    assert r.json() == {"error": "logo_ai_failed", "message": "refusal"}
    assert db_session.execute(select(Annotation)).first() is None
    # A failed attempt is recorded too, and does not block the next run.
    job = db_session.execute(select(LogoAiJob)).scalars().one()
    assert (job.delivery, job.status, job.error) == ("single", "failed", "refusal")


def test_detect_rejects_bad_requests(db_session, provider, monkeypatch) -> None:
    s = seed(db_session)
    client = _client(db_session, s)
    url = f"/assets/{s.assets[0].id}/logo-ai/detect"

    other_class = {"class_id": str(uuid.uuid4()), "prompt": "x"}
    r = client.post(url, json=s.params(prompts=[other_class]))
    assert r.status_code == 422 and r.json()["error"] == "logo_ai_bad_request"
    assert client.post(url, json=s.params(model="gpt-6.1-sol")).status_code == 422
    assert client.post(url, json=s.params(detail="ultra")).status_code == 422
    assert provider.sent == []


def test_references_must_come_from_the_same_task(db_session, provider) -> None:
    s = seed(db_session)
    other = seed(db_session)
    ref = {"class_id": str(s.classes[0].id), "bbox": [10, 10, 120, 80]}
    client = _client(db_session, s)
    url = f"/assets/{s.assets[0].id}/logo-ai/detect"

    foreign = client.post(
        url, json=s.params(references=[{**ref, "asset_id": str(other.assets[0].id)}])
    )
    assert foreign.status_code == 422
    assert "not in this task" in foreign.json()["message"]

    same = client.post(
        url, json=s.params(references=[{**ref, "asset_id": str(s.assets[1].id)}])
    )
    assert same.status_code == 200
    (reference,) = provider.ctx.references
    assert reference.class_index == 0 and reference.jpeg.startswith(b"\xff\xd8")


# --- estimate ---------------------------------------------------------------


def test_estimate_prices_realtime_above_batch(db_session, provider) -> None:
    s = seed(db_session)
    r = _client(db_session, s).post(f"/tasks/{s.task.id}/logo-ai/estimate", json=s.params())
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["assets"], body["requests"]) == (3, 3)
    # 392x196 → 14 x 7 patches per image.
    assert body["image_tokens"] == 3 * 98
    assert body["prefix_cached"] is True and body["prefix_tokens"] > 1000
    assert 0 < body["cost_batch_usd"] < body["cost_realtime_usd"]
    assert body["cost_flex_usd"] is None  # Anthropic has no flex tier

    assert body["based_on_requests"] == 0  # no run yet: the planning figure

    subset = _client(db_session, s).post(
        f"/tasks/{s.task.id}/logo-ai/estimate",
        json=s.params(asset_ids=[str(s.assets[0].id)]),
    ).json()
    assert subset["assets"] == 1


def test_estimate_learns_from_the_tasks_own_runs(db_session, provider) -> None:
    s = seed(db_session)
    client = _client(db_session, s)
    before = client.post(f"/tasks/{s.task.id}/logo-ai/estimate", json=s.params()).json()

    # One image turns out far more expensive than the planning figure.
    dense = ok()
    dense.usage.output_tokens = 5000
    provider.script = [dense]
    assert client.post(
        f"/assets/{s.assets[0].id}/logo-ai/detect", json=s.params()
    ).status_code == 200

    after = client.post(f"/tasks/{s.task.id}/logo-ai/estimate", json=s.params()).json()
    assert after["based_on_requests"] == 1
    assert after["output_tokens"] == 3 * 5000 > before["output_tokens"]
    assert after["cost_realtime_usd"] > before["cost_realtime_usd"]
    # A different effort has its own history (none yet).
    other = client.post(
        f"/tasks/{s.task.id}/logo-ai/estimate", json=s.params(effort="high")
    ).json()
    assert other["based_on_requests"] == 0


# --- jobs -------------------------------------------------------------------


def test_create_job_queues_a_realtime_run(db_session, provider, queue, redis) -> None:
    s = seed(db_session)
    client = _client(db_session, s)
    r = client.post(f"/tasks/{s.task.id}/logo-ai/jobs", json=s.params())
    assert r.status_code == 201, r.text
    body = r.json()
    assert (body["status"], body["delivery"], body["total_assets"]) == (STATUS_QUEUED, "realtime", 3)
    assert body["progress"] == 0 and body["estimated_cost_usd"] > 0
    assert queue == [("run_logo_ai_realtime", "")]

    job = db_session.get(LogoAiJob, uuid.UUID(body["id"]))
    assert job.params["prompts"] == s.params()["prompts"]
    assert job.created_by == s.user.id

    assert client.get(f"/tasks/{s.task.id}/logo-ai/jobs").json()[0]["id"] == body["id"]
    assert client.get(f"/tasks/{s.task.id}/logo-ai/jobs/{body['id']}").status_code == 200
    other = seed(db_session)
    assert client.get(f"/tasks/{other.task.id}/logo-ai/jobs/{body['id']}").status_code == 404


def test_create_job_refuses_a_second_run_on_the_same_task(db_session, provider, queue, redis) -> None:
    s = seed(db_session)
    client = _client(db_session, s)
    assert client.post(f"/tasks/{s.task.id}/logo-ai/jobs", json=s.params()).status_code == 201
    r = client.post(f"/tasks/{s.task.id}/logo-ai/jobs", json=s.params(delivery="batch"))
    assert r.status_code == 409 and r.json()["error"] == "logo_ai_job_active"
    assert len(queue) == 1


def test_create_batch_job_queues_the_submit_and_drops_flex(db_session, provider, queue, redis) -> None:
    s = seed(db_session)
    params = s.params(provider="openai", model="gpt-6-sol", delivery="batch", flex=True)
    r = _client(db_session, s).post(f"/tasks/{s.task.id}/logo-ai/jobs", json=params)
    assert r.status_code == 201, r.text
    assert queue == [("run_logo_ai_batch_submit", "")]
    job = db_session.get(LogoAiJob, uuid.UUID(r.json()["id"]))
    assert job.delivery == "batch" and job.params["flex"] is False


def test_create_job_needs_a_configured_provider(db_session, provider, queue, redis, monkeypatch) -> None:
    monkeypatch.setattr(providers_mod, "is_configured", lambda _p: False)
    s = seed(db_session)
    r = _client(db_session, s).post(f"/tasks/{s.task.id}/logo-ai/jobs", json=s.params())
    assert r.status_code == 400 and r.json()["error"] == "logo_ai_not_configured"
    assert queue == []


def test_create_job_with_nothing_to_do(db_session, provider, queue, redis) -> None:
    s = seed(db_session, n_assets=0)
    r = _client(db_session, s).post(f"/tasks/{s.task.id}/logo-ai/jobs", json=s.params())
    assert r.status_code == 422 and "no assets" in r.json()["message"]


def test_failed_enqueue_leaves_no_orphan_row(db_session, provider, monkeypatch, redis) -> None:
    from carve_api.logo_ai import jobs as jobs_mod

    def boom(*_a, **_k):
        raise RuntimeError("redis down")

    monkeypatch.setattr(jobs_mod, "enqueue", boom)
    s = seed(db_session)
    r = _client(db_session, s).post(f"/tasks/{s.task.id}/logo-ai/jobs", json=s.params())
    assert r.status_code == 503
    assert db_session.execute(select(LogoAiJob)).first() is None


def test_cancel_lifecycle(db_session, provider, queue, redis, monkeypatch) -> None:
    import carve_api.jobs.queue as queue_mod

    dequeued: list[str] = []
    monkeypatch.setattr(queue_mod, "try_cancel_rq_job", lambda _c, jid: dequeued.append(jid))
    s = seed(db_session)
    client = _client(db_session, s)
    base = f"/tasks/{s.task.id}/logo-ai/jobs"

    # Queued: taken straight off the queue.
    job = s.job(db_session)
    assert client.post(f"{base}/{job.id}/cancel").json()["status"] == STATUS_CANCELED
    assert dequeued == [str(job.id)]
    # Terminal: a stale click changes nothing.
    assert client.post(f"{base}/{job.id}/cancel").json()["status"] == STATUS_CANCELED

    # Running realtime: asks the worker to stop; asking again closes it
    # out directly (the worker never answered).
    job = s.job(db_session)
    job.status = STATUS_RUNNING
    db_session.commit()
    assert client.post(f"{base}/{job.id}/cancel").json()["status"] == STATUS_CANCELING
    assert client.post(f"{base}/{job.id}/cancel").json()["status"] == STATUS_CANCELED

    # Submitted batch: waits for the provider, and a poll is queued now.
    job = s.job(db_session, delivery="batch")
    job.status = STATUS_SUBMITTED
    db_session.commit()
    queue.clear()
    assert client.post(f"{base}/{job.id}/cancel").json()["status"] == STATUS_CANCELING
    assert queue == [("poll", "")]
    assert client.post(f"{base}/{job.id}/cancel").json()["status"] == STATUS_CANCELING


def test_force_stop_closes_a_batch_the_provider_never_lets_go_of(
    db_session, provider, queue, redis
) -> None:
    s = seed(db_session)
    client = _client(db_session, s)
    job = s.job(db_session, delivery="batch")
    jobs_mod.run_logo_ai_batch_submit(str(job.id))
    db_session.expire_all()  # the worker's session wrote the row
    url = f"/tasks/{s.task.id}/logo-ai/jobs/{job.id}/cancel"

    # Force only means something once a normal cancel is under way: on a
    # running batch it is an ordinary cancel, which keeps the results.
    assert client.post(url, params={"force": True}).json()["status"] == STATUS_CANCELING
    out = client.post(url, params={"force": True}).json()
    assert out["status"] == STATUS_CANCELED
    # The two images still with the provider are given up, the
    # preflight one is kept.
    assert (out["done_assets"], out["failed_assets"], out["annotations_created"]) == (3, 2, 1)
    (part,) = db_session.execute(select(LogoAiBatchPart)).scalars()
    assert part.status == PART_FAILED and "force-stopped" in part.error

    # The task's run slot is free again.
    r = client.post(f"/tasks/{s.task.id}/logo-ai/jobs", json={**s.params(), "delivery": "batch"})
    assert r.status_code == 201, r.text


# --- score filter -----------------------------------------------------------


def _scored(db, s: Seeded, frame, x, confidence, visible, status="proposed") -> Annotation:
    a = Annotation(
        task_id=s.task.id, frame_id=frame.id, class_id=s.classes[0].id, kind="bbox",
        geometry={"kind": "bbox", "x": x, "y": 0, "w": 10, "h": 10},
        confidence=confidence, visible=visible, status=status,
    )
    db.add(a)
    return a


def test_detect_keeps_the_scores_on_each_box(db_session, provider) -> None:
    s = seed(db_session)
    provider.script = [ok(answer((49, 49, 147, 98), confidence=0.8, visible=65))]
    body = _client(db_session, s).post(
        f"/assets/{s.assets[0].id}/logo-ai/detect", json=s.params()
    ).json()
    assert (body["annotations"][0]["confidence"], body["annotations"][0]["visible"]) == (0.8, 65)
    row = db_session.execute(select(Annotation)).scalars().one()
    assert (row.confidence, row.visible) == (0.8, 65)


def test_filter_previews_then_removes_only_what_is_under_the_thresholds(
    db_session, provider
) -> None:
    s = seed(db_session)
    f0, f1, _ = s.frames
    keep = _scored(db_session, s, f0, 0, 0.9, 100)
    edge = _scored(db_session, s, f0, 20, 0.8, 60)          # exactly on both lines
    unsure = _scored(db_session, s, f0, 40, 0.7, 100)       # under confidence
    hidden = _scored(db_session, s, f1, 60, 0.9, 40)        # under visibility
    accepted = _scored(db_session, s, f1, 80, 0.5, 20, status="accepted")
    drawn = _scored(db_session, s, f1, 100, None, None)     # a person's box
    db_session.commit()
    ids = {k: v.id for k, v in locals().items() if isinstance(v, Annotation)}
    client = _client(db_session, s)
    body = {"min_confidence": 0.8, "min_visible": 60}

    preview = client.post(f"/tasks/{s.task.id}/logo-ai/filter/preview", json=body).json()
    # The accepted and the hand-drawn box are not candidates at all.
    assert preview == {"scored": 4, "below": 2, "assets": 2, "applied": False}
    assert db_session.execute(select(Annotation)).scalars().all().__len__() == 6

    # Limited to one image, only that image's box goes.
    one = client.post(
        f"/tasks/{s.task.id}/logo-ai/filter/apply",
        json={**body, "asset_ids": [str(s.assets[1].id)]},
    ).json()
    assert one == {"scored": 1, "below": 1, "assets": 1, "applied": True}
    left = {a.id for a in db_session.execute(select(Annotation)).scalars()}
    assert left == set(ids.values()) - {ids["hidden"]}

    rest = client.post(f"/tasks/{s.task.id}/logo-ai/filter/apply", json=body).json()
    assert (rest["below"], rest["applied"]) == (1, True)
    left = {a.id for a in db_session.execute(select(Annotation)).scalars()}
    assert left == {ids["keep"], ids["edge"], ids["accepted"], ids["drawn"]}

    # Nothing left under the line: applying again is a no-op.
    again = client.post(f"/tasks/{s.task.id}/logo-ai/filter/apply", json=body).json()
    assert (again["scored"], again["below"]) == (2, 0)


def test_editing_a_scored_box_takes_it_out_of_the_filter(db_session, provider) -> None:
    from carve_api.annotations.service import AnnotationService

    s = seed(db_session)
    moved = _scored(db_session, s, s.frames[0], 0, 0.4, 30)
    relabelled = _scored(db_session, s, s.frames[0], 20, 0.4, 30)
    restacked = _scored(db_session, s, s.frames[0], 40, 0.4, 30)
    db_session.commit()
    svc = AnnotationService(db_session)
    svc.update(
        task=s.task, annotation_id=moved.id,
        geometry={"kind": "bbox", "x": 5, "y": 5, "w": 10, "h": 10},
    )
    svc.update(task=s.task, annotation_id=relabelled.id, class_id=s.classes[1].id)
    svc.update(task=s.task, annotation_id=restacked.id, z_order=3)
    db_session.commit()
    # Reshaping or relabelling makes it the person's box; reordering does not.
    assert (moved.confidence, relabelled.confidence, restacked.confidence) == (None, None, 0.4)

    out = _client(db_session, s).post(
        f"/tasks/{s.task.id}/logo-ai/filter/apply", json={"min_confidence": 0.9}
    ).json()
    assert (out["scored"], out["below"]) == (1, 1)
    left = {a.id for a in db_session.execute(select(Annotation)).scalars()}
    assert left == {moved.id, relabelled.id}


def test_filter_is_behind_the_logo_ai_gate(db_session, provider) -> None:
    s = _member(db_session, task_grant=True)
    _scored(db_session, s, s.frames[0], 0, 0.1, 10)
    db_session.commit()
    r = _client(db_session, s).post(
        f"/tasks/{s.task.id}/logo-ai/filter/apply", json={"min_confidence": 0.9}
    )
    assert r.status_code == 403
    assert db_session.execute(select(Annotation)).scalars().one() is not None



# --- deleting what a run stands on -------------------------------------------


def test_a_task_with_a_run_in_progress_cannot_be_deleted(db_session, provider, queue, redis) -> None:
    s = seed(db_session)
    client = _client(db_session, s)
    job = s.job(db_session, delivery="batch")
    jobs_mod.run_logo_ai_batch_submit(str(job.id))  # batches are with the provider
    db_session.expire_all()
    task_url = f"/projects/{s.project.id}/tasks/{s.task.id}"

    # Deleting the task would delete the run's rows, and the batches
    # would go on being billed with nothing left that knows about them.
    for url in (task_url, f"/projects/{s.project.id}"):
        r = client.delete(url)
        assert r.status_code == 409, r.text
        assert r.json()["error"] == "logo_ai_job_active"
        assert "Cancel it first" in r.json()["message"]
    assert db_session.get(LogoAiJob, job.id) is not None

    # Once the run has ended (here: canceled), deleting works as before.
    cancel = f"/tasks/{s.task.id}/logo-ai/jobs/{job.id}/cancel"
    client.post(cancel)
    assert client.post(cancel, params={"force": True}).json()["status"] == STATUS_CANCELED
    assert client.delete(task_url).status_code == 204


def test_batch_is_refused_for_a_model_the_batch_api_does_not_take(db_session, provider, queue, redis) -> None:
    s = seed(db_session)
    client = _client(db_session, s)
    body = s.params(provider="openai", model="gpt-6.1-sol", delivery="batch")
    r = client.post(f"/tasks/{s.task.id}/logo-ai/jobs", json=body)
    assert r.status_code == 422, r.text
    assert "batch API" in r.json()["message"] and "GPT-6.1 Sol" in r.json()["message"]
    assert db_session.execute(select(LogoAiJob)).first() is None
    # The same model is fine in realtime, and the previous Sol in batch.
    assert client.post(f"/tasks/{s.task.id}/logo-ai/jobs", json={**body, "delivery": "realtime"}).status_code == 201
    cfg = client.get("/inference/logo-ai/config", params={"task_id": str(s.task.id)}).json()
    openai = next(p for p in cfg["providers"] if p["id"] == "openai")
    by_id = {m["id"]: m["supports_batch"] for m in openai["models"]}
    assert by_id["gpt-6.1-sol"] is False and by_id["gpt-6-sol"] is True
