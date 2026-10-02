# Armin Mehri — mehri.armin@gmail.com
"""The RQ callables, run inline against the test DB with a scripted
provider: realtime runs, batch submission, polling and ingestion."""

import json
from datetime import UTC, datetime, timedelta
from io import BytesIO

import pytest
from PIL import Image
from sqlalchemy import select

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.logo_ai import jobs as jobs_mod
from carve_api.logo_ai.models import (
    DELIVERY_BATCH,
    PART_FAILED,
    PART_INGESTED,
    PART_PENDING,
    PART_SUBMITTED,
    STATUS_CANCELED,
    STATUS_CANCELING,
    STATUS_COMPLETED,
    STATUS_COMPLETED_WITH_ERRORS,
    STATUS_FAILED,
    STATUS_INGESTING,
    STATUS_RUNNING,
    STATUS_SUBMITTED,
    TERMINAL_STATUSES,
    LogoAiBatchPart,
    LogoAiJob,
)
from carve_api.logo_ai.providers.base import BatchGone, ProviderFatal, ProviderResult, Usage

from .conftest import IMAGE_W, answer, ok, seed


def _annotations(db, task_id) -> list[Annotation]:
    return list(
        db.execute(select(Annotation).where(Annotation.task_id == task_id)).scalars()
    )


def _reload(db, job) -> LogoAiJob:
    db.expire_all()
    return db.get(LogoAiJob, job.id)


# --- realtime ---------------------------------------------------------------


def test_realtime_annotates_every_asset_in_original_pixels(db_session, provider, queue) -> None:
    s = seed(db_session)
    job = s.job(db_session)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED
    assert (job.total_assets, job.done_assets, job.failed_assets, job.cursor) == (3, 3, 0, 3)
    assert job.annotations_created == 3
    assert job.usage == {
        "input_tokens": 3000, "cache_read_tokens": 1500,
        "cache_write_tokens": 0, "output_tokens": 300,
        "reasoning_tokens": 0, "requests": 3,
    }
    assert job.cost_usd > 0 and job.completed_at is not None

    anns = _annotations(db_session, s.task.id)
    assert len(anns) == 3
    assert {a.frame_id for a in anns} == {f.id for f in s.frames}
    a = anns[0]
    assert a.kind == AnnotationKind.bbox and a.class_id == s.classes[0].id
    assert a.created_by == s.user.id and a.status == "proposed"
    # Sent at 392x196; the model's (49, 49)-(147, 98) scales back by
    # 400/392 on x and 200/196 on y.
    scale = IMAGE_W / 392
    assert a.geometry == {
        "kind": "bbox", "x": 50.0, "y": 50.0,
        "w": round(98 * scale, 1), "h": 50.0,
    }
    # The image went out at whole 28px patches, with its size stated.
    assert provider.sent[0]["size"] == (392, 196)
    assert "392x196" in provider.sent[0]["text"]
    assert queue == []


def test_realtime_filters_by_confidence_and_skips_annotated(db_session, provider, queue) -> None:
    s = seed(db_session)
    db_session.add(
        Annotation(
            task_id=s.task.id, frame_id=s.frames[0].id, class_id=s.classes[0].id,
            kind=AnnotationKind.bbox, geometry={"kind": "bbox", "x": 0, "y": 0, "w": 5, "h": 5},
        )
    )
    db_session.commit()
    provider.script = [
        ok(answer((10, 10, 60, 60), confidence=0.2)),   # under the threshold
        ok(answer((10, 10, 60, 60), confidence=0.95)),
    ]
    job = s.job(db_session, skip_annotated=True, min_confidence=0.5)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED
    assert (job.done_assets, job.skipped_assets, job.annotations_created) == (3, 1, 1)
    # The already-annotated asset was neither sent nor billed.
    assert len(provider.sent) == 2


def test_mostly_hidden_logos_are_left_out(db_session, provider, queue) -> None:
    s = seed(db_session, n_assets=1)
    rows = {
        "detections": [
            [10, 10, 60, 60, 95, 100],    # whole
            [70, 10, 120, 60, 95, 65],    # partly hidden, over the line
            [130, 10, 180, 60, 95, 40],   # mostly hidden
        ]
    }
    provider.script = [ok(json.dumps(rows))]
    job = s.job(db_session, min_visible=50)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    assert _reload(db_session, job).annotations_created == 2
    xs = sorted(a.geometry["x"] for a in _annotations(db_session, s.task.id))
    assert len(xs) == 2 and xs[1] < 130


def test_realtime_overwrite_replaces_only_when_something_was_found(db_session, provider, queue) -> None:
    s = seed(db_session, n_assets=2)
    for frame in s.frames:
        db_session.add(
            Annotation(
                task_id=s.task.id, frame_id=frame.id, class_id=s.classes[1].id,
                kind=AnnotationKind.bbox, geometry={"kind": "bbox", "x": 0, "y": 0, "w": 5, "h": 5},
            )
        )
    db_session.commit()
    provider.script = [ok(), ok(answer())]  # second image: no logos
    job = s.job(db_session, overwrite=True)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    by_frame = {}
    for a in _annotations(db_session, s.task.id):
        by_frame.setdefault(a.frame_id, []).append(a.class_id)
    assert by_frame[s.frames[0].id] == [s.classes[0].id]   # replaced
    assert by_frame[s.frames[1].id] == [s.classes[1].id]   # left alone


def test_realtime_resumes_in_chunks_without_repeating_assets(db_session, provider, queue, monkeypatch) -> None:
    monkeypatch.setattr(jobs_mod, "REALTIME_CHUNK_ASSETS", 2)
    s = seed(db_session)
    job = s.job(db_session)

    jobs_mod.run_logo_ai_realtime(str(job.id))
    job = _reload(db_session, job)
    assert (job.status, job.cursor, job.done_assets) == (STATUS_RUNNING, 2, 2)
    assert queue == [("run_logo_ai_realtime", "-c2")]

    jobs_mod.run_logo_ai_realtime(str(job.id))
    job = _reload(db_session, job)
    assert (job.status, job.cursor, job.done_assets) == (STATUS_COMPLETED, 3, 3)
    assert len(provider.sent) == 3
    assert len(_annotations(db_session, s.task.id)) == 3


def test_realtime_rejected_request_fails_the_run_before_fanning_out(db_session, provider, queue) -> None:
    s = seed(db_session)
    provider.script = [ProviderResult(error="bad_request: output_config.format: bad schema")]
    job = s.job(db_session)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_FAILED
    assert "bad schema" in job.error
    # One probe, not one failure per asset.
    assert len(provider.sent) == 1
    assert _annotations(db_session, s.task.id) == []


def test_realtime_bad_key_fails_the_run(db_session, provider, queue) -> None:
    s = seed(db_session)
    provider.script = [ProviderFatal("Anthropic rejected the API key")]
    job = s.job(db_session)
    jobs_mod.run_logo_ai_realtime(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_FAILED and "API key" in job.error


def test_realtime_one_bad_asset_does_not_end_the_run(db_session, provider, queue) -> None:
    s = seed(db_session)
    provider.script = [ok(), ProviderResult(error="refusal"), ok("not json")]
    job = s.job(db_session)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED_WITH_ERRORS
    assert (job.done_assets, job.failed_assets, job.annotations_created) == (3, 2, 1)
    assert sorted(e.split(": ", 1)[1] for e in job.errors) == [
        "bad_output: answer is not valid JSON", "refusal",
    ]


def test_realtime_stops_when_its_requests_keep_failing(db_session, provider, queue, monkeypatch) -> None:
    monkeypatch.setattr(jobs_mod, "MAX_CONSECUTIVE_FAILURES", 3)
    s = seed(db_session, n_assets=8)
    # Answered, and refused every time: going on would only cost more.
    provider.script = [ok(), *[ProviderResult(error="refusal")] * 7]
    job = s.job(db_session)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_FAILED
    assert "consecutive failures" in job.error
    assert len(provider.sent) == 5


def test_realtime_waits_out_an_outage_and_loses_nothing(db_session, provider, queue) -> None:
    s = seed(db_session, n_assets=6)
    # The first image gets through, then the network goes.
    provider.script = [ok(), *[ProviderResult(error="provider_unreachable")] * 4]
    job = s.job(db_session)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    job = _reload(db_session, job)
    # One image is done. The rest are not failed: the run is waiting,
    # with its cursor on the first image that did not get through.
    assert job.status == STATUS_RUNNING
    assert (job.cursor, job.done_assets, job.failed_assets) == (1, 1, 0)
    assert "cannot be reached" in job.notice and job.resume_after > datetime.now(UTC)
    assert job.errors == [] and queue == []

    # The supervisor starts it again once the provider is back.
    jobs_mod.run_logo_ai_realtime(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED
    assert (job.done_assets, job.failed_assets, job.annotations_created) == (6, 0, 6)
    assert job.notice is None and job.resume_after is None
    assert len(_annotations(db_session, s.task.id)) == 6


def test_realtime_waits_grow_longer(db_session, provider, queue) -> None:
    s = seed(db_session)
    job = s.job(db_session)
    waits = []
    for _ in range(8):
        provider.script = [ProviderResult(error="rate_limited")]
        jobs_mod.run_logo_ai_realtime(str(job.id))
        job = _reload(db_session, job)
        waits.append(round((job.resume_after - datetime.now(UTC)).total_seconds() / 30))
    assert waits == [1, 2, 4, 8, 16, 30, 30, 30]  # half minutes
    assert "out of credit" in job.notice and job.failed_assets == 0


def test_realtime_retries_a_request_that_failed_while_others_got_through(
    db_session, provider, queue, monkeypatch
) -> None:
    monkeypatch.setattr(jobs_mod.time, "sleep", lambda _s: None)
    s = seed(db_session)
    # Image 0 warms the cache; of the next two, one hits a server error.
    provider.script = [ok(), ProviderResult(error="provider_error_503"), ok()]
    job = s.job(db_session)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED
    assert (job.failed_assets, job.annotations_created) == (0, 3)
    assert len(provider.sent) == 4


def test_one_image_that_cannot_be_saved_fails_alone(db_session, provider, queue, monkeypatch) -> None:
    s = seed(db_session)
    real = jobs_mod.persist_detections
    bad = s.frames[1].id

    def persist(session, **kw):
        if kw["frame_id"] == bad:
            real(session, **kw)  # written, then the savepoint is undone
            raise RuntimeError("boom")
        return real(session, **kw)

    monkeypatch.setattr(jobs_mod, "persist_detections", persist)
    job = s.job(db_session)
    jobs_mod.run_logo_ai_realtime(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED_WITH_ERRORS
    assert (job.done_assets, job.failed_assets, job.annotations_created) == (3, 1, 2)
    assert "img-1.jpg: could not be saved (RuntimeError)" in job.errors
    assert {a.frame_id for a in _annotations(db_session, s.task.id)} == {
        s.frames[0].id, s.frames[2].id,
    }


def test_a_run_cannot_be_executed_twice_at_once(db_session, provider, queue) -> None:
    s = seed(db_session)
    job = s.job(db_session)
    with jobs_mod._exclusive(db_session, job.id) as mine:
        assert mine
        # A restart that arrives while the run is still working.
        assert jobs_mod.run_logo_ai_realtime(str(job.id)) == {"ok": True, "skipped": "busy"}
        batch = s.job(db_session, delivery=DELIVERY_BATCH)
    assert provider.sent == []
    with jobs_mod._exclusive(db_session, batch.id):
        assert jobs_mod.run_logo_ai_batch_submit(str(batch.id))["skipped"] == "busy"
    # Released with the execution: the next one gets in.
    jobs_mod.run_logo_ai_realtime(str(job.id))
    assert _reload(db_session, job).status == STATUS_COMPLETED


def test_realtime_honours_cancel(db_session, provider, queue) -> None:
    s = seed(db_session)
    job = s.job(db_session)
    job.status = STATUS_CANCELING
    db_session.commit()

    jobs_mod.run_logo_ai_realtime(str(job.id))

    assert _reload(db_session, job).status == STATUS_CANCELED
    assert provider.sent == []


def test_tiling_sends_the_full_frame_plus_tiles(db_session, provider, queue, monkeypatch) -> None:
    s = seed(db_session, n_assets=1)
    # Far larger than one view can show at "low" detail on Haiku's tier,
    # so tiles are worth sending.
    big = BytesIO()
    Image.new("RGB", (3000, 2000)).save(big, format="JPEG")
    monkeypatch.setattr(jobs_mod, "read_image_bytes", lambda _a, _f: big.getvalue())
    job = s.job(db_session, model="claude-haiku-4-5", detail="low", tiling="auto")

    jobs_mod.run_logo_ai_realtime(str(job.id))

    assert len(provider.sent) == 5  # full frame + 2x2
    assert sum("cropped region" in r["text"] for r in provider.sent) == 4
    job = _reload(db_session, job)
    # Every view reported the same box in its own coordinates; mapped
    # back, those are five different places on the original.
    assert job.status == STATUS_COMPLETED and job.annotations_created == 5


# --- batch: submit ----------------------------------------------------------


def test_batch_submit_preflights_then_submits_the_rest(db_session, provider, queue) -> None:
    s = seed(db_session)
    job = s.job(db_session, delivery=DELIVERY_BATCH)

    jobs_mod.run_logo_ai_batch_submit(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_SUBMITTED
    assert job.submitted_at is not None and job.expires_at is not None
    # Asset 0 ran synchronously with the batch's own request shape...
    assert len(provider.sent) == 1 and provider.sent[0]["batch"] is True
    assert (job.done_assets, job.annotations_created) == (1, 1)
    # ...and only the other two went to the provider's batch API.
    assert job.total_requests == 2 and job.cursor == 3
    (part,) = db_session.execute(select(LogoAiBatchPart)).scalars()
    assert part.provider_batch_id == "batch-1" and part.request_count == 2
    assert [a["name"] for a in part.meta["assets"]] == ["img-1.jpg", "img-2.jpg"]
    assert [cid for cid, _ in provider.batches["batch-1"]] == ["0_0", "1_0"]
    assert queue == [("poll", "")]


def test_batch_preflight_failure_submits_nothing(db_session, provider, queue) -> None:
    s = seed(db_session)
    provider.script = [ProviderResult(error="bad_request: image too large")]
    job = s.job(db_session, delivery=DELIVERY_BATCH)

    jobs_mod.run_logo_ai_batch_submit(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_FAILED and "image too large" in job.error
    assert provider.batches == {} and queue == []


def test_batch_submit_splits_into_parts_and_resumes(db_session, provider, queue, monkeypatch) -> None:
    monkeypatch.setattr(jobs_mod, "_PREP_SLICE", 2)
    monkeypatch.setattr(jobs_mod, "PART_MAX_REQUESTS", 2)
    monkeypatch.setattr(jobs_mod, "SUBMIT_PARTS_PER_RUN", 1)
    s = seed(db_session, n_assets=5)
    job = s.job(db_session, delivery=DELIVERY_BATCH)

    jobs_mod.run_logo_ai_batch_submit(str(job.id))
    job = _reload(db_session, job)
    # The preflight image goes alone, the next slice fills a part, and
    # the execution yields after one part.
    assert job.status == "preparing" and job.cursor == 3
    assert queue == [("run_logo_ai_batch_submit", "-s3")]

    jobs_mod.run_logo_ai_batch_submit(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_SUBMITTED and job.cursor == 5
    parts = list(
        db_session.execute(select(LogoAiBatchPart).order_by(LogoAiBatchPart.seq)).scalars()
    )
    assert [p.request_count for p in parts] == [2, 2]
    assert job.total_requests == 4
    # Preflight ran once, not once per execution.
    assert len(provider.sent) == 1


def test_submit_rides_out_a_blip(db_session, provider, queue, monkeypatch) -> None:
    monkeypatch.setattr(jobs_mod.time, "sleep", lambda _s: None)
    s = seed(db_session)
    job = s.job(db_session, delivery=DELIVERY_BATCH)
    create = provider.batch_create
    attempts: list[str] = []

    def flaky(requests, *, tag):
        attempts.append(tag)
        if len(attempts) == 1:
            raise RuntimeError("connection reset")
        return create(requests, tag=tag)

    monkeypatch.setattr(provider, "batch_create", flaky)
    jobs_mod.run_logo_ai_batch_submit(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_SUBMITTED and job.total_requests == 2
    assert len(attempts) == 2 and len(provider.batches) == 1


def test_a_rejected_first_batch_fails_the_run_and_keeps_the_preflight_cost(
    db_session, provider, queue, monkeypatch
) -> None:
    s = seed(db_session)
    job = s.job(db_session, delivery=DELIVERY_BATCH)

    def rejected(_requests, *, tag):
        raise ProviderFatal("OpenAI rejected the batch: billing hard limit reached")

    monkeypatch.setattr(provider, "batch_create", rejected)
    jobs_mod.run_logo_ai_batch_submit(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_FAILED and "billing hard limit" in job.error
    # The preflight request ran and was billed; the books must show it,
    # and its box is kept.
    assert job.cost_usd > 0 and job.usage["requests"] == 1
    assert job.annotations_created == 1 and job.failed_assets == 2
    (part,) = db_session.execute(select(LogoAiBatchPart)).scalars()
    assert part.status == PART_FAILED and part.provider_batch_id is None


def _small_parts(monkeypatch) -> None:
    """One image per part, as many parts per execution as it takes."""
    monkeypatch.setattr(jobs_mod.time, "sleep", lambda _s: None)
    monkeypatch.setattr(jobs_mod, "_PREP_SLICE", 1)
    monkeypatch.setattr(jobs_mod, "PART_MAX_REQUESTS", 1)
    monkeypatch.setattr(jobs_mod, "SUBMIT_PARTS_PER_RUN", 10)


def _parts(db_session) -> list[LogoAiBatchPart]:
    db_session.expire_all()
    return list(
        db_session.execute(select(LogoAiBatchPart).order_by(LogoAiBatchPart.seq)).scalars()
    )


def test_an_outage_while_submitting_is_waited_out(db_session, provider, queue, monkeypatch) -> None:
    _small_parts(monkeypatch)
    s = seed(db_session, n_assets=5)
    job = s.job(db_session, delivery=DELIVERY_BATCH)
    create = provider.batch_create
    online = {"up": True}

    def maybe(requests, *, tag):
        if not online["up"] or len(provider.batches) >= 2:
            online["up"] = False
            raise RuntimeError("network is unreachable")
        return create(requests, tag=tag)

    monkeypatch.setattr(provider, "batch_create", maybe)
    jobs_mod.run_logo_ai_batch_submit(str(job.id))

    job = _reload(db_session, job)
    # Two parts are with the provider; the third is written down and
    # waiting. Nothing has failed and nothing is forgotten.
    assert job.status == "preparing" and job.failed_assets == 0
    assert "cannot be reached" in job.notice and job.resume_after is not None
    assert [p.status for p in _parts(db_session)] == [PART_SUBMITTED, PART_SUBMITTED, PART_PENDING]
    assert job.cursor == 4 and job.total_requests == 2

    # The network is back; the supervisor starts the run again.
    monkeypatch.setattr(provider, "batch_create", create)
    jobs_mod.run_logo_ai_batch_submit(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_SUBMITTED and job.notice is None
    assert job.total_requests == 4 and len(provider.batches) == 4
    # Each image went to the provider exactly once.
    sent = [a["name"] for p in _parts(db_session) for a in p.meta["assets"]]
    assert sent == ["img-1.jpg", "img-2.jpg", "img-3.jpg", "img-4.jpg"]

    for batch_id in provider.batches:
        provider.batch_ended[batch_id] = True
    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED
    assert (job.done_assets, job.failed_assets, job.annotations_created) == (5, 0, 5)


def test_a_refusal_after_the_first_parts_still_collects_what_was_sent(
    db_session, provider, queue, monkeypatch
) -> None:
    _small_parts(monkeypatch)
    s = seed(db_session, n_assets=5)
    job = s.job(db_session, delivery=DELIVERY_BATCH)
    create = provider.batch_create

    def refuses_after_two(requests, *, tag):
        if len(provider.batches) >= 2:
            raise ProviderFatal("OpenAI rejected the batch: billing hard limit reached")
        return create(requests, tag=tag)

    monkeypatch.setattr(provider, "batch_create", refuses_after_two)
    jobs_mod.run_logo_ai_batch_submit(str(job.id))

    job = _reload(db_session, job)
    # Two parts are with the provider and paid for: the run waits for
    # them instead of failing or hanging in "preparing".
    assert job.status == STATUS_SUBMITTED and job.total_requests == 2
    assert (job.cursor, job.done_assets, job.failed_assets) == (5, 3, 2)
    assert any("1 image not submitted" in e for e in job.errors)
    assert queue[-1] == ("poll", "")

    for batch_id in provider.batches:
        provider.batch_ended[batch_id] = True
    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED_WITH_ERRORS
    assert (job.done_assets, job.failed_assets, job.annotations_created) == (5, 2, 3)


def test_a_part_the_provider_took_before_the_crash_is_not_sent_twice(
    db_session, provider, queue, monkeypatch
) -> None:
    s = seed(db_session)
    job = s.job(db_session, delivery=DELIVERY_BATCH)
    real = jobs_mod._mark_sent

    def power_cut(*a, **kw):
        raise KeyboardInterrupt  # the process is gone before it can write

    monkeypatch.setattr(jobs_mod, "_mark_sent", power_cut)
    with pytest.raises(KeyboardInterrupt):
        jobs_mod.run_logo_ai_batch_submit(str(job.id))
    db_session.rollback()

    # The provider has the batch; we only know a part was about to go.
    assert len(provider.batches) == 1
    (part,) = _parts(db_session)
    assert part.status == PART_PENDING and part.provider_batch_id is None

    monkeypatch.setattr(jobs_mod, "_mark_sent", real)
    jobs_mod.run_logo_ai_batch_submit(str(job.id))

    job = _reload(db_session, job)
    (part,) = _parts(db_session)
    # Found by its tag and adopted: no second batch, no second bill.
    assert len(provider.batches) == 1
    assert part.status == PART_SUBMITTED and part.provider_batch_id == "batch-1"
    assert part.meta["adopted"] is True and job.total_requests == 2
    assert job.status == STATUS_SUBMITTED

    provider.batch_ended["batch-1"] = True
    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED and job.annotations_created == 3


def test_a_batch_accepted_without_the_answer_arriving_is_found(
    db_session, provider, queue, monkeypatch
) -> None:
    monkeypatch.setattr(jobs_mod.time, "sleep", lambda _s: None)
    s = seed(db_session)
    job = s.job(db_session, delivery=DELIVERY_BATCH)
    create = provider.batch_create

    def times_out(requests, *, tag):
        create(requests, tag=tag)  # the provider took it
        raise TimeoutError("read timed out")  # ... and we never heard

    monkeypatch.setattr(provider, "batch_create", times_out)
    jobs_mod.run_logo_ai_batch_submit(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_SUBMITTED and len(provider.batches) == 1
    assert _parts(db_session)[0].provider_batch_id == "batch-1"


def test_an_upload_that_got_through_is_not_repeated(db_session, provider, queue, monkeypatch) -> None:
    monkeypatch.setattr(jobs_mod.time, "sleep", lambda _s: None)
    provider.uses_files = True
    provider.findable = False  # as if the batch itself was never made
    s = seed(db_session)
    job = s.job(db_session, delivery=DELIVERY_BATCH)
    create = provider.batch_create
    calls: list[str] = []

    def upload_then_fail(requests, *, tag):
        calls.append(tag)
        provider.files["file-1"] = list(requests)
        error = RuntimeError("connection reset while creating the batch")
        error.uploaded_file_id = "file-1"
        raise error

    monkeypatch.setattr(provider, "batch_create", upload_then_fail)
    jobs_mod.run_logo_ai_batch_submit(str(job.id))

    # The second attempt started the batch from the file already there.
    job = _reload(db_session, job)
    (part,) = _parts(db_session)
    assert job.status == STATUS_SUBMITTED and len(calls) == 1
    assert provider.from_file == ["file-1"] and part.provider_file_id == "file-1"
    assert create is not None


def test_a_part_is_not_sent_again_while_the_provider_cannot_be_asked(
    db_session, provider, queue, monkeypatch
) -> None:
    monkeypatch.setattr(jobs_mod.time, "sleep", lambda _s: None)
    s = seed(db_session)
    job = s.job(db_session, delivery=DELIVERY_BATCH)
    create = provider.batch_create
    calls: list[str] = []

    def times_out(requests, *, tag):
        calls.append(tag)
        create(requests, tag=tag)
        raise TimeoutError("read timed out")

    def cannot_list(*a, **kw):
        raise RuntimeError("network is unreachable")

    monkeypatch.setattr(provider, "batch_create", times_out)
    monkeypatch.setattr(provider, "batch_find", cannot_list)
    jobs_mod.run_logo_ai_batch_submit(str(job.id))

    # Whether the batch exists is unknown, so it is not made a second
    # time: the run waits until it can ask.
    job = _reload(db_session, job)
    assert len(calls) == 1 and job.status == "preparing" and job.notice
    assert _parts(db_session)[0].status == PART_PENDING


# --- batch: poll + ingest ---------------------------------------------------


def _submitted(db_session, provider, n_assets: int = 3, **overrides):
    s = seed(db_session, n_assets=n_assets)
    job = s.job(db_session, delivery=DELIVERY_BATCH, **overrides)
    jobs_mod.run_logo_ai_batch_submit(str(job.id))
    return s, _reload(db_session, job)


def test_poll_waits_then_ingests_exactly_once(db_session, provider, queue) -> None:
    s, job = _submitted(db_session, provider)

    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_SUBMITTED and job.finished_requests == 0
    assert job.last_polled_at is not None
    assert len(_annotations(db_session, s.task.id)) == 1  # the preflight asset

    provider.batch_ended["batch-1"] = True
    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED
    assert (job.done_assets, job.annotations_created, job.finished_requests) == (3, 3, 2)
    assert len(_annotations(db_session, s.task.id)) == 3
    (part,) = db_session.execute(select(LogoAiBatchPart)).scalars()
    assert part.status == PART_INGESTED and provider.cleaned == ["batch-1"]

    # A late or duplicate poll must not write the boxes again.
    jobs_mod.poll_logo_ai_batch(str(job.id))
    assert len(_annotations(db_session, s.task.id)) == 3


def test_batch_results_are_billed_at_the_batch_rate(db_session, provider, queue) -> None:
    _, job = _submitted(db_session, provider, n_assets=2)
    preflight_cost = job.cost_usd
    provider.batch_ended["batch-1"] = True
    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    # Same tokens as the preflight request, at half the price.
    assert job.cost_usd - preflight_cost == pytest.approx(preflight_cost / 2)


def test_poll_records_per_asset_failures(db_session, provider, queue) -> None:
    s, job = _submitted(db_session, provider)
    provider.batch_answers["batch-1:1_0"] = ProviderResult(error="expired")
    provider.batch_ended["batch-1"] = True

    jobs_mod.poll_logo_ai_batch(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED_WITH_ERRORS
    assert (job.done_assets, job.failed_assets, job.annotations_created) == (3, 1, 2)
    assert job.errors == ["img-2.jpg: expired"]


def test_poll_survives_an_asset_deleted_while_the_batch_ran(db_session, provider, queue) -> None:
    s, job = _submitted(db_session, provider)
    db_session.delete(db_session.get(type(s.assets[2]), s.assets[2].id))
    db_session.commit()
    provider.batch_ended["batch-1"] = True

    jobs_mod.poll_logo_ai_batch(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED_WITH_ERRORS
    assert job.errors == ["img-2.jpg: asset_deleted"]
    assert job.annotations_created == 2


def test_poll_fails_the_job_when_the_provider_rejects_the_batch(db_session, provider, queue) -> None:
    s, job = _submitted(db_session, provider)
    provider.script = []
    provider.batch_failed_reason = "Enqueued token limit reached"

    jobs_mod.poll_logo_ai_batch(str(job.id))

    job = _reload(db_session, job)
    # The preflight asset succeeded, so the run is not a total loss.
    assert job.status == STATUS_COMPLETED_WITH_ERRORS
    assert job.failed_assets == 2
    assert "Enqueued token limit reached" in job.errors[-1]


def _age_part(db_session, **delta) -> None:
    """Pretend the job's part was handed over that long ago."""
    (part,) = _parts(db_session)
    part.meta = {**part.meta, "sent_at": (datetime.now(UTC) - timedelta(**delta)).isoformat()}
    db_session.commit()


def test_unreachable_batch_is_kept_for_as_long_as_the_provider_keeps_it(
    db_session, provider, queue, monkeypatch
) -> None:
    s, job = _submitted(db_session, provider)
    answering = provider.batch_state

    def down(_batch_id):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(provider, "batch_state", down)

    # A failed status check is a blip: keep trying.
    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_SUBMITTED and job.failed_assets == 0

    # The machine was off for days. The batch expired long ago, but the
    # provider still holds what it produced, so one more failed check
    # must not throw that away.
    _age_part(db_session, days=5)
    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_SUBMITTED and job.failed_assets == 0

    # ... and is collected as soon as the provider answers again.
    monkeypatch.setattr(provider, "batch_state", answering)
    provider.batch_ended["batch-1"] = True
    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED and job.annotations_created == 3


def test_unreachable_batch_is_written_off_once_the_provider_has_dropped_it(
    db_session, provider, queue, monkeypatch
) -> None:
    s, job = _submitted(db_session, provider)

    def down(_batch_id):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(provider, "batch_state", down)
    _age_part(db_session, days=29)

    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED_WITH_ERRORS
    assert job.failed_assets == 2 and "could not be read" in job.errors[-1]


def test_a_batch_the_provider_denies_having_is_given_a_day(
    db_session, provider, queue, monkeypatch
) -> None:
    s, job = _submitted(db_session, provider)
    answering = provider.batch_state

    def gone(_batch_id):
        raise BatchGone("No batch found with id 'batch-1'")

    # The API key was swapped for another account's: every batch is
    # "not found". That must not cost the run its results.
    monkeypatch.setattr(provider, "batch_state", gone)
    jobs_mod.poll_logo_ai_batch(str(job.id))
    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_SUBMITTED and job.failed_assets == 0
    assert sum("has no such batch" in e for e in job.errors) == 1
    assert "API key" in job.errors[-1]

    # The right key is put back: the batch is there after all.
    monkeypatch.setattr(provider, "batch_state", answering)
    provider.batch_ended["batch-1"] = True
    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED and job.annotations_created == 3


def test_a_batch_that_stays_gone_for_a_day_is_written_off(
    db_session, provider, queue, monkeypatch
) -> None:
    s, job = _submitted(db_session, provider)

    def gone(_batch_id):
        raise BatchGone("No batch found with id 'batch-1'")

    monkeypatch.setattr(provider, "batch_state", gone)
    jobs_mod.poll_logo_ai_batch(str(job.id))
    (part,) = _parts(db_session)
    a_day_ago = (datetime.now(UTC) - timedelta(hours=25)).isoformat()
    part.meta = {**part.meta, "gone_since": a_day_ago}
    db_session.commit()

    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED_WITH_ERRORS
    assert job.failed_assets == 2 and "has no such batch" in job.errors[-1]


def test_results_that_fail_to_read_are_retried_with_a_wait_and_never_doubled(
    db_session, provider, queue, monkeypatch
) -> None:
    s, job = _submitted(db_session, provider)
    provider.batch_ended["batch-1"] = True
    reads: list[str] = []
    good = provider.batch_download

    def broken(batch_id):
        reads.append(batch_id)
        raise RuntimeError("download interrupted")

    monkeypatch.setattr(provider, "batch_download", broken)

    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    (part,) = db_session.execute(select(LogoAiBatchPart)).scalars()
    db_session.refresh(part)
    # Nothing half-written, nothing given up, and the run says why it waits.
    assert part.status == PART_SUBMITTED and part.meta["read_failures"] == 1
    assert job.status not in TERMINAL_STATUSES and job.failed_assets == 0
    assert len(_annotations(db_session, s.task.id)) == 1  # the preflight asset
    assert "retrying (download interrupted)" in job.errors[-1]

    # The next poll comes seconds later: too soon to ask again.
    jobs_mod.poll_logo_ai_batch(str(job.id))
    assert len(reads) == 1
    assert _reload(db_session, job).status == STATUS_SUBMITTED

    # Once the wait is over the part is read, once.
    monkeypatch.setattr(provider, "batch_download", good)
    a_moment_ago = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
    part.meta = {**part.meta, "retry_after": a_moment_ago}
    db_session.commit()
    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED
    assert (job.annotations_created, job.failed_assets) == (3, 0)
    assert len(_annotations(db_session, s.task.id)) == 3


def test_read_retries_back_off_up_to_an_hour(db_session, provider, queue) -> None:
    s, job = _submitted(db_session, provider)
    (part,) = _parts(db_session)
    waits = []
    for _ in range(9):
        before = datetime.now(UTC)
        jobs_mod._read_failed(job, part, RuntimeError("x"))
        waits.append(datetime.fromisoformat(part.meta["retry_after"]) - before)
    minutes = [round(w.total_seconds() / 60) for w in waits]
    assert minutes == [1, 2, 4, 8, 16, 32, 60, 60, 60]
    # Reported once, not on every attempt.
    assert sum("could not be read yet" in e for e in job.errors) == 1


def test_results_the_provider_has_deleted_are_written_off_after_a_day(
    db_session, provider, queue, monkeypatch
) -> None:
    s, job = _submitted(db_session, provider)
    provider.batch_ended["batch-1"] = True

    def gone(_batch_id):
        raise BatchGone("No such File object: file-out")

    monkeypatch.setattr(provider, "batch_download", gone)

    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    (part,) = _parts(db_session)
    assert part.status == PART_SUBMITTED and job.failed_assets == 0
    assert "no longer has these results" in job.errors[-1]

    a_day_ago = (datetime.now(UTC) - timedelta(hours=25)).isoformat()
    part.meta = {**part.meta, "gone_since": a_day_ago}
    _due(db_session, part)
    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED_WITH_ERRORS
    assert job.failed_assets == 2 and "no longer has these results" in job.errors[-1]


def test_a_force_stopped_run_is_left_alone_by_a_late_poll(db_session, provider, queue) -> None:
    s, job = _submitted(db_session, provider)
    provider.batch_ended["batch-1"] = True
    job.status = STATUS_CANCELED
    db_session.commit()

    jobs_mod.poll_logo_ai_batch(str(job.id))

    assert _reload(db_session, job).status == STATUS_CANCELED
    assert len(_annotations(db_session, s.task.id)) == 1


def test_status_returns_to_waiting_while_other_parts_are_still_running(
    db_session, provider, queue, monkeypatch
) -> None:
    monkeypatch.setattr(jobs_mod, "_PREP_SLICE", 1)
    monkeypatch.setattr(jobs_mod, "PART_MAX_REQUESTS", 1)
    monkeypatch.setattr(jobs_mod, "SUBMIT_PARTS_PER_RUN", 10)
    s, job = _submitted(db_session, provider, n_assets=3)
    provider.batch_ended["batch-1"] = True

    jobs_mod.poll_logo_ai_batch(str(job.id))
    assert _reload(db_session, job).done_assets == 2
    # Nothing left to write until batch-2 ends: back to the slow schedule.
    jobs_mod.poll_logo_ai_batch(str(job.id))
    assert _reload(db_session, job).status == STATUS_SUBMITTED


def test_cancel_keeps_results_the_provider_already_produced(db_session, provider, queue) -> None:
    s, job = _submitted(db_session, provider)
    job.status = STATUS_CANCELING
    db_session.commit()

    jobs_mod.poll_logo_ai_batch(str(job.id))

    job = _reload(db_session, job)
    assert provider.canceled == ["batch-1"]
    assert job.status == STATUS_CANCELED
    # They were billed; they are kept.
    assert job.annotations_created == 3


def test_ingest_is_bounded_per_poll_and_continues(db_session, provider, queue, monkeypatch) -> None:
    monkeypatch.setattr(jobs_mod, "_PREP_SLICE", 1)
    monkeypatch.setattr(jobs_mod, "PART_MAX_REQUESTS", 1)
    monkeypatch.setattr(jobs_mod, "SUBMIT_PARTS_PER_RUN", 10)
    monkeypatch.setattr(jobs_mod, "INGEST_PARTS_PER_RUN", 2)
    s, job = _submitted(db_session, provider, n_assets=4)
    assert len(provider.batches) == 3
    for batch_id in provider.batches:
        provider.batch_ended[batch_id] = True
    queue.clear()

    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_INGESTING and job.done_assets == 3
    assert queue == [("poll", "")]  # asks to be run again right away

    jobs_mod.poll_logo_ai_batch(str(job.id))
    assert _reload(db_session, job).status == STATUS_COMPLETED
    assert len(_annotations(db_session, s.task.id)) == 4


# --- batch: nothing paid for is lost, nothing is paid for twice -------------


def _due(db_session, part: LogoAiBatchPart) -> None:
    """Let a part's wait be over."""
    a_moment_ago = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
    part.meta = {**part.meta, "retry_after": a_moment_ago}
    db_session.commit()


def test_results_are_copied_before_they_are_read(db_session, provider, queue, monkeypatch) -> None:
    s, job = _submitted(db_session, provider)
    provider.batch_ended["batch-1"] = True
    real = jobs_mod.interpret

    def bug(*a, **kw):
        raise RuntimeError("a bug on our side")

    # The results arrive, and then reading them fails here.
    monkeypatch.setattr(jobs_mod, "interpret", bug)
    jobs_mod.poll_logo_ai_batch(str(job.id))
    (part,) = _parts(db_session)
    assert part.status == PART_SUBMITTED and len(provider.archive) == 1

    # By the time that is fixed the provider has dropped them. It does
    # not matter: they are read from our own copy.
    def gone(_batch_id):
        raise BatchGone("expired")

    monkeypatch.setattr(jobs_mod, "interpret", real)
    monkeypatch.setattr(provider, "batch_download", gone)
    _due(db_session, part)
    jobs_mod.poll_logo_ai_batch(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED
    assert (job.annotations_created, job.failed_assets) == (3, 0)


def test_a_part_no_answer_of_which_can_be_read_is_kept_not_failed(
    db_session, provider, queue
) -> None:
    s, job = _submitted(db_session, provider, n_assets=7)
    for i in range(6):
        provider.batch_answers[f"batch-1:{i}_0"] = ProviderResult(error="empty_answer")
    provider.batch_ended["batch-1"] = True

    jobs_mod.poll_logo_ai_batch(str(job.id))

    # Six paid answers, none understood: that is this code, not the
    # images. The part stays open and its results stay on file.
    job = _reload(db_session, job)
    (part,) = _parts(db_session)
    assert part.status == PART_SUBMITTED and part.meta["read_failures"] == 1
    assert job.status not in TERMINAL_STATUSES and job.failed_assets == 0
    assert "none of the part's 6 answers could be read" in job.errors[-1]
    assert len(provider.archive) == 1


def test_requests_the_provider_never_ran_are_sent_again(db_session, provider, queue) -> None:
    s, job = _submitted(db_session, provider)
    # The 24 hours ran out with one of the two images still waiting.
    provider.batch_answers["batch-1:1_0"] = ProviderResult(error="batch_expired", retryable=True)
    provider.batch_ended["batch-1"] = True
    queue.clear()

    jobs_mod.poll_logo_ai_batch(str(job.id))

    job = _reload(db_session, job)
    first, again = _parts(db_session)
    assert first.status == PART_INGESTED and again.status == PART_PENDING
    assert [a["name"] for a in again.meta["assets"]] == ["img-2.jpg"]
    # The image is neither done nor failed: it is on its way again.
    assert job.status not in TERMINAL_STATUSES
    assert (job.done_assets, job.failed_assets) == (2, 0)
    assert ("resend", "") in queue

    jobs_mod.run_logo_ai_batch_submit(str(job.id))  # the resend
    job = _reload(db_session, job)
    assert _parts(db_session)[1].provider_batch_id == "batch-2"
    assert job.total_requests == 3
    assert [cid for cid, _ in provider.batches["batch-2"]] == ["0_0"]

    provider.batch_ended["batch-2"] = True
    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED
    assert (job.done_assets, job.failed_assets, job.annotations_created) == (3, 0, 3)


def test_a_request_is_not_sent_again_for_ever(db_session, provider, queue) -> None:
    s, job = _submitted(db_session, provider, n_assets=2)
    for n in (1, 2, 3):
        provider.batch_answers[f"batch-{n}:0_0"] = ProviderResult(
            error="batch_expired", retryable=True
        )
        provider.batch_ended[f"batch-{n}"] = True
        jobs_mod.poll_logo_ai_batch(str(job.id))
        jobs_mod.run_logo_ai_batch_submit(str(job.id))

    job = _reload(db_session, job)
    assert len(provider.batches) == 3
    assert job.status == STATUS_COMPLETED_WITH_ERRORS
    assert job.failed_assets == 1 and "batch_expired" in job.errors[-1]


def test_a_part_the_queue_had_no_room_for_waits_and_is_sent_again(
    db_session, provider, queue, monkeypatch
) -> None:
    _small_parts(monkeypatch)
    provider.uses_files = True
    s, job = _submitted(db_session, provider, n_assets=4)
    assert len(provider.batches) == 3
    # The account's batch queue takes one part; the other two bounce.
    provider.queue_full = {"batch-2": "Enqueued token limit reached", "batch-3": "same"}
    queue.clear()

    jobs_mod.poll_logo_ai_batch(str(job.id))

    job = _reload(db_session, job)
    assert [p.status for p in _parts(db_session)] == [PART_SUBMITTED, PART_PENDING, PART_PENDING]
    assert job.status == STATUS_SUBMITTED and job.failed_assets == 0
    assert "batch queue is full. 2 parts (2 requests)" in job.notice
    assert ("resend", "") not in queue  # not before their wait is over

    # Later: there is room for one. They are offered one at a time, from
    # the file already uploaded.
    provider.queue_full = {}
    for part in _parts(db_session)[1:]:
        _due(db_session, part)
    jobs_mod.poll_logo_ai_batch(str(job.id))
    assert ("resend", "") in queue
    jobs_mod.run_logo_ai_batch_submit(str(job.id))

    parts = _parts(db_session)
    assert [p.status for p in parts] == [PART_SUBMITTED, PART_SUBMITTED, PART_PENDING]
    assert parts[1].provider_batch_id == "batch-4" and provider.from_file == ["file-2"]
    assert len(provider.files) == 3  # nothing was uploaded a second time
    job = _reload(db_session, job)
    assert job.total_requests == 3  # counted once, however often it is sent

    _due(db_session, parts[2])
    jobs_mod.run_logo_ai_batch_submit(str(job.id))
    for batch_id in ("batch-1", "batch-4", "batch-5"):
        provider.batch_ended[batch_id] = True
    jobs_mod.poll_logo_ai_batch(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED and job.notice is None
    assert (job.done_assets, job.failed_assets, job.annotations_created) == (4, 0, 4)
    assert len(_annotations(db_session, s.task.id)) == 4


def test_an_adopted_batch_that_is_not_ours_is_never_read_as_ours(
    db_session, provider, queue, monkeypatch
) -> None:
    s = seed(db_session)
    job = s.job(db_session, delivery=DELIVERY_BATCH)
    real = jobs_mod._mark_sent
    monkeypatch.setattr(jobs_mod, "_mark_sent", lambda *a, **kw: (_ for _ in ()).throw(KeyboardInterrupt))
    with pytest.raises(KeyboardInterrupt):
        jobs_mod.run_logo_ai_batch_submit(str(job.id))
    db_session.rollback()
    monkeypatch.setattr(jobs_mod, "_mark_sent", real)
    # A provider that can only guess (no tags) points at someone else's
    # batch of the same size.
    provider.full_ids["batch-1"] = ["ffffffffffffffffffffffffffffffff-0_0", "ffff-1_0"]
    jobs_mod.run_logo_ai_batch_submit(str(job.id))
    assert _parts(db_session)[0].meta["adopted"] is True

    provider.batch_ended["batch-1"] = True
    jobs_mod.poll_logo_ai_batch(str(job.id))

    # Its answers are for other requests: no box of theirs lands on our
    # images. The two images count as not submitted.
    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED_WITH_ERRORS
    assert (job.annotations_created, job.failed_assets) == (1, 2)
    assert "not submitted" in job.errors[-1]


def test_cancel_finds_a_part_that_reached_the_provider_unrecorded(
    db_session, provider, queue, monkeypatch
) -> None:
    s = seed(db_session)
    job = s.job(db_session, delivery=DELIVERY_BATCH)
    monkeypatch.setattr(jobs_mod, "_mark_sent", lambda *a, **kw: (_ for _ in ()).throw(KeyboardInterrupt))
    with pytest.raises(KeyboardInterrupt):
        jobs_mod.run_logo_ai_batch_submit(str(job.id))
    db_session.rollback()
    job = _reload(db_session, job)
    job.status = STATUS_CANCELING
    db_session.commit()

    jobs_mod.poll_logo_ai_batch(str(job.id))

    # The batch was stopped at the provider and what it had produced
    # (it is billed) was kept.
    job = _reload(db_session, job)
    assert provider.canceled == ["batch-1"]
    assert job.status == STATUS_CANCELED and job.annotations_created == 3


def test_cancel_drops_a_part_that_never_reached_the_provider(
    db_session, provider, queue, monkeypatch
) -> None:
    monkeypatch.setattr(jobs_mod.time, "sleep", lambda _s: None)
    s = seed(db_session)
    job = s.job(db_session, delivery=DELIVERY_BATCH)

    def down(_requests, *, tag):
        raise RuntimeError("network is unreachable")

    monkeypatch.setattr(provider, "batch_create", down)
    jobs_mod.run_logo_ai_batch_submit(str(job.id))
    job = _reload(db_session, job)
    job.status = STATUS_CANCELING
    db_session.commit()

    jobs_mod.poll_logo_ai_batch(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_CANCELED and provider.batches == {}
    assert (job.annotations_created, job.failed_assets) == (1, 2)


def test_results_wait_when_they_cannot_be_written_yet(db_session, provider, queue, monkeypatch) -> None:
    s, job = _submitted(db_session, provider)
    provider.batch_ended["batch-1"] = True
    real = jobs_mod._load

    def broken(session, job, **kw):
        raise jobs_mod.LogoAiBadRequest("class not in this project: x")

    monkeypatch.setattr(jobs_mod, "_load", broken)
    jobs_mod.poll_logo_ai_batch(str(job.id))
    jobs_mod.poll_logo_ai_batch(str(job.id))

    # The run is not failed while the provider still has what was paid
    # for, and says once what is in the way.
    job = _reload(db_session, job)
    assert job.status == STATUS_SUBMITTED
    assert job.errors == ["results cannot be written: class not in this project: x"]

    monkeypatch.setattr(jobs_mod, "_load", real)
    jobs_mod.poll_logo_ai_batch(str(job.id))
    assert _reload(db_session, job).status == STATUS_COMPLETED


def test_reading_results_does_not_need_the_reference_images(db_session, provider, queue, monkeypatch) -> None:
    s, job = _submitted(db_session, provider)
    provider.batch_ended["batch-1"] = True
    seen: list[bool] = []
    real = jobs_mod.build_context

    def spy(session, task, options, *, with_references=True):
        seen.append(with_references)
        return real(session, task, options, with_references=with_references)

    monkeypatch.setattr(jobs_mod, "build_context", spy)
    jobs_mod.poll_logo_ai_batch(str(job.id))

    assert seen == [False]
    assert _reload(db_session, job).status == STATUS_COMPLETED


# --- the supervisor ---------------------------------------------------------


class _FakeRedis:
    def __init__(self) -> None:
        self.keys: set[str] = set()

    def set(self, key, _value, nx=False, ex=None):
        if nx and key in self.keys:
            return None
        self.keys.add(key)
        return True

    def delete(self, key) -> None:
        self.keys.discard(key)


def _supervise(db_session, conn, monkeypatch, alive=()) -> list[tuple[str, str]]:
    started: list[tuple[str, str]] = []
    monkeypatch.setattr(jobs_mod, "_rq_alive", lambda _c, job_id: job_id in alive)
    monkeypatch.setattr(
        jobs_mod,
        "enqueue",
        lambda fn, job_id, **kw: started.append((fn.__name__, job_id)),
    )
    db_session.expire_all()
    jobs_mod.enqueue_stalled_runs(db_session, connection=conn)
    return started


def _old(db_session, job: LogoAiJob, status: str) -> LogoAiJob:
    job.status = status
    job.created_at = datetime.now(UTC) - timedelta(minutes=10)
    db_session.commit()
    return job


def test_supervisor_restarts_a_run_with_nothing_behind_it(db_session, provider, monkeypatch) -> None:
    s = seed(db_session)
    conn = _FakeRedis()
    dead = _old(db_session, s.job(db_session), STATUS_RUNNING)
    working = _old(db_session, s.job(db_session), STATUS_RUNNING)
    batch = _old(db_session, s.job(db_session, delivery=DELIVERY_BATCH), "preparing")
    fresh = s.job(db_session)  # created a moment ago; its enqueue is on its way
    _old(db_session, s.job(db_session), STATUS_COMPLETED)
    _old(db_session, s.job(db_session, delivery=DELIVERY_BATCH), STATUS_SUBMITTED)  # the poll's
    alive = {str(working.id)}

    # Seen once with nothing behind it: it may be between two of its jobs.
    assert _supervise(db_session, conn, monkeypatch, alive) == []
    # Seen twice: it is restarted, and resumes from its row.
    started = _supervise(db_session, conn, monkeypatch, alive)
    assert sorted(started) == sorted(
        [("run_logo_ai_realtime", str(dead.id)), ("run_logo_ai_batch_submit", str(batch.id))]
    )
    assert str(fresh.id) not in {j for _, j in started}
    assert _reload(db_session, dead).stalls == 1


def test_supervisor_resumes_a_waiting_run_when_its_wait_is_over(db_session, provider, monkeypatch) -> None:
    s = seed(db_session)
    conn = _FakeRedis()
    job = _old(db_session, s.job(db_session), STATUS_RUNNING)
    job.notice = "Waiting: the provider cannot be reached."
    job.resume_after = datetime.now(UTC) + timedelta(minutes=5)
    job.pauses = 3
    db_session.commit()

    for _ in range(3):
        assert _supervise(db_session, conn, monkeypatch) == []

    job.resume_after = datetime.now(UTC) - timedelta(seconds=1)
    db_session.commit()
    _supervise(db_session, conn, monkeypatch)
    assert _supervise(db_session, conn, monkeypatch) == [("run_logo_ai_realtime", str(job.id))]
    job = _reload(db_session, job)
    # Waiting is not a crash, and the next try is not before another wait.
    assert job.stalls == 0 and job.resume_after > datetime.now(UTC)


def test_supervisor_gives_up_on_a_run_that_keeps_dying(db_session, provider, queue, monkeypatch) -> None:
    s = seed(db_session)
    conn = _FakeRedis()
    realtime = _old(db_session, s.job(db_session), STATUS_RUNNING)
    realtime.stalls = jobs_mod._MAX_STALLS
    db_session.commit()
    _supervise(db_session, conn, monkeypatch)
    assert _supervise(db_session, conn, monkeypatch) == []
    realtime = _reload(db_session, realtime)
    assert realtime.status == STATUS_FAILED and "kept stopping" in realtime.error


def test_supervisor_never_abandons_batches_already_with_the_provider(
    db_session, provider, queue, monkeypatch
) -> None:
    _small_parts(monkeypatch)
    monkeypatch.setattr(jobs_mod, "SUBMIT_PARTS_PER_RUN", 1)
    s = seed(db_session, n_assets=4)
    job = s.job(db_session, delivery=DELIVERY_BATCH)
    jobs_mod.run_logo_ai_batch_submit(str(job.id))  # one part out, two images to go
    job = _reload(db_session, job)
    assert job.status == "preparing" and len(provider.batches) == 1
    _old(db_session, job, "preparing")
    job.stalls = jobs_mod._MAX_STALLS
    db_session.commit()
    conn = _FakeRedis()
    queue.clear()

    _supervise(db_session, conn, monkeypatch)
    _supervise(db_session, conn, monkeypatch)

    # It stops submitting, but goes on to collect what is being paid for.
    job = _reload(db_session, job)
    assert job.status == STATUS_SUBMITTED and job.failed_assets == 2
    assert any("2 images not submitted" in e for e in job.errors)
    provider.batch_ended["batch-1"] = True
    jobs_mod.poll_logo_ai_batch(str(job.id))
    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED_WITH_ERRORS and job.annotations_created == 2


# --- the poll schedule ------------------------------------------------------


def test_due_polls_follow_the_job_age(db_session, provider, monkeypatch) -> None:
    s = seed(db_session)
    now = datetime.now(UTC)

    def job(status, submitted_ago, polled_ago, delivery=DELIVERY_BATCH) -> LogoAiJob:
        j = s.job(db_session, delivery=delivery)
        j.status = status
        j.submitted_at = now - submitted_ago
        j.last_polled_at = now - polled_ago if polled_ago is not None else None
        db_session.commit()
        return j

    fresh_due = job(STATUS_SUBMITTED, timedelta(minutes=1), timedelta(seconds=30))
    fresh_not_due = job(STATUS_SUBMITTED, timedelta(minutes=1), timedelta(seconds=5))
    old_not_due = job(STATUS_SUBMITTED, timedelta(hours=5), timedelta(seconds=90))
    old_due = job(STATUS_SUBMITTED, timedelta(hours=5), timedelta(seconds=200))
    never_polled = job(STATUS_SUBMITTED, timedelta(hours=1), None)
    canceling = job(STATUS_CANCELING, timedelta(hours=5), timedelta(seconds=20))
    job(STATUS_COMPLETED, timedelta(hours=5), timedelta(hours=4))
    job(STATUS_RUNNING, timedelta(0), None, delivery="realtime")

    queued: list[str] = []
    monkeypatch.setattr(
        jobs_mod, "enqueue_poll", lambda job_id, **kw: queued.append(job_id) or True
    )
    assert jobs_mod.enqueue_due_polls(db_session) == 4
    assert set(queued) == {
        str(j.id) for j in (fresh_due, old_due, never_polled, canceling)
    }
    assert str(fresh_not_due.id) not in queued and str(old_not_due.id) not in queued


def test_rq_ids_never_contain_a_colon(monkeypatch) -> None:
    # RQ 2 resolves "<id>:<anything>" back to the job "<id>", so a colon
    # in a chunk or poll id would re-run the run's first RQ job instead.
    from rq.exceptions import NoSuchJobError
    from rq.job import Job

    import carve_api.jobs.queue as queue_mod

    ids: list[str] = []
    monkeypatch.setattr(
        queue_mod,
        "enqueue_resumable",
        lambda fn, arg, *, rq_job_id, **kw: ids.append(rq_job_id),
    )

    def missing(*_a, **_k):
        raise NoSuchJobError

    monkeypatch.setattr(Job, "fetch", missing)
    jobs_mod.enqueue(jobs_mod.run_logo_ai_realtime, "job-1", connection=object())
    jobs_mod.enqueue(jobs_mod.run_logo_ai_realtime, "job-1", suffix="-c200", connection=object())
    assert jobs_mod.enqueue_poll("job-1", connection=object()) is True
    assert ids == ["job-1", "job-1-c200", "job-1-poll"]
    assert not any(":" in i for i in ids)


def test_a_model_with_its_own_coordinate_system_is_read_in_it(db_session, provider, queue) -> None:
    s = seed(db_session, n_assets=1)
    # The fake answers the box (49, 49)-(147, 98) in pixels of the sent
    # image, which OpenAI's 32px patches make 384x192 of the 400x200
    # original; on the 0..999 grid the same numbers would land elsewhere.
    job = s.job(db_session, provider="openai", model="gpt-6-sol")
    jobs_mod.run_logo_ai_realtime(str(job.id))
    (ann,) = _annotations(db_session, s.task.id)
    g = ann.geometry
    assert (round(g["x"]), round(g["y"]), round(g["w"]), round(g["h"])) == (51, 51, 102, 51)

    job = s.job(db_session, provider="openai", model="gpt-6.1-sol")
    jobs_mod.run_logo_ai_realtime(str(job.id))
    grid = [a for a in _annotations(db_session, s.task.id) if a.id != ann.id][0].geometry
    assert round(grid["x"]) != 50  # 49/999 of the width, not 49 pixels


def test_a_flex_run_waits_for_flex_capacity_instead_of_paying_full_price(
    db_session, provider, queue, monkeypatch
) -> None:
    monkeypatch.setattr(jobs_mod.time, "sleep", lambda _s: None)
    s = seed(db_session, n_assets=3)
    # Image 0 gets through; of the next two, one gets through and the
    # other hits "no Flex capacity" three times before it clears — more
    # retries than an ordinary passing error gets.
    provider.script = [ok(), ok(), *[ProviderResult(error="rate_limited")] * 3, ok()]
    job = s.job(db_session, provider="openai", model="gpt-6.1-sol", flex=True)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED
    assert (job.failed_assets, job.annotations_created) == (0, 3)
    assert len(provider.sent) == 6


def test_a_flex_run_stops_the_moment_a_request_is_served_at_full_price(
    db_session, provider, queue, monkeypatch
) -> None:
    monkeypatch.setattr(jobs_mod, "REALTIME_CHUNK_ASSETS", 100)
    s = seed(db_session, n_assets=12)
    full = ok()
    full.discounted = False  # the provider says: served as standard
    provider.script = [ok(), ok(), full]
    job = s.job(db_session, provider="openai", model="gpt-6.1-sol", flex=True)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    job = _reload(db_session, job)
    # One image, then one group of four in flight when it happened: the
    # other seven are never sent, so the bill cannot run away.
    assert job.status == STATUS_FAILED and len(provider.sent) == 5
    assert "standard price although Flex was asked" in job.error
    # What was served is kept, and said.
    assert job.annotations_created == 5 and job.failed_assets == 0
    assert sum("served at the standard price" in e for e in job.errors) == 1


def test_without_flex_the_tier_is_nobody_s_business(db_session, provider, queue) -> None:
    s = seed(db_session, n_assets=3)
    standard = ok()
    standard.discounted = False
    provider.script = [standard, standard, standard]
    job = s.job(db_session, provider="openai", model="gpt-6.1-sol")

    jobs_mod.run_logo_ai_realtime(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED and job.errors == []


# --- the second pass ---------------------------------------------------------


def _scores(*rows) -> ProviderResult:
    return ProviderResult(
        text=json.dumps({"scores": [list(r) for r in rows]}),
        usage=Usage(input_tokens=700, output_tokens=20, requests=1),
    )


def test_double_check_drops_what_it_scores_as_not_a_logo(db_session, provider, queue) -> None:
    s = seed(db_session, n_assets=1)
    three = ok(answer((10, 10, 60, 40), (100, 20, 180, 60), (200, 100, 300, 150)))
    provider.script = [three, _scores((1, 95), (2, 12), (3, 62))]
    job = s.job(db_session, double_check=True)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED and job.annotations_created == 2
    assert job.rejected_boxes == 1  # and the run says so
    kept = sorted(_annotations(db_session, s.task.id), key=lambda a: a.geometry["x"])
    assert [round(a.geometry["x"]) for a in kept] == [10, 204]  # the second box is gone
    # The close look is the better number: it becomes the box's confidence,
    # which is what the editor's filter then works on.
    assert [a.confidence for a in kept] == [0.95, 0.62]
    # The second request was the check: one sheet, three numbered tiles.
    check = provider.sent[1]
    assert check["check"] is True and "numbered 1 to 3" in check["text"]
    assert "Target classes" in check["system"] and "Acme" in check["system"]
    # Its tokens are on the bill, and it is not counted as a detection request.
    assert job.usage["input_tokens"] == 1700 and job.usage["requests"] == 1


def test_the_confidence_threshold_applies_to_the_checked_score(db_session, provider, queue) -> None:
    s = seed(db_session, n_assets=1)
    two = ok(answer((10, 10, 60, 40), (100, 20, 180, 60)))  # both 0.90 from detection
    provider.script = [two, _scores((1, 55), (2, 85))]
    job = s.job(db_session, double_check=True, min_confidence=0.7)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    (ann,) = _annotations(db_session, s.task.id)
    assert ann.confidence == 0.85


def test_double_check_skips_boxes_the_visibility_rule_drops_anyway(db_session, provider, queue) -> None:
    s = seed(db_session, n_assets=1)
    rows = [[10, 10, 60, 40, 90, 20], [100, 20, 180, 60, 90, 100]]  # 20% and 100% visible
    provider.script = [ok(json.dumps({"detections": rows})), _scores((1, 90))]
    job = s.job(db_session, double_check=True, min_visible=50)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    assert "numbered 1 to 1" in provider.sent[1]["text"]
    assert _reload(db_session, job).annotations_created == 1


def test_an_unreadable_check_keeps_the_boxes(db_session, provider, queue) -> None:
    s = seed(db_session, n_assets=1)
    provider.script = [ok(), ProviderResult(text="not json", usage=Usage(input_tokens=700, requests=1))]
    job = s.job(db_session, double_check=True)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED and job.annotations_created == 1
    assert _annotations(db_session, s.task.id)[0].confidence == 0.9  # the detection's own


def test_a_check_that_cannot_reach_the_provider_waits_like_any_request(db_session, provider, queue) -> None:
    s = seed(db_session, n_assets=1)
    provider.script = [ok(), ProviderResult(error="rate_limited")]
    job = s.job(db_session, double_check=True)

    jobs_mod.run_logo_ai_realtime(str(job.id))

    # Not written unchecked, not failed: the run waits and does the image again.
    job = _reload(db_session, job)
    assert job.status == STATUS_RUNNING
    assert job.notice and job.annotations_created == 0 and job.failed_assets == 0
    assert _annotations(db_session, s.task.id) == []


def test_no_boxes_means_no_second_request(db_session, provider, queue) -> None:
    s = seed(db_session, n_assets=1)
    provider.script = [ok(json.dumps({"detections": []}))]
    job = s.job(db_session, double_check=True)
    jobs_mod.run_logo_ai_realtime(str(job.id))
    assert len(provider.sent) == 1 and _reload(db_session, job).status == STATUS_COMPLETED


def test_the_check_model_defaults_to_the_tested_one_and_can_be_chosen(db_session, provider) -> None:
    from carve_api.logo_ai.service import LogoAiBadRequest, RunOptions, build_context

    s = seed(db_session, n_assets=1)

    def ctx(**kw):
        params = s.params(provider="openai", model="gpt-6.1-sol", effort="low", **kw)
        return build_context(db_session, s.task, RunOptions(**params))

    assert ctx().check_model is None  # no second pass, no check model
    default = ctx(double_check=True)
    assert (default.check_model.id, default.check_effort) == ("gpt-6-sol", "low")
    chosen = ctx(double_check=True, check_model="gpt-6-luna", check_effort="none")
    assert (chosen.check_model.id, chosen.check_effort) == ("gpt-6-luna", "none")
    # An effort the check model does not take falls back to that model's default.
    assert ctx(double_check=True, check_model="gpt-6.1-sol", check_effort="none").check_effort == "low"
    with pytest.raises(LogoAiBadRequest):
        ctx(double_check=True, check_model="gpt-0")
    # A provider with no tested default checks with the run's own model.
    own = build_context(db_session, s.task, RunOptions(**s.params(double_check=True)))
    assert (own.check_model.id, own.check_effort) == ("claude-opus-5-5", "low")
