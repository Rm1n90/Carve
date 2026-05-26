import uuid
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from carve_api.projects.schemas import TaskResumeStatus


def test_resume_schema_accepts_populated_payload() -> None:
    asset_id = uuid.uuid4()
    frame_id = uuid.uuid4()
    ts = datetime(2026, 5, 26, 16, 4, tzinfo=timezone.utc)
    s = TaskResumeStatus(
        last_asset_id=asset_id,
        last_frame_id=frame_id,
        annotated_assets=350,
        total_assets=1000,
        last_activity_at=ts,
    )
    assert s.last_asset_id == asset_id
    assert s.annotated_assets == 350


def test_resume_schema_accepts_empty_payload() -> None:
    s = TaskResumeStatus(
        last_asset_id=None,
        last_frame_id=None,
        annotated_assets=0,
        total_assets=0,
        last_activity_at=None,
    )
    assert s.last_asset_id is None
    assert s.last_activity_at is None


def test_resume_schema_rejects_negative_counts() -> None:
    with pytest.raises(ValidationError):
        TaskResumeStatus(
            last_asset_id=None,
            last_frame_id=None,
            annotated_assets=-1,
            total_assets=10,
            last_activity_at=None,
        )
