# Armin Mehri — mehri.armin@gmail.com
"""Smoke tests for ``video_to_images`` worker module.

The full end-to-end exercise (real MinIO + DB + ffmpeg) is covered by
the manual E2E flow (Task 13). These tests target the parts of the
worker module that can be verified in isolation: payload shape,
quality mapping, the Redis-progress key/getter/setter API, and the
planner integration (already exhaustively tested in
``test_video_to_images_planner.py``).
"""
from __future__ import annotations

import uuid

import pytest  # noqa: F401 — pytest discovery

from carve_api.jobs.video_to_images import (
    VideoToImagesPayload,
    _content_hash,
    _image_dimensions,
    _progress_key,
    quality_to_qv,
)


def test_payload_dataclass_round_trips() -> None:
    p = VideoToImagesPayload(
        job_id="vti-abc",
        batch_id=str(uuid.uuid4()),
        task_id=str(uuid.uuid4()),
        source_asset_id=str(uuid.uuid4()),
        mode="count",
        n_or_k=10,
        quality=75,
        source_filename="race.mp4",
    )
    assert p.job_id == "vti-abc"
    assert p.mode == "count"
    assert p.source_filename == "race.mp4"
    assert p.extras == {}


def test_payload_supports_extras_dict() -> None:
    p = VideoToImagesPayload(
        job_id="vti-abc",
        batch_id="b",
        task_id="t",
        source_asset_id="a",
        mode="auto",
        n_or_k=0,
        quality=75,
        extras={"hint": "x"},
    )
    assert p.extras == {"hint": "x"}


def test_quality_to_qv_maps_high_quality_to_low_qv() -> None:
    # mjpeg: 1 = best (largest file), 31 = worst.
    assert quality_to_qv(100) == 1


def test_quality_to_qv_maps_low_quality_to_high_qv() -> None:
    assert quality_to_qv(1) == 31


def test_quality_to_qv_midrange() -> None:
    qv = quality_to_qv(50)
    assert 10 <= qv <= 22


def test_quality_to_qv_clamps_above_100() -> None:
    assert quality_to_qv(500) == 1


def test_quality_to_qv_clamps_below_1() -> None:
    assert quality_to_qv(-50) == 31


def test_progress_key_is_namespaced() -> None:
    assert _progress_key("vti-xyz") == "video-extract:vti-xyz"


def test_content_hash_is_stable_for_same_input() -> None:
    a = _content_hash(b"hello world")
    b = _content_hash(b"hello world")
    assert a == b
    assert len(a) == 32  # xxh3_128 hex is 32 chars


def test_content_hash_differs_for_different_inputs() -> None:
    a = _content_hash(b"hello world")
    b = _content_hash(b"hello, world")
    assert a != b


def _make_jpeg(width: int, height: int) -> bytes:
    from io import BytesIO

    from PIL import Image

    buf = BytesIO()
    Image.new("RGB", (width, height), (123, 200, 50)).save(buf, format="JPEG")
    return buf.getvalue()


def test_image_dimensions_reads_jpeg_size() -> None:
    # Arrange: a JPEG frame as produced by ffmpeg in the worker.
    jpeg = _make_jpeg(640, 360)

    # Act
    width, height = _image_dimensions(jpeg)

    # Assert: the extracted frame asset must carry real dimensions so the
    # YOLO/COCO export (which drops dimensionless assets) includes it.
    assert (width, height) == (640, 360)


def test_image_dimensions_returns_none_on_garbage() -> None:
    # A corrupt/unreadable frame must not crash the whole extraction batch;
    # it returns (None, None) and the asset is still created (its missing
    # dimensions are a known, isolated cost, not a hard failure).
    width, height = _image_dimensions(b"not a real jpeg")

    assert (width, height) == (None, None)
