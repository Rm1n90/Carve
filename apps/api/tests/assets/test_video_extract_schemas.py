import uuid

import pytest
from pydantic import ValidationError

from carve_api.assets.video_extract_schemas import (
    BatchEnqueueIn,
    BatchEnqueueOut,
    BatchJobItem,
    BatchStatusOut,
)


def test_enqueue_accepts_minimum_payload() -> None:
    p = BatchEnqueueIn(
        source_asset_ids=[uuid.uuid4()],
        mode="auto",
        n_or_k=1,
        quality=75,
    )
    assert p.mode == "auto"
    assert p.quality == 75


def test_enqueue_clamps_quality_high() -> None:
    p = BatchEnqueueIn(
        source_asset_ids=[uuid.uuid4()],
        mode="auto",
        n_or_k=1,
        quality=999,
    )
    assert p.quality == 100


def test_enqueue_clamps_quality_low() -> None:
    p = BatchEnqueueIn(
        source_asset_ids=[uuid.uuid4()],
        mode="auto",
        n_or_k=1,
        quality=0,
    )
    assert p.quality == 1


def test_enqueue_rejects_unknown_mode() -> None:
    with pytest.raises(ValidationError):
        BatchEnqueueIn(
            source_asset_ids=[uuid.uuid4()],
            mode="bogus",
            n_or_k=1,
            quality=75,
        )


def test_enqueue_rejects_n_or_k_zero_for_count() -> None:
    with pytest.raises(ValidationError):
        BatchEnqueueIn(
            source_asset_ids=[uuid.uuid4()],
            mode="count",
            n_or_k=0,
            quality=75,
        )


def test_enqueue_rejects_n_or_k_zero_for_every_nth() -> None:
    with pytest.raises(ValidationError):
        BatchEnqueueIn(
            source_asset_ids=[uuid.uuid4()],
            mode="every_nth",
            n_or_k=0,
            quality=75,
        )


def test_enqueue_allows_n_or_k_zero_for_auto_and_all() -> None:
    for mode in ("auto", "all"):
        BatchEnqueueIn(
            source_asset_ids=[uuid.uuid4()],
            mode=mode,
            n_or_k=0,
            quality=75,
        )


def test_enqueue_rejects_empty_source_list() -> None:
    with pytest.raises(ValidationError):
        BatchEnqueueIn(
            source_asset_ids=[],
            mode="auto",
            n_or_k=1,
            quality=75,
        )


def test_status_shape_round_trips() -> None:
    batch_id = uuid.uuid4()
    item = BatchJobItem(
        job_id="rq-id-1",
        source_asset_id=uuid.uuid4(),
        source_filename="race.mp4",
        status="running",
        progress=42,
        frames_extracted=21,
        dedup_skipped=0,
        error_message=None,
    )
    out = BatchStatusOut(batch_id=batch_id, jobs=[item])
    assert out.jobs[0].progress == 42


def test_status_progress_is_clamped() -> None:
    with pytest.raises(ValidationError):
        BatchJobItem(
            job_id="rq-id-1",
            source_asset_id=uuid.uuid4(),
            source_filename="race.mp4",
            status="running",
            progress=150,
            frames_extracted=0,
            dedup_skipped=0,
            error_message=None,
        )


def test_enqueue_out_shape() -> None:
    out = BatchEnqueueOut(
        batch_id=uuid.uuid4(),
        jobs=[
            BatchJobItem(
                job_id="rq-id-1",
                source_asset_id=uuid.uuid4(),
                source_filename="race.mp4",
                status="queued",
                progress=0,
                frames_extracted=0,
                dedup_skipped=0,
                error_message=None,
            )
        ],
    )
    assert len(out.jobs) == 1
