"""
Tests for video extract batch endpoint schemas.

Tests Pydantic models:
- BatchEnqueueIn: Input validation for batch enqueue
- BatchEnqueueOut: Response from batch enqueue
- BatchJobItem: Individual job info in status response
- BatchStatusOut: Batch status response
"""

import pytest
from pydantic import ValidationError

# These imports will fail until schemas are implemented
try:
    from carve_api.assets.video_extract_schemas import (
        BatchEnqueueIn,
        BatchEnqueueOut,
        BatchJobItem,
        BatchStatusOut,
    )
except ImportError:
    pass


class TestBatchEnqueueIn:
    """Tests for BatchEnqueueIn input validation."""

    def test_valid_minimal_input(self):
        """Valid input with required fields only."""
        data = {
            "sources": ["video1.mp4"],
            "mode": "every_nth",
            "n_or_k": 5,
            "quality": 85,
        }
        batch = BatchEnqueueIn(**data)
        assert batch.sources == ["video1.mp4"]
        assert batch.mode == "every_nth"
        assert batch.n_or_k == 5
        assert batch.quality == 85

    def test_valid_multiple_sources(self):
        """Input with multiple sources."""
        data = {
            "sources": ["video1.mp4", "video2.mp4", "video3.mp4"],
            "mode": "count",
            "n_or_k": 10,
            "quality": 95,
        }
        batch = BatchEnqueueIn(**data)
        assert len(batch.sources) == 3

    def test_sources_empty_list_fails(self):
        """Empty sources list should fail validation."""
        data = {
            "sources": [],
            "mode": "every_nth",
            "n_or_k": 5,
            "quality": 85,
        }
        with pytest.raises(ValidationError):
            BatchEnqueueIn(**data)

    def test_mode_literal_valid(self):
        """Mode must be one of the allowed literals."""
        for mode in ["every_nth", "count"]:
            data = {
                "sources": ["video.mp4"],
                "mode": mode,
                "n_or_k": 5,
                "quality": 85,
            }
            batch = BatchEnqueueIn(**data)
            assert batch.mode == mode

    def test_mode_literal_invalid(self):
        """Invalid mode should fail validation."""
        data = {
            "sources": ["video.mp4"],
            "mode": "invalid_mode",
            "n_or_k": 5,
            "quality": 85,
        }
        with pytest.raises(ValidationError):
            BatchEnqueueIn(**data)

    def test_n_or_k_positive_required_for_every_nth(self):
        """For every_nth mode, n_or_k must be > 0."""
        data = {
            "sources": ["video.mp4"],
            "mode": "every_nth",
            "n_or_k": 0,
            "quality": 85,
        }
        with pytest.raises(ValidationError):
            BatchEnqueueIn(**data)

    def test_n_or_k_positive_required_for_count(self):
        """For count mode, n_or_k must be > 0."""
        data = {
            "sources": ["video.mp4"],
            "mode": "count",
            "n_or_k": 0,
            "quality": 85,
        }
        with pytest.raises(ValidationError):
            BatchEnqueueIn(**data)

    def test_quality_clamped_to_range(self):
        """Quality should be clamped to 1..100."""
        # Test clamping below minimum
        data = {
            "sources": ["video.mp4"],
            "mode": "every_nth",
            "n_or_k": 5,
            "quality": -10,
        }
        batch = BatchEnqueueIn(**data)
        assert batch.quality == 1

        # Test clamping above maximum
        data["quality"] = 150
        batch = BatchEnqueueIn(**data)
        assert batch.quality == 100

    def test_quality_within_valid_range(self):
        """Quality within 1..100 should remain unchanged."""
        data = {
            "sources": ["video.mp4"],
            "mode": "every_nth",
            "n_or_k": 5,
            "quality": 50,
        }
        batch = BatchEnqueueIn(**data)
        assert batch.quality == 50

    def test_n_or_k_negative_fails(self):
        """n_or_k cannot be negative."""
        data = {
            "sources": ["video.mp4"],
            "mode": "every_nth",
            "n_or_k": -5,
            "quality": 85,
        }
        with pytest.raises(ValidationError):
            BatchEnqueueIn(**data)


class TestBatchEnqueueOut:
    """Tests for BatchEnqueueOut response serialization."""

    def test_batch_id_returned(self):
        """Response includes batch_id."""
        response = BatchEnqueueOut(batch_id="batch-123")
        assert response.batch_id == "batch-123"


class TestBatchJobItem:
    """Tests for BatchJobItem individual job representation."""

    def test_job_item_fields(self):
        """JobItem contains expected fields."""
        item = BatchJobItem(
            source="video.mp4",
            status="completed",
            frames_extracted=42,
        )
        assert item.source == "video.mp4"
        assert item.status == "completed"
        assert item.frames_extracted == 42

    def test_job_status_literal(self):
        """Job status must be from allowed literals."""
        for status in ["pending", "processing", "completed", "failed"]:
            item = BatchJobItem(
                source="video.mp4",
                status=status,
                frames_extracted=0,
            )
            assert item.status == status


class TestBatchStatusOut:
    """Tests for BatchStatusOut batch status response."""

    def test_batch_status_response(self):
        """Status response includes batch_id and jobs."""
        jobs = [
            BatchJobItem(source="video1.mp4", status="completed", frames_extracted=10),
            BatchJobItem(source="video2.mp4", status="processing", frames_extracted=5),
        ]
        response = BatchStatusOut(batch_id="batch-123", jobs=jobs)
        assert response.batch_id == "batch-123"
        assert len(response.jobs) == 2

    def test_batch_status_empty_jobs(self):
        """Status response can have empty jobs list."""
        response = BatchStatusOut(batch_id="batch-123", jobs=[])
        assert response.batch_id == "batch-123"
        assert response.jobs == []
