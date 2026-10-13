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


# ---------------------------------------------------------------------------
# Cancel: the frames made so far stay, the video goes
# ---------------------------------------------------------------------------


def _video_task(db_session):
    from carve_api.assets.models import Asset, AssetKind
    from carve_api.auth.models import User, UserRole
    from carve_api.projects.models import Project, Task, TaskKind

    u = User(email=f"v-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.admin)
    db_session.add(u)
    db_session.flush()
    p = Project(name="P", owner_id=u.id)
    db_session.add(p)
    db_session.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image)
    db_session.add(t)
    db_session.flush()
    v = Asset(task_id=t.id, kind=AssetKind.video, xxh3_128="vid", mime="video/mp4", size_bytes=1,
              width=10, height=10, frames=100, original_name="reel.mp4")
    db_session.add(v)
    db_session.commit()
    return t, v


def _run(db_session, monkeypatch, video, *, cancel_after: int | None):
    import io

    from PIL import Image
    from sqlalchemy.orm import sessionmaker

    from carve_api import db as db_mod
    from carve_api.jobs import video_to_images as vti
    from carve_api.storage import client as storage_mod

    removed: list[str] = []

    class Storage:
        @classmethod
        def from_settings(cls):
            return cls()

        def presigned_get_internal(self, key, **k):
            return f"https://x/{key}"

        def put_object(self, *a, **k):
            pass

        def remove_object(self, key):
            removed.append(key)

    factory = sessionmaker(bind=db_session.get_bind(), autoflush=False, expire_on_commit=False,
                           future=True, join_transaction_mode="create_savepoint")
    monkeypatch.setattr(db_mod, "get_session_factory", lambda: factory)
    monkeypatch.setattr(storage_mod, "MinioClient", Storage)
    monkeypatch.setattr(vti, "set_progress", lambda *a, **k: None)
    monkeypatch.setattr(vti, "_finalize_progress", lambda *a, **k: None)
    monkeypatch.setattr(vti, "_enqueue_thumbnail", lambda *a, **k: None)
    monkeypatch.setattr(
        vti, "_probe", (lambda url: pytest.fail("probed a cancelled video")) if cancel_after == 0 else (lambda url: (100, 25.0, 4.0))
    )
    n = {"frames": 0}

    def frame(url, ts, qv):
        n["frames"] += 1
        buf = io.BytesIO()
        Image.new("RGB", (4, 4), (n["frames"] * 20, 0, 0)).save(buf, format="JPEG")
        return buf.getvalue()

    monkeypatch.setattr(vti, "_extract_one_frame", frame)
    calls = {"n": 0}

    def cancelled(job_id):
        calls["n"] += 1
        return cancel_after is not None and calls["n"] > cancel_after

    monkeypatch.setattr(vti, "is_cancel_requested", cancelled)
    payload = vti.VideoToImagesPayload(job_id="j", batch_id="b", task_id=str(video.task_id),
                                       source_asset_id=str(video.id), mode="count", n_or_k=5, quality=90)
    return vti.run_video_to_images(payload), removed


def test_a_cancelled_extraction_keeps_its_frames_and_drops_the_video(db_session, monkeypatch) -> None:
    from carve_api.assets.models import Asset, AssetKind

    t, v = _video_task(db_session)
    vid, tid = v.id, t.id
    # The first check is before probing; two frames get made, then cancel.
    out, removed = _run(db_session, monkeypatch, v, cancel_after=3)
    assert out["status"] == "cancelled"
    db_session.expire_all()
    assert db_session.get(Asset, vid) is None
    assert removed == ["assets/vid/original.mp4"]
    frames = db_session.query(Asset).filter(Asset.task_id == tid, Asset.kind == AssetKind.image).all()
    assert len(frames) == 2


def test_a_job_cancelled_while_queued_drops_the_video_without_probing(db_session, monkeypatch) -> None:
    from carve_api.assets.models import Asset

    t, v = _video_task(db_session)
    vid = v.id
    out, removed = _run(db_session, monkeypatch, v, cancel_after=0)
    assert out["status"] == "cancelled"
    db_session.expire_all()
    assert db_session.get(Asset, vid) is None
