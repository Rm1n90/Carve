# Mixed-Upload Video Frame Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drop a mix of images and videos into the upload dialog of an `image`-kind task. Videos get extracted to JPEG frames per a single shared param set, originals are deleted, and progress is surfaced through a dismissable modal + the existing background-jobs bar.

**Architecture:** New RQ worker `video_to_images_worker` consumes the existing extraction primitives in `jobs/frames.py` to create fresh `Asset(kind=image)` rows per extracted frame, then deletes the source video. Three new endpoints (enqueue / status / cancel) live under the existing project-task routes. Batch grouping uses RQ `job.meta["batch_id"]` plus a Redis set per batch — no SQL schema changes. Frontend adds two new wizard step components inside `AssetUploadDialog` plus a dismissable progress modal driven by the existing WS `job_updated` topic.

**Tech Stack:** FastAPI + SQLAlchemy + RQ + ffmpeg-python + MinIO (backend), React + TanStack Query + Radix Dialog + Tailwind tokens + vitest (frontend).

**Spec:** [`docs/superpowers/specs/2026-05-27-mixed-upload-video-frame-extraction-design.md`](../specs/2026-05-27-mixed-upload-video-frame-extraction-design.md)

**Spec deltas (called out so future readers know why the code differs from the spec):**

1. The spec says "add a `batch_id` column on the Job table." There is **no** SQL Job table — jobs live in RQ/Redis. The plan stores `batch_id` in RQ `job.meta` plus a Redis set `videoextract:batch:{batch_id}` whose members are the per-video job ids.
2. The spec's `mode=total_k` is renamed to `mode=count` so the new worker's strategy vocabulary matches the existing `extract_frames_for_video` (`all | every_nth | count | auto`). The frontend continues to label this option "Total of K (smart)" to the user — only the wire value changes.

---

## File Map

**Create**
- `apps/api/src/carve_api/jobs/video_to_images.py` — new RQ worker module: enqueue helper + worker entry point + per-job cancel-check helper.
- `apps/api/src/carve_api/jobs/video_to_images_planner.py` — pure-function timestamp planner (unit-testable without ffmpeg/Redis/DB).
- `apps/api/src/carve_api/assets/video_extract_schemas.py` — Pydantic request/response models for the three endpoints.
- `apps/api/src/carve_api/assets/video_extract_service.py` — pure-Python service that validates inputs, creates RQ jobs, fetches batch status, cancels a batch.
- `apps/api/tests/assets/test_video_extract_schemas.py`
- `apps/api/tests/assets/test_video_extract_service.py`
- `apps/api/tests/assets/test_video_extract_router.py`
- `apps/api/tests/jobs/test_video_to_images_planner.py`
- `apps/api/tests/jobs/test_video_to_images.py`
- `apps/api/tests/fixtures/tiny.mp4` — ~60-frame, 2-second, 320×240 mp4 fixture (committed to the repo).
- `apps/web/src/api/video_extract.ts` — frontend client for the three endpoints.
- `apps/web/src/hooks/useVideoExtractBatch.ts` — TanStack Query hook with poll fallback (WS subscription optional).
- `apps/web/src/components/annotation/VideoExtractParamsStep.tsx` — the radio-list step from the screenshot.
- `apps/web/src/components/annotation/VideoExtractProgressDialog.tsx` — the per-video progress modal.
- `apps/web/src/components/annotation/__tests__/VideoExtractParamsStep.test.tsx`
- `apps/web/src/components/annotation/__tests__/VideoExtractProgressDialog.test.tsx`

**Modify**
- `apps/api/src/carve_api/assets/router.py` (or the closest existing project-task router, e.g. `projects/router.py` where the resume endpoint added in `6cc1d66` lives) — register the three new endpoints.
- `apps/api/tests/conftest.py` — add the `rq_queue_stub` fixture.
- `apps/web/src/components/annotation/AssetUploadDialog.tsx` — detect videos, insert the new wizard step, hand off to the progress dialog.
- `apps/web/src/components/BackgroundJobsBar.tsx` — add the `video_extract_to_images` label + icon.

---

## Conventions

- **Working directory** for all bash: `/home/media4us/Documents/Dev/VisualAutoAnnotator`.
- **Backend tests** run inside docker: `docker compose exec api pytest …`.
- **Frontend tests** run from host: `pnpm --filter carve-web exec vitest run …`.
- **TypeScript check:** `pnpm --filter carve-web exec tsc --noEmit`.
- **Frequent commits**: each task ends with a single conventional commit (`feat`, `test`, `chore`, `fix`).
- **Never `git add -A`** — stage explicit paths.

---

## Task 1 — Pydantic schemas

**Files:**
- Create: `apps/api/src/carve_api/assets/video_extract_schemas.py`
- Test: `apps/api/tests/assets/test_video_extract_schemas.py`

- [ ] **Step 1 — Write the failing tests**

Create `apps/api/tests/assets/test_video_extract_schemas.py`:

```python
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
```

- [ ] **Step 2 — Run, verify failure**

```bash
docker compose exec api pytest tests/assets/test_video_extract_schemas.py -v
```

Expected: ImportError.

- [ ] **Step 3 — Implement the schemas**

Create `apps/api/src/carve_api/assets/video_extract_schemas.py`:

```python
# Armin Mehri — mehri.armin@gmail.com
"""Pydantic schemas for the video → image extraction batch endpoints.

The strategy vocabulary (``auto | all | every_nth | count``) intentionally
matches the existing ``extract_frames_for_video`` worker in
``carve_api/jobs/frames.py`` so there is one set of names in the codebase.
The frontend labels ``count`` as "Total of K (smart)" to the user but the
wire value is ``count``.
"""
from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


ExtractMode = Literal["auto", "all", "every_nth", "count"]
JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]


class BatchEnqueueIn(BaseModel):
    """Request body for ``POST /…/video-extract/batch``."""

    source_asset_ids: list[uuid.UUID] = Field(min_length=1)
    mode: ExtractMode
    n_or_k: int = Field(ge=0)
    quality: int = Field(ge=1, le=100)

    model_config = ConfigDict(extra="forbid")

    @field_validator("quality", mode="before")
    @classmethod
    def _clamp_quality(cls, v: int) -> int:
        try:
            iv = int(v)
        except (TypeError, ValueError):
            return v
        return max(1, min(100, iv))

    @field_validator("n_or_k")
    @classmethod
    def _n_or_k_for_step_modes(cls, v: int, info) -> int:  # type: ignore[no-untyped-def]
        mode = info.data.get("mode")
        if mode in ("every_nth", "count") and v <= 0:
            raise ValueError(f"n_or_k must be >= 1 for mode={mode}")
        return v


class BatchJobItem(BaseModel):
    job_id: str
    source_asset_id: uuid.UUID
    source_filename: str
    status: JobStatus
    progress: int = Field(ge=0, le=100)
    frames_extracted: int = Field(ge=0)
    dedup_skipped: int = Field(ge=0)
    error_message: str | None = None


class BatchEnqueueOut(BaseModel):
    batch_id: uuid.UUID
    jobs: list[BatchJobItem]


class BatchStatusOut(BaseModel):
    batch_id: uuid.UUID
    jobs: list[BatchJobItem]
```

- [ ] **Step 4 — Run, expect pass**

```bash
docker compose exec api pytest tests/assets/test_video_extract_schemas.py -v
```

Expected: 11 passed.

- [ ] **Step 5 — Commit**

```bash
git add apps/api/src/carve_api/assets/video_extract_schemas.py apps/api/tests/assets/test_video_extract_schemas.py
git commit -m "feat(api): add Pydantic schemas for video-extract batch endpoints"
```

---

## Task 2 — Frame-timestamp planner (pure function)

**Files:**
- Create: `apps/api/src/carve_api/jobs/video_to_images_planner.py`
- Test: `apps/api/tests/jobs/test_video_to_images_planner.py`

- [ ] **Step 1 — Write the failing tests**

Create `apps/api/tests/jobs/test_video_to_images_planner.py`:

```python
import pytest

from carve_api.jobs.video_to_images_planner import compute_extraction_timestamps


def test_all_returns_every_frame_timestamp() -> None:
    ts = compute_extraction_timestamps(
        mode="all", n_or_k=0, frame_count=10, fps=10.0, duration_s=1.0
    )
    assert len(ts) == 10
    assert ts[0] == pytest.approx(0.0)
    assert ts[-1] == pytest.approx(0.9, abs=1e-3)


def test_every_nth_returns_step_indices() -> None:
    ts = compute_extraction_timestamps(
        mode="every_nth", n_or_k=3, frame_count=10, fps=10.0, duration_s=1.0
    )
    assert ts == pytest.approx([0.0, 0.3, 0.6, 0.9], abs=1e-3)


def test_count_returns_k_evenly_spaced() -> None:
    ts = compute_extraction_timestamps(
        mode="count", n_or_k=4, frame_count=100, fps=10.0, duration_s=10.0
    )
    assert len(ts) == 4
    assert ts[0] == pytest.approx(0.0, abs=1e-3)
    # Last sample lands at duration when k > 1.
    assert ts[-1] == pytest.approx(10.0, abs=1e-3)


def test_count_when_k_exceeds_frame_count_collapses_to_all() -> None:
    ts = compute_extraction_timestamps(
        mode="count", n_or_k=1000, frame_count=10, fps=10.0, duration_s=1.0
    )
    assert len(ts) == 10


def test_auto_below_500_returns_all() -> None:
    ts = compute_extraction_timestamps(
        mode="auto", n_or_k=0, frame_count=500, fps=25.0, duration_s=20.0
    )
    assert len(ts) == 500


def test_auto_above_500_returns_500() -> None:
    ts = compute_extraction_timestamps(
        mode="auto", n_or_k=0, frame_count=2000, fps=25.0, duration_s=80.0
    )
    assert len(ts) == 500


def test_every_nth_with_n_larger_than_frame_count_returns_first_frame_only() -> None:
    ts = compute_extraction_timestamps(
        mode="every_nth", n_or_k=999, frame_count=10, fps=10.0, duration_s=1.0
    )
    assert ts == pytest.approx([0.0])


def test_rejects_zero_frame_count() -> None:
    with pytest.raises(ValueError, match="frame_count"):
        compute_extraction_timestamps(
            mode="all", n_or_k=0, frame_count=0, fps=10.0, duration_s=1.0
        )


def test_rejects_zero_fps() -> None:
    with pytest.raises(ValueError, match="fps"):
        compute_extraction_timestamps(
            mode="all", n_or_k=0, frame_count=10, fps=0.0, duration_s=1.0
        )
```

- [ ] **Step 2 — Run, verify failure**

```bash
docker compose exec api pytest tests/jobs/test_video_to_images_planner.py -v
```

Expected: ImportError.

- [ ] **Step 3 — Implement**

Create `apps/api/src/carve_api/jobs/video_to_images_planner.py`:

```python
# Armin Mehri — mehri.armin@gmail.com
"""Plans which frame timestamps to extract for the mixed-upload video flow.

Pure function over ``(mode, n_or_k, frame_count, fps, duration_s)`` that
returns an ordered list of timestamps in seconds. Kept separate from the
worker entry point so it can be unit-tested without ffmpeg, Redis, or
the DB.
"""
from __future__ import annotations

from typing import Literal


ExtractMode = Literal["auto", "all", "every_nth", "count"]
_AUTO_CAP = 500


def compute_extraction_timestamps(
    *,
    mode: ExtractMode,
    n_or_k: int,
    frame_count: int,
    fps: float,
    duration_s: float,
) -> list[float]:
    """Return an ordered list of timestamps (seconds) to extract.

    Modes:
      ``all``        — every frame (frame_count timestamps).
      ``every_nth``  — frame indices 0, N, 2N, …, clipped to last frame.
      ``count``      — n_or_k evenly-spaced timestamps in [0, duration_s].
                       Collapses to ``all`` if n_or_k >= frame_count.
      ``auto``       — ``all`` if frame_count <= 500, else 500 evenly-spaced.

    Raises ``ValueError`` for non-positive frame_count / fps.
    """
    if frame_count <= 0:
        raise ValueError("frame_count must be > 0")
    if fps <= 0:
        raise ValueError("fps must be > 0")

    if mode == "all":
        return [i / fps for i in range(frame_count)]

    if mode == "every_nth":
        step = max(1, int(n_or_k))
        return [i / fps for i in range(0, frame_count, step)]

    if mode == "count":
        k = max(1, int(n_or_k))
        if k >= frame_count:
            return [i / fps for i in range(frame_count)]
        if k == 1:
            return [0.0]
        spacing = duration_s / (k - 1)
        return [i * spacing for i in range(k)]

    if mode == "auto":
        if frame_count <= _AUTO_CAP:
            return [i / fps for i in range(frame_count)]
        spacing = duration_s / (_AUTO_CAP - 1)
        return [i * spacing for i in range(_AUTO_CAP)]

    raise ValueError(f"unknown mode: {mode!r}")
```

- [ ] **Step 4 — Run, expect pass**

```bash
docker compose exec api pytest tests/jobs/test_video_to_images_planner.py -v
```

Expected: 9 passed.

- [ ] **Step 5 — Commit**

```bash
git add apps/api/src/carve_api/jobs/video_to_images_planner.py apps/api/tests/jobs/test_video_to_images_planner.py
git commit -m "feat(api): add pure-function timestamp planner for video→image extraction"
```

---

## Task 3 — `tiny.mp4` fixture

**Files:**
- Create: `apps/api/tests/fixtures/tiny.mp4`

- [ ] **Step 1 — Generate the fixture inside the api container**

```bash
docker compose exec api bash -c "ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=30 \
  -c:v libx264 -pix_fmt yuv420p /app/tests/fixtures/tiny.mp4 2>&1 | tail -5"
```

The api container mounts `apps/api` at `/app`, so the file lands on the host at `apps/api/tests/fixtures/tiny.mp4`.

- [ ] **Step 2 — Probe to confirm shape**

```bash
docker compose exec api bash -c "ffprobe -v error -print_format json -show_streams /app/tests/fixtures/tiny.mp4 | grep -E '\"nb_frames\"|\"r_frame_rate\"|\"duration\"' | head -5"
```

Expected: `nb_frames` ≈ 60, `r_frame_rate` = `30/1`, `duration` ≈ 2.0.

- [ ] **Step 3 — Commit**

```bash
mkdir -p apps/api/tests/fixtures
git add apps/api/tests/fixtures/tiny.mp4
git commit -m "test(api): add tiny.mp4 fixture for video→image extraction tests"
```

---

## Task 4 — Worker entry point

**Files:**
- Create: `apps/api/src/carve_api/jobs/video_to_images.py`
- Test: `apps/api/tests/jobs/test_video_to_images.py`

- [ ] **Step 1 — Inspect existing MinIO client method names**

```bash
grep -nE "def (put_object|get_object|delete_object|object_exists|head_object|get_bytes|upload_bytes)" apps/api/src/carve_api/storage/client.py | head -15
```

Note the exact method names — the worker test below assumes `put_object`/`get_object_bytes`/`delete_object`/`object_exists`. **Adapt** the implementation in step 4 if the project uses different names. Do NOT add new methods to the storage client.

- [ ] **Step 2 — Write the failing tests**

Create `apps/api/tests/jobs/test_video_to_images.py`:

```python
import pathlib
import uuid as _uuid

import pytest

from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.jobs.video_to_images import (
    VideoToImagesPayload,
    run_video_to_images,
)
from carve_api.projects.models import Project, ProjectMember, Task, TaskKind
from carve_api.storage.client import MinioClient


FIXTURE = pathlib.Path(__file__).parent.parent / "fixtures" / "tiny.mp4"


def _make_image_task(db_session, owner_id):
    project = Project(id=_uuid.uuid4(), name="P", owner_id=owner_id)
    db_session.add(project)
    db_session.flush()
    db_session.add(
        ProjectMember(project_id=project.id, user_id=owner_id, role="owner")
    )
    task = Task(
        id=_uuid.uuid4(),
        project_id=project.id,
        name="T",
        kind=TaskKind.image,
    )
    db_session.add(task)
    db_session.flush()
    return project, task


def _upload_video_asset(db_session, task, mc: MinioClient) -> Asset:
    body = FIXTURE.read_bytes()
    h = _uuid.uuid4().hex
    asset = Asset(
        id=_uuid.uuid4(),
        task_id=task.id,
        kind=AssetKind.video,
        xxh3_128=h,
        mime="video/mp4",
        size_bytes=len(body),
        frames=60,
        original_name="tiny.mp4",
    )
    db_session.add(asset)
    db_session.flush()
    mc.put_object(f"assets/{h}/source.mp4", body, content_type="video/mp4")
    return asset


def test_run_video_to_images_happy_path(db_session, minio_client, admin_user) -> None:
    _, task = _make_image_task(db_session, admin_user.id)
    src = _upload_video_asset(db_session, task, minio_client)
    db_session.commit()

    payload = VideoToImagesPayload(
        job_id="rq-test-1",
        batch_id=str(_uuid.uuid4()),
        task_id=str(task.id),
        source_asset_id=str(src.id),
        mode="count",
        n_or_k=5,
        quality=75,
        source_filename="tiny.mp4",
    )
    result = run_video_to_images(payload)

    assert result["status"] == "succeeded"
    assert result["frames_extracted"] == 5
    assert db_session.get(Asset, src.id) is None
    assert not minio_client.object_exists(f"assets/{src.xxh3_128}/source.mp4")
    images = (
        db_session.query(Asset)
        .filter(Asset.task_id == task.id, Asset.kind == AssetKind.image)
        .all()
    )
    assert len(images) == 5
    assert all("tiny.mp4 — frame " in a.original_name for a in images)
    for a in images:
        assert (
            db_session.query(Frame).filter(Frame.asset_id == a.id).count() == 1
        )


def test_run_video_to_images_missing_source_fails(
    db_session, minio_client, admin_user
) -> None:
    _, task = _make_image_task(db_session, admin_user.id)
    db_session.commit()
    payload = VideoToImagesPayload(
        job_id="rq-test-2",
        batch_id=str(_uuid.uuid4()),
        task_id=str(task.id),
        source_asset_id=str(_uuid.uuid4()),
        mode="auto",
        n_or_k=0,
        quality=75,
    )
    result = run_video_to_images(payload)
    assert result["status"] == "failed"
    assert "source video gone" in result["error_message"].lower()


def test_run_video_to_images_dedup_within_task(
    db_session, minio_client, admin_user
) -> None:
    _, task = _make_image_task(db_session, admin_user.id)
    src1 = _upload_video_asset(db_session, task, minio_client)
    db_session.commit()

    payload1 = VideoToImagesPayload(
        job_id="rq-test-3a",
        batch_id=str(_uuid.uuid4()),
        task_id=str(task.id),
        source_asset_id=str(src1.id),
        mode="count",
        n_or_k=5,
        quality=75,
        source_filename="tiny.mp4",
    )
    result1 = run_video_to_images(payload1)
    assert result1["frames_extracted"] == 5
    assert result1["dedup_skipped"] == 0

    src2 = _upload_video_asset(db_session, task, minio_client)
    db_session.commit()
    payload2 = VideoToImagesPayload(
        job_id="rq-test-3b",
        batch_id=str(_uuid.uuid4()),
        task_id=str(task.id),
        source_asset_id=str(src2.id),
        mode="count",
        n_or_k=5,
        quality=75,
        source_filename="tiny.mp4",
    )
    result2 = run_video_to_images(payload2)
    assert result2["dedup_skipped"] == 5
    assert result2["frames_extracted"] == 5
```

> **If `minio_client` is not yet a fixture** in `apps/api/tests/conftest.py`, add one that returns a `MinioClient()` instance pointed at the test bucket. Inspect what other tests do for MinIO (the existing `extract_frames_for_video` tests are a model). If no precedent exists, mark this task as `BLOCKED — needs MinIO test fixture decision` and escalate.

- [ ] **Step 3 — Run, verify failure**

```bash
docker compose exec api pytest tests/jobs/test_video_to_images.py -v
```

Expected: ImportError.

- [ ] **Step 4 — Implement the worker**

Create `apps/api/src/carve_api/jobs/video_to_images.py`:

```python
# Armin Mehri — mehri.armin@gmail.com
"""RQ worker: extract video frames as standalone image assets.

Unlike ``extract_frames_for_video`` (which keeps the source video alive
and writes frames under the same asset hash for the video-task editor),
this worker:

  * Creates a fresh ``Asset(kind=image)`` per extracted frame.
  * Deletes the source video Asset + MinIO object on succeeded/failed
    (with carve-outs: worker crash, disk full).
  * Reports progress + status via the RQ ``job.meta`` dict.

Strategy vocabulary mirrors ``extract_frames_for_video``:
``auto | all | every_nth | count``.
"""
from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.config import Settings
from carve_api.jobs.video_to_images_planner import (
    ExtractMode,
    compute_extraction_timestamps,
)
from carve_api.storage.client import MinioClient


log = logging.getLogger(__name__)


@dataclass
class VideoToImagesPayload:
    job_id: str
    batch_id: str
    task_id: str
    source_asset_id: str
    mode: ExtractMode
    n_or_k: int
    quality: int
    source_filename: str | None = None
    extras: dict[str, Any] = field(default_factory=dict)


def _quality_to_qv(quality: int) -> int:
    """Map 1..100 → ffmpeg ``-q:v`` (mjpeg: 1=best..31=worst)."""
    q = max(1, min(100, int(quality)))
    return max(1, min(31, round(31 - ((q - 1) / 99.0) * 30)))


@contextmanager
def _temp_video_file(mc: MinioClient, source_key: str) -> Iterator[Path]:
    tmp = Path(tempfile.mkdtemp(prefix="vti-"))
    local = tmp / "source.mp4"
    body = mc.get_object_bytes(source_key)
    local.write_bytes(body)
    try:
        yield local
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _probe(local: Path) -> tuple[int, float, float]:
    out = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_frames,r_frame_rate,duration",
            "-of",
            "default=noprint_wrappers=1:nokey=0",
            str(local),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    fields = {
        k: v
        for k, v in (
            line.split("=", 1) for line in out.stdout.strip().splitlines()
        )
    }
    nb_frames = int(fields.get("nb_frames") or 0)
    fps_expr = fields.get("r_frame_rate") or "0/0"
    num, _, den = fps_expr.partition("/")
    fps = (float(num) / float(den)) if den and float(den) != 0 else 0.0
    duration = float(fields.get("duration") or 0.0)
    return nb_frames, fps, duration


def _extract_single_frame(local: Path, ts: float, qv: int) -> bytes:
    out = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-ss",
            f"{ts:.3f}",
            "-i",
            str(local),
            "-frames:v",
            "1",
            "-q:v",
            str(qv),
            "-f",
            "image2pipe",
            "-c:v",
            "mjpeg",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    )
    return out.stdout


def _content_hash(payload: bytes) -> str:
    import xxhash
    return xxhash.xxh3_128_hexdigest(payload)


def _session_factory():
    s = Settings()
    return sessionmaker(bind=create_engine(s.database_url))


def _cancel_requested() -> bool:
    try:
        from rq import get_current_job
        job = get_current_job()
        if job is None:
            return False
        job.refresh()
        return bool(job.meta.get("cancel_requested", False))
    except Exception:
        return False


def _set_meta(updates: dict[str, Any]) -> None:
    try:
        from rq import get_current_job
        job = get_current_job()
        if job is None:
            return
        for k, v in updates.items():
            job.meta[k] = v
        job.save_meta()
    except Exception:
        return


def _last_progress() -> int:
    try:
        from rq import get_current_job
        job = get_current_job()
        if job is None:
            return 0
        job.refresh()
        return int(job.meta.get("progress", 0))
    except Exception:
        return 0


def run_video_to_images(payload: VideoToImagesPayload) -> dict[str, Any]:
    Session = _session_factory()
    mc = MinioClient()
    qv = _quality_to_qv(payload.quality)
    db = Session()
    src: Asset | None = None

    summary: dict[str, Any] = {
        "frames_extracted": 0,
        "dedup_skipped": 0,
        "error_message": None,
        "status": "running",
    }

    try:
        src = db.get(Asset, uuid.UUID(payload.source_asset_id))
        if src is None or src.kind != AssetKind.video:
            summary["status"] = "failed"
            summary["error_message"] = "source video gone"
            return summary

        _set_meta({"status": "running", "progress": 0, "frames_extracted": 0})

        source_key = f"assets/{src.xxh3_128}/source.mp4"
        with _temp_video_file(mc, source_key) as local:
            frame_count, fps, duration = _probe(local)
            if frame_count <= 0 or fps <= 0:
                summary["status"] = "failed"
                summary["error_message"] = "unreadable video"
                return summary

            timestamps = compute_extraction_timestamps(
                mode=payload.mode,
                n_or_k=payload.n_or_k,
                frame_count=frame_count,
                fps=fps,
                duration_s=duration,
            )
            target = len(timestamps)
            last_progress_push = 0.0
            source_label = payload.source_filename or src.original_name

            for i, ts in enumerate(timestamps):
                if _cancel_requested():
                    summary["status"] = "cancelled"
                    break

                jpeg = _extract_single_frame(local, ts, qv)
                h = _content_hash(jpeg)

                existing = (
                    db.query(Asset)
                    .filter(Asset.task_id == src.task_id, Asset.xxh3_128 == h)
                    .one_or_none()
                )
                if existing is not None:
                    summary["dedup_skipped"] = int(summary["dedup_skipped"]) + 1
                else:
                    new_asset = Asset(
                        id=uuid.uuid4(),
                        task_id=src.task_id,
                        kind=AssetKind.image,
                        xxh3_128=h,
                        mime="image/jpeg",
                        size_bytes=len(jpeg),
                        frames=1,
                        original_name=f"{source_label} — frame {i:05d}.jpg",
                    )
                    db.add(new_asset)
                    db.flush()
                    db.add(Frame(id=uuid.uuid4(), asset_id=new_asset.id, idx=0))
                    db.flush()
                    mc.put_object(
                        f"assets/{h}/source.jpg",
                        jpeg,
                        content_type="image/jpeg",
                    )

                summary["frames_extracted"] = i + 1

                now = time.monotonic()
                if now - last_progress_push >= 1.0 or (i + 1) == target:
                    pct = int(((i + 1) / target) * 100) if target else 100
                    _set_meta(
                        {
                            "progress": pct,
                            "frames_extracted": summary["frames_extracted"],
                            "dedup_skipped": summary["dedup_skipped"],
                        }
                    )
                    last_progress_push = now

            if summary["status"] != "cancelled":
                summary["status"] = "succeeded"

        if summary["status"] == "succeeded":
            mc.delete_object(source_key)
            db.delete(src)
        elif summary["status"] == "failed":
            mc.delete_object(source_key)
            db.delete(src)

        db.commit()
        return summary

    except OSError as exc:
        db.rollback()
        log.exception("video_to_images: environmental error (source preserved)")
        summary["status"] = "failed"
        summary["error_message"] = f"disk full or write error: {exc}"
        return summary
    except Exception as exc:
        db.rollback()
        log.exception("video_to_images: unexpected failure")
        summary["status"] = "failed"
        summary["error_message"] = str(exc)
        if src is not None:
            try:
                mc.delete_object(f"assets/{src.xxh3_128}/source.mp4")
                db.delete(src)
                db.commit()
            except Exception:
                db.rollback()
        return summary
    finally:
        _set_meta(
            {
                "status": summary["status"],
                "frames_extracted": summary["frames_extracted"],
                "dedup_skipped": summary["dedup_skipped"],
                "error_message": summary["error_message"],
                "progress": 100
                if summary["status"] in ("succeeded", "failed")
                else _last_progress(),
            }
        )
        db.close()
```

- [ ] **Step 5 — Run, expect pass**

```bash
docker compose exec api pytest tests/jobs/test_video_to_images.py -v
```

Expected: 3 passed.

- [ ] **Step 6 — Commit**

```bash
git add apps/api/src/carve_api/jobs/video_to_images.py apps/api/tests/jobs/test_video_to_images.py
git commit -m "feat(api): add video→image extraction worker"
```

---

## Task 5 — Service layer + conftest stub

**Files:**
- Create: `apps/api/src/carve_api/assets/video_extract_service.py`
- Test: `apps/api/tests/assets/test_video_extract_service.py`
- Modify: `apps/api/tests/conftest.py` (add `rq_queue_stub` fixture)

- [ ] **Step 1 — Inspect the real RQ queue helpers**

```bash
grep -nE "^def (enqueue|cancel|set_job_meta|get_job_meta|redis_client)" apps/api/src/carve_api/jobs/queue.py | head -10
```

Match the real helper names in the implementation below. If a name differs, use the real one.

- [ ] **Step 2 — Append `rq_queue_stub` to conftest**

Append to `apps/api/tests/conftest.py`:

```python
import pytest


@pytest.fixture
def rq_queue_stub(monkeypatch):
    """Replace RQ enqueue + Redis meta helpers with an in-memory recorder."""

    class _Stub:
        def __init__(self):
            self.meta: dict[str, dict] = {}
            self.enqueued_count = 0
            self.cancelled_job_ids: set[str] = set()
            self.batch_sets: dict[str, set[str]] = {}
            self.active_assets: dict[str, str] = {}

    stub = _Stub()

    def fake_enqueue_job(fn, payload, *, job_id, meta=None):
        stub.enqueued_count += 1
        stub.meta[job_id] = dict(meta or {})
        return job_id

    def fake_get_job_meta(jid):
        return dict(stub.meta.get(jid) or {})

    def fake_set_job_meta(jid, updates):
        m = stub.meta.setdefault(jid, {})
        for k, v in updates.items():
            m[k] = v
        if updates.get("cancel_requested"):
            stub.cancelled_job_ids.add(jid)

    class _FakeRedis:
        def sadd(self, key, val):
            stub.batch_sets.setdefault(key, set()).add(val)

        def smembers(self, key):
            return stub.batch_sets.get(key, set())

        def set(self, key, val, ex=None):
            stub.active_assets[key] = val

        def get(self, key):
            return stub.active_assets.get(key)

    monkeypatch.setattr(
        "carve_api.jobs.queue.enqueue_job", fake_enqueue_job, raising=False
    )
    monkeypatch.setattr(
        "carve_api.jobs.queue.get_job_meta", fake_get_job_meta, raising=False
    )
    monkeypatch.setattr(
        "carve_api.jobs.queue.set_job_meta", fake_set_job_meta, raising=False
    )
    monkeypatch.setattr(
        "carve_api.jobs.queue.redis_client", lambda: _FakeRedis(), raising=False
    )
    return stub
```

- [ ] **Step 3 — Write the failing tests**

Create `apps/api/tests/assets/test_video_extract_service.py`:

```python
import uuid as _uuid

import pytest

from carve_api.assets.models import Asset, AssetKind
from carve_api.assets.video_extract_schemas import BatchEnqueueIn
from carve_api.assets.video_extract_service import (
    VideoExtractError,
    cancel_batch,
    enqueue_batch,
    get_batch_status,
)
from carve_api.projects.models import Project, ProjectMember, Task, TaskKind


def _project_and_image_task(db_session, owner_id):
    p = Project(id=_uuid.uuid4(), name="P", owner_id=owner_id)
    db_session.add(p)
    db_session.flush()
    db_session.add(ProjectMember(project_id=p.id, user_id=owner_id, role="owner"))
    t = Task(id=_uuid.uuid4(), project_id=p.id, name="T", kind=TaskKind.image)
    db_session.add(t)
    db_session.flush()
    return p, t


def _video_asset(db_session, task_id, name="x.mp4") -> Asset:
    a = Asset(
        id=_uuid.uuid4(),
        task_id=task_id,
        kind=AssetKind.video,
        xxh3_128=_uuid.uuid4().hex,
        mime="video/mp4",
        size_bytes=10,
        frames=10,
        original_name=name,
    )
    db_session.add(a)
    db_session.flush()
    return a


def test_enqueue_happy(db_session, admin_user, rq_queue_stub) -> None:
    _, task = _project_and_image_task(db_session, admin_user.id)
    v1 = _video_asset(db_session, task.id, "a.mp4")
    v2 = _video_asset(db_session, task.id, "b.mp4")
    db_session.commit()

    payload = BatchEnqueueIn(
        source_asset_ids=[v1.id, v2.id], mode="count", n_or_k=10, quality=75
    )
    out = enqueue_batch(db_session, task=task, payload=payload)
    assert len(out.jobs) == 2
    assert {j.source_filename for j in out.jobs} == {"a.mp4", "b.mp4"}
    assert all(j.status == "queued" for j in out.jobs)
    assert rq_queue_stub.enqueued_count == 2


def test_enqueue_rejects_video_task(db_session, admin_user, rq_queue_stub) -> None:
    p = Project(id=_uuid.uuid4(), name="P", owner_id=admin_user.id)
    db_session.add(p)
    db_session.flush()
    db_session.add(ProjectMember(project_id=p.id, user_id=admin_user.id, role="owner"))
    t = Task(id=_uuid.uuid4(), project_id=p.id, name="T", kind=TaskKind.video)
    db_session.add(t)
    db_session.flush()
    v = _video_asset(db_session, t.id)
    db_session.commit()

    with pytest.raises(VideoExtractError, match="image-kind task"):
        enqueue_batch(
            db_session,
            task=t,
            payload=BatchEnqueueIn(
                source_asset_ids=[v.id], mode="auto", n_or_k=0, quality=75
            ),
        )


def test_enqueue_rejects_asset_not_in_task(db_session, admin_user, rq_queue_stub) -> None:
    _, task = _project_and_image_task(db_session, admin_user.id)
    db_session.commit()
    with pytest.raises(VideoExtractError, match="not in this task"):
        enqueue_batch(
            db_session,
            task=task,
            payload=BatchEnqueueIn(
                source_asset_ids=[_uuid.uuid4()],
                mode="auto",
                n_or_k=0,
                quality=75,
            ),
        )


def test_enqueue_rejects_image_asset(db_session, admin_user, rq_queue_stub) -> None:
    _, task = _project_and_image_task(db_session, admin_user.id)
    img = Asset(
        id=_uuid.uuid4(),
        task_id=task.id,
        kind=AssetKind.image,
        xxh3_128=_uuid.uuid4().hex,
        mime="image/jpeg",
        size_bytes=10,
        frames=1,
        original_name="x.jpg",
    )
    db_session.add(img)
    db_session.commit()
    with pytest.raises(VideoExtractError, match="not a video"):
        enqueue_batch(
            db_session,
            task=task,
            payload=BatchEnqueueIn(
                source_asset_ids=[img.id], mode="auto", n_or_k=0, quality=75
            ),
        )


def test_enqueue_rejects_concurrent(db_session, admin_user, rq_queue_stub) -> None:
    _, task = _project_and_image_task(db_session, admin_user.id)
    v = _video_asset(db_session, task.id)
    db_session.commit()

    payload = BatchEnqueueIn(
        source_asset_ids=[v.id], mode="auto", n_or_k=0, quality=75
    )
    enqueue_batch(db_session, task=task, payload=payload)
    with pytest.raises(VideoExtractError, match="already.*queued|already.*running"):
        enqueue_batch(db_session, task=task, payload=payload)


def test_get_batch_status_404(db_session, admin_user, rq_queue_stub) -> None:
    _, task = _project_and_image_task(db_session, admin_user.id)
    db_session.commit()
    with pytest.raises(VideoExtractError, match="batch.*not found"):
        get_batch_status(task=task, batch_id=_uuid.uuid4())


def test_cancel_marks_jobs(db_session, admin_user, rq_queue_stub) -> None:
    _, task = _project_and_image_task(db_session, admin_user.id)
    v = _video_asset(db_session, task.id)
    db_session.commit()
    out = enqueue_batch(
        db_session,
        task=task,
        payload=BatchEnqueueIn(
            source_asset_ids=[v.id], mode="auto", n_or_k=0, quality=75
        ),
    )
    cancel_batch(task=task, batch_id=out.batch_id)
    assert rq_queue_stub.cancelled_job_ids == {j.job_id for j in out.jobs}
```

- [ ] **Step 4 — Implement the service**

Create `apps/api/src/carve_api/assets/video_extract_service.py`:

```python
# Armin Mehri — mehri.armin@gmail.com
"""Service layer for the video→image extraction batch endpoints."""
from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from carve_api.assets.models import Asset, AssetKind
from carve_api.assets.video_extract_schemas import (
    BatchEnqueueIn,
    BatchEnqueueOut,
    BatchJobItem,
    BatchStatusOut,
)
from carve_api.jobs.queue import enqueue_job, get_job_meta, redis_client, set_job_meta
from carve_api.jobs.video_to_images import VideoToImagesPayload, run_video_to_images
from carve_api.projects.models import Task, TaskKind


_BATCH_SET_KEY = "videoextract:batch:{batch_id}"
_ACTIVE_ASSET_KEY = "videoextract:asset:{asset_id}"


class VideoExtractError(Exception):
    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


def enqueue_batch(
    db: Session, *, task: Task, payload: BatchEnqueueIn
) -> BatchEnqueueOut:
    if task.kind != TaskKind.image:
        raise VideoExtractError("must be invoked on an image-kind task")

    assets = (
        db.query(Asset)
        .filter(Asset.id.in_(payload.source_asset_ids))
        .all()
    )
    by_id = {a.id: a for a in assets}
    for src_id in payload.source_asset_ids:
        a = by_id.get(src_id)
        if a is None or a.task_id != task.id:
            raise VideoExtractError(f"asset {src_id} not in this task")
        if a.kind != AssetKind.video:
            raise VideoExtractError(f"asset {src_id} is not a video")
        if _is_in_active_extraction(a.id):
            raise VideoExtractError(
                f"asset {src_id} already queued/running",
                status_code=409,
            )

    batch_id = uuid.uuid4()
    items: list[BatchJobItem] = []
    for src_id in payload.source_asset_ids:
        a = by_id[src_id]
        job_id = f"vti-{uuid.uuid4()}"
        vti_payload = VideoToImagesPayload(
            job_id=job_id,
            batch_id=str(batch_id),
            task_id=str(task.id),
            source_asset_id=str(src_id),
            mode=payload.mode,
            n_or_k=payload.n_or_k,
            quality=payload.quality,
            source_filename=a.original_name,
        )
        enqueue_job(
            run_video_to_images,
            vti_payload,
            job_id=job_id,
            meta={
                "batch_id": str(batch_id),
                "task_id": str(task.id),
                "source_asset_id": str(src_id),
                "source_filename": a.original_name,
                "status": "queued",
                "progress": 0,
                "frames_extracted": 0,
                "dedup_skipped": 0,
                "error_message": None,
                "cancel_requested": False,
                "kind": "video_extract_to_images",
            },
        )
        _add_to_batch_set(batch_id, job_id)
        _mark_asset_active(a.id, job_id)
        items.append(
            BatchJobItem(
                job_id=job_id,
                source_asset_id=src_id,
                source_filename=a.original_name,
                status="queued",
                progress=0,
                frames_extracted=0,
                dedup_skipped=0,
                error_message=None,
            )
        )
    return BatchEnqueueOut(batch_id=batch_id, jobs=items)


def get_batch_status(*, task: Task, batch_id: uuid.UUID) -> BatchStatusOut:
    job_ids = _batch_job_ids(batch_id)
    if not job_ids:
        raise VideoExtractError("batch not found", status_code=404)
    items: list[BatchJobItem] = []
    for jid in job_ids:
        meta = get_job_meta(jid) or {}
        items.append(
            BatchJobItem(
                job_id=jid,
                source_asset_id=uuid.UUID(meta["source_asset_id"]),
                source_filename=meta.get("source_filename") or "",
                status=meta.get("status", "queued"),
                progress=int(meta.get("progress", 0)),
                frames_extracted=int(meta.get("frames_extracted", 0)),
                dedup_skipped=int(meta.get("dedup_skipped", 0)),
                error_message=meta.get("error_message"),
            )
        )
    return BatchStatusOut(batch_id=batch_id, jobs=items)


def cancel_batch(*, task: Task, batch_id: uuid.UUID) -> None:
    job_ids = _batch_job_ids(batch_id)
    if not job_ids:
        raise VideoExtractError("batch not found", status_code=404)
    for jid in job_ids:
        meta = get_job_meta(jid) or {}
        if meta.get("status") in ("succeeded", "failed", "cancelled"):
            continue
        set_job_meta(jid, {"cancel_requested": True})
        if meta.get("status") == "queued":
            set_job_meta(jid, {"status": "cancelled"})


def _batch_set_key(batch_id: uuid.UUID) -> str:
    return _BATCH_SET_KEY.format(batch_id=batch_id)


def _add_to_batch_set(batch_id: uuid.UUID, job_id: str) -> None:
    redis_client().sadd(_batch_set_key(batch_id), job_id)


def _batch_job_ids(batch_id: uuid.UUID) -> list[str]:
    members = redis_client().smembers(_batch_set_key(batch_id))
    return sorted(m.decode() if isinstance(m, bytes) else m for m in members)


def _mark_asset_active(asset_id: uuid.UUID, job_id: str) -> None:
    redis_client().set(_ACTIVE_ASSET_KEY.format(asset_id=asset_id), job_id, ex=3600)


def _is_in_active_extraction(asset_id: uuid.UUID) -> bool:
    return bool(
        redis_client().get(_ACTIVE_ASSET_KEY.format(asset_id=asset_id))
    )
```

- [ ] **Step 5 — Run, expect pass**

```bash
docker compose exec api pytest tests/assets/test_video_extract_service.py -v
```

Expected: 7 passed.

- [ ] **Step 6 — Commit**

```bash
git add apps/api/src/carve_api/assets/video_extract_service.py apps/api/tests/assets/test_video_extract_service.py apps/api/tests/conftest.py
git commit -m "feat(api): add service layer for video-extract batch enqueue/status/cancel"
```

---

## Task 6 — HTTP endpoints

**Files:**
- Modify: `apps/api/src/carve_api/projects/router.py` (placing the new endpoints next to the existing task-scoped routes, mirroring the resume endpoint added in commit `6cc1d66`)
- Test: `apps/api/tests/assets/test_video_extract_router.py`

- [ ] **Step 1 — Write the failing tests**

Create `apps/api/tests/assets/test_video_extract_router.py`:

```python
import uuid as _uuid

from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(t):
    return {"Authorization": f"Bearer {t}"}


def _register(client, email):
    client.post("/auth/register", json={"email": email, "password": "hunter22"})
    return client.post(
        "/auth/login", json={"email": email, "password": "hunter22"}
    ).json()["access_token"]


def _make_image_task(client, token):
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    return pid, tid


def test_enqueue_returns_202(db_session, rq_queue_stub) -> None:
    client = _client(db_session)
    token = _register(client, "vea@x.com")
    pid, tid = _make_image_task(client, token)
    from carve_api.assets.models import Asset, AssetKind

    a = Asset(
        id=_uuid.uuid4(),
        task_id=_uuid.UUID(tid),
        kind=AssetKind.video,
        xxh3_128=_uuid.uuid4().hex,
        mime="video/mp4",
        size_bytes=10,
        frames=10,
        original_name="x.mp4",
    )
    db_session.add(a)
    db_session.commit()

    r = client.post(
        f"/projects/{pid}/tasks/{tid}/video-extract/batch",
        json={
            "source_asset_ids": [str(a.id)],
            "mode": "auto",
            "n_or_k": 0,
            "quality": 75,
        },
        headers=_hdr(token),
    )
    assert r.status_code == 202, r.text
    body = r.json()
    assert "batch_id" in body
    assert len(body["jobs"]) == 1
    assert body["jobs"][0]["source_filename"] == "x.mp4"


def test_enqueue_requires_auth(db_session) -> None:
    client = _client(db_session)
    r = client.post(
        f"/projects/{_uuid.uuid4()}/tasks/{_uuid.uuid4()}/video-extract/batch",
        json={
            "source_asset_ids": [str(_uuid.uuid4())],
            "mode": "auto",
            "n_or_k": 0,
            "quality": 75,
        },
    )
    assert r.status_code == 401


def test_enqueue_rejects_video_task(db_session, rq_queue_stub) -> None:
    client = _client(db_session)
    token = _register(client, "veavid@x.com")
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "video"},
        headers=_hdr(token),
    ).json()["id"]
    r = client.post(
        f"/projects/{pid}/tasks/{tid}/video-extract/batch",
        json={
            "source_asset_ids": [str(_uuid.uuid4())],
            "mode": "auto",
            "n_or_k": 0,
            "quality": 75,
        },
        headers=_hdr(token),
    )
    assert r.status_code == 422


def test_status_404_for_unknown_batch(db_session, rq_queue_stub) -> None:
    client = _client(db_session)
    token = _register(client, "veast@x.com")
    pid, tid = _make_image_task(client, token)
    r = client.get(
        f"/projects/{pid}/tasks/{tid}/video-extract/batch/{_uuid.uuid4()}",
        headers=_hdr(token),
    )
    assert r.status_code == 404


def test_cancel_marks_jobs(db_session, rq_queue_stub) -> None:
    client = _client(db_session)
    token = _register(client, "veac@x.com")
    pid, tid = _make_image_task(client, token)
    from carve_api.assets.models import Asset, AssetKind

    a = Asset(
        id=_uuid.uuid4(),
        task_id=_uuid.UUID(tid),
        kind=AssetKind.video,
        xxh3_128=_uuid.uuid4().hex,
        mime="video/mp4",
        size_bytes=10,
        frames=10,
        original_name="x.mp4",
    )
    db_session.add(a)
    db_session.commit()

    enq = client.post(
        f"/projects/{pid}/tasks/{tid}/video-extract/batch",
        json={
            "source_asset_ids": [str(a.id)],
            "mode": "auto",
            "n_or_k": 0,
            "quality": 75,
        },
        headers=_hdr(token),
    ).json()
    batch_id = enq["batch_id"]

    r = client.post(
        f"/projects/{pid}/tasks/{tid}/video-extract/batch/{batch_id}/cancel",
        headers=_hdr(token),
    )
    assert r.status_code == 204
    assert rq_queue_stub.cancelled_job_ids
```

- [ ] **Step 2 — Run, verify failure**

```bash
docker compose exec api pytest tests/assets/test_video_extract_router.py -v
```

Expected: 404 / not-found errors.

- [ ] **Step 3 — Add the three routes to `projects/router.py`**

Add these imports near the existing import block:

```python
from carve_api.assets.video_extract_schemas import (
    BatchEnqueueIn,
    BatchEnqueueOut,
    BatchStatusOut,
)
from carve_api.assets.video_extract_service import (
    VideoExtractError,
    cancel_batch,
    enqueue_batch,
    get_batch_status,
)
```

(Skip whichever symbols are already imported — do not duplicate.)

Then append, immediately after the `task_resume` route (whichever existing function is the closest precedent for project-task-scoped routes):

```python
def _http_for_video_extract_error(exc: VideoExtractError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


@router.post(
    "/{project_id}/tasks/{task_id}/video-extract/batch",
    response_model=BatchEnqueueOut,
    status_code=202,
)
def enqueue_video_extract_batch(
    project_id: uuid.UUID,
    task_id: uuid.UUID,
    payload: BatchEnqueueIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> BatchEnqueueOut:
    try:
        project = ProjectService(db).get(actor=user, project_id=project_id)
        task = TaskService(db).get(project=project, task_id=task_id)
        return enqueue_batch(db, task=task, payload=payload)
    except AppError as exc:
        raise _http(exc) from exc
    except VideoExtractError as exc:
        raise _http_for_video_extract_error(exc) from exc


@router.get(
    "/{project_id}/tasks/{task_id}/video-extract/batch/{batch_id}",
    response_model=BatchStatusOut,
)
def get_video_extract_batch_status(
    project_id: uuid.UUID,
    task_id: uuid.UUID,
    batch_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> BatchStatusOut:
    try:
        project = ProjectService(db).get(actor=user, project_id=project_id)
        task = TaskService(db).get(project=project, task_id=task_id)
        return get_batch_status(task=task, batch_id=batch_id)
    except AppError as exc:
        raise _http(exc) from exc
    except VideoExtractError as exc:
        raise _http_for_video_extract_error(exc) from exc


@router.post(
    "/{project_id}/tasks/{task_id}/video-extract/batch/{batch_id}/cancel",
    status_code=204,
)
def cancel_video_extract_batch(
    project_id: uuid.UUID,
    task_id: uuid.UUID,
    batch_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    try:
        project = ProjectService(db).get(actor=user, project_id=project_id)
        task = TaskService(db).get(project=project, task_id=task_id)
        cancel_batch(task=task, batch_id=batch_id)
    except AppError as exc:
        raise _http(exc) from exc
    except VideoExtractError as exc:
        raise _http_for_video_extract_error(exc) from exc
```

> The existing `task_resume` and `task_completion_status` functions are the closest precedents for shape and auth — mirror them. **Use `require_project_role` if the file uses that helper for membership enforcement** (the resume endpoint in commit `6cc1d66` does so to make the 403 path work).

- [ ] **Step 4 — Run, expect pass**

```bash
docker compose exec api pytest tests/assets/test_video_extract_router.py -v
```

Expected: 5 passed.

- [ ] **Step 5 — Commit**

```bash
git add apps/api/src/carve_api/projects/router.py apps/api/tests/assets/test_video_extract_router.py
git commit -m "feat(api): add HTTP endpoints for video-extract batches"
```

---

## Task 7 — Frontend API client

**Files:**
- Create: `apps/web/src/api/video_extract.ts`

- [ ] **Step 1 — Implement**

Create `apps/web/src/api/video_extract.ts`:

```typescript
// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export type ExtractMode = "auto" | "all" | "every_nth" | "count";
export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface BatchEnqueueIn {
  source_asset_ids: string[];
  mode: ExtractMode;
  n_or_k: number;
  quality: number;
}

export interface BatchJobItem {
  job_id: string;
  source_asset_id: string;
  source_filename: string;
  status: JobStatus;
  progress: number;
  frames_extracted: number;
  dedup_skipped: number;
  error_message: string | null;
}

export interface BatchEnvelope {
  batch_id: string;
  jobs: BatchJobItem[];
}

export const videoExtractApi = {
  enqueueBatch: async (
    projectId: string,
    taskId: string,
    body: BatchEnqueueIn,
  ): Promise<BatchEnvelope> =>
    (
      await api.post<BatchEnvelope>(
        `/projects/${projectId}/tasks/${taskId}/video-extract/batch`,
        body,
      )
    ).data,
  getBatchStatus: async (
    projectId: string,
    taskId: string,
    batchId: string,
  ): Promise<BatchEnvelope> =>
    (
      await api.get<BatchEnvelope>(
        `/projects/${projectId}/tasks/${taskId}/video-extract/batch/${batchId}`,
      )
    ).data,
  cancelBatch: async (
    projectId: string,
    taskId: string,
    batchId: string,
  ): Promise<void> => {
    await api.post(
      `/projects/${projectId}/tasks/${taskId}/video-extract/batch/${batchId}/cancel`,
    );
  },
};
```

- [ ] **Step 2 — Type-check**

```bash
pnpm --filter carve-web exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 3 — Commit**

```bash
git add apps/web/src/api/video_extract.ts
git commit -m "feat(web): add video-extract batch client"
```

---

## Task 8 — `useVideoExtractBatch` hook

**Files:**
- Create: `apps/web/src/hooks/useVideoExtractBatch.ts`

- [ ] **Step 1 — Implement**

Create `apps/web/src/hooks/useVideoExtractBatch.ts`:

```typescript
// Armin Mehri — mehri.armin@gmail.com
import { useQuery } from "@tanstack/react-query";

import { videoExtractApi, type BatchEnvelope } from "../api/video_extract";

export function useVideoExtractBatch(
  projectId: string | undefined,
  taskId: string | undefined,
  batchId: string | undefined,
) {
  return useQuery<BatchEnvelope>({
    queryKey: ["video-extract-batch", projectId, taskId, batchId] as const,
    queryFn: () =>
      videoExtractApi.getBatchStatus(projectId!, taskId!, batchId!),
    enabled: Boolean(projectId) && Boolean(taskId) && Boolean(batchId),
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return 2000;
      const allTerminal = data.jobs.every((j) =>
        ["succeeded", "failed", "cancelled"].includes(j.status),
      );
      return allTerminal ? false : 2000;
    },
    refetchOnWindowFocus: false,
  });
}
```

> If the project has a realtime WS hook for jobs (search `apps/web/src/realtime/` if it exists), add a `useEffect` that calls `queryClient.invalidateQueries(["video-extract-batch", projectId, taskId, batchId])` on each `job_updated` event scoped to a job in this batch. If no such hook exists, the 2s poll is sufficient — leave a `// TODO(realtime)` comment with the exact follow-up.

- [ ] **Step 2 — Type-check**

```bash
pnpm --filter carve-web exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 3 — Commit**

```bash
git add apps/web/src/hooks/useVideoExtractBatch.ts
git commit -m "feat(web): add useVideoExtractBatch hook (2s poll fallback)"
```

---

## Task 9 — `<VideoExtractParamsStep />`

**Files:**
- Create: `apps/web/src/components/annotation/VideoExtractParamsStep.tsx`
- Test: `apps/web/src/components/annotation/__tests__/VideoExtractParamsStep.test.tsx`

- [ ] **Step 1 — Write the failing tests**

Create `apps/web/src/components/annotation/__tests__/VideoExtractParamsStep.test.tsx`:

```typescript
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { VideoExtractParamsStep } from "../VideoExtractParamsStep";

describe("<VideoExtractParamsStep />", () => {
  function makeProps(overrides = {}) {
    return {
      videoCount: 3,
      defaultMode: "count" as const,
      defaultK: 500,
      defaultQuality: 75,
      onCancel: vi.fn(),
      onBack: vi.fn(),
      onContinue: vi.fn(),
      ...overrides,
    };
  }

  it("renders the screenshot's modes and the K input for the default selection", () => {
    render(<VideoExtractParamsStep {...makeProps()} />);
    expect(screen.getByText(/3 videos detected/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Auto/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/All frames/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Every N-th frame/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Total of K frames \(smart\)/i)).toBeChecked();
    expect(screen.getByLabelText(/K \(total frames\)/i)).toHaveValue(500);
    expect(screen.getByText(/75 \/ 100/)).toBeInTheDocument();
  });

  it("Continue emits the selected mode + numeric K and quality", () => {
    const onContinue = vi.fn();
    render(<VideoExtractParamsStep {...makeProps({ onContinue })} />);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(onContinue).toHaveBeenCalledWith({
      mode: "count",
      n_or_k: 500,
      quality: 75,
    });
  });

  it("switching to Every N-th replaces the K input with an N input", () => {
    render(<VideoExtractParamsStep {...makeProps()} />);
    fireEvent.click(screen.getByLabelText(/Every N-th frame/i));
    expect(screen.queryByLabelText(/K \(total frames\)/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/N \(step\)/i)).toBeInTheDocument();
  });

  it("Auto and All hide both N and K inputs", () => {
    render(<VideoExtractParamsStep {...makeProps()} />);
    fireEvent.click(screen.getByLabelText(/Auto/i));
    expect(screen.queryByLabelText(/K \(total frames\)/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/N \(step\)/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/All frames/i));
    expect(screen.queryByLabelText(/K \(total frames\)/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/N \(step\)/i)).not.toBeInTheDocument();
  });

  it("disables Continue if K is non-positive in count mode", () => {
    render(<VideoExtractParamsStep {...makeProps({ defaultK: 0 })} />);
    expect(
      screen.getByRole("button", { name: /continue/i }),
    ).toBeDisabled();
  });

  it("Back and Cancel invoke their callbacks", () => {
    const onBack = vi.fn();
    const onCancel = vi.fn();
    render(<VideoExtractParamsStep {...makeProps({ onBack, onCancel })} />);
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("singular header when videoCount = 1", () => {
    render(<VideoExtractParamsStep {...makeProps({ videoCount: 1 })} />);
    expect(screen.getByText(/1 video detected/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2 — Run, verify failure**

```bash
pnpm --filter carve-web exec vitest run src/components/annotation/__tests__/VideoExtractParamsStep.test.tsx
```

Expected: module not found.

- [ ] **Step 3 — Implement**

Create `apps/web/src/components/annotation/VideoExtractParamsStep.tsx`:

```typescript
// Armin Mehri — mehri.armin@gmail.com
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import type { ExtractMode } from "../../api/video_extract";

interface Props {
  videoCount: number;
  defaultMode?: ExtractMode;
  defaultK?: number;
  defaultN?: number;
  defaultQuality?: number;
  onCancel: () => void;
  onBack: () => void;
  onContinue: (params: {
    mode: ExtractMode;
    n_or_k: number;
    quality: number;
  }) => void;
}

const MODES: { value: ExtractMode; label: string; help: string }[] = [
  {
    value: "auto",
    label: "Auto",
    help: "Caps at ~500 frames; downsamples long videos.",
  },
  {
    value: "all",
    label: "All frames",
    help: "Every frame. Most accurate; biggest storage.",
  },
  {
    value: "every_nth",
    label: "Every N-th frame",
    help: "Skip in steps. Good for high-fps videos.",
  },
  {
    value: "count",
    label: "Total of K frames (smart)",
    help: "Evenly spaced K frames across the video.",
  },
];

export function VideoExtractParamsStep({
  videoCount,
  defaultMode = "count",
  defaultK = 500,
  defaultN = 5,
  defaultQuality = 75,
  onCancel,
  onBack,
  onContinue,
}: Props) {
  const [mode, setMode] = useState<ExtractMode>(defaultMode);
  const [k, setK] = useState<number>(defaultK);
  const [n, setN] = useState<number>(defaultN);
  const [quality, setQuality] = useState<number>(defaultQuality);

  const numericValue = mode === "count" ? k : mode === "every_nth" ? n : 0;
  const canContinue = useMemo(() => {
    if (mode === "auto" || mode === "all") return true;
    return Number.isFinite(numericValue) && numericValue > 0;
  }, [mode, numericValue]);

  const headerNoun = videoCount === 1 ? "video detected" : "videos detected";

  return (
    <div data-testid="video-extract-params-step" className="flex flex-col gap-4">
      <p className="text-[13px] text-[color:var(--text-secondary)]">
        {videoCount} {headerNoun} — pick how many frames to extract. The same
        setting applies to every video.
      </p>

      <fieldset className="flex flex-col gap-2" aria-label="Extraction mode">
        {MODES.map((opt) => (
          <label
            key={opt.value}
            className={
              "flex items-start gap-2 rounded-[var(--radius-sm)] border px-3 py-2 cursor-pointer " +
              (mode === opt.value
                ? "border-[var(--accent)] bg-[color-mix(in_oklch,var(--accent)_8%,transparent)]"
                : "border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]")
            }
          >
            <input
              type="radio"
              name="mode"
              value={opt.value}
              checked={mode === opt.value}
              onChange={() => setMode(opt.value)}
              className="mt-1"
            />
            <span className="flex flex-col">
              <span className="text-[13px] font-medium text-[color:var(--text-primary)]">
                {opt.label}
              </span>
              <span className="text-[12px] text-[color:var(--text-tertiary)]">
                {opt.help}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {mode === "count" && (
        <label className="flex flex-col gap-1 text-[12px]">
          <span>K (total frames):</span>
          <input
            type="number"
            min={1}
            value={k}
            onChange={(e) => setK(parseInt(e.target.value, 10) || 0)}
            aria-label="K (total frames)"
            className="h-8 w-32 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] px-2 text-[13px]"
          />
        </label>
      )}
      {mode === "every_nth" && (
        <label className="flex flex-col gap-1 text-[12px]">
          <span>N (step):</span>
          <input
            type="number"
            min={1}
            value={n}
            onChange={(e) => setN(parseInt(e.target.value, 10) || 0)}
            aria-label="N (step)"
            className="h-8 w-32 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] px-2 text-[13px]"
          />
        </label>
      )}

      <label className="flex flex-col gap-1 text-[12px]">
        <span className="flex items-center justify-between">
          <span>Quality</span>
          <span className="font-mono tabular-nums text-[color:var(--text-tertiary)]">
            {quality} / 100
          </span>
        </span>
        <input
          type="range"
          min={1}
          max={100}
          step={1}
          value={quality}
          onChange={(e) => setQuality(parseInt(e.target.value, 10))}
          aria-label="Quality"
          className="w-full"
        />
      </label>

      <div className="mt-2 flex items-center justify-between gap-2">
        <Button variant="secondary" onClick={onBack}>
          ← Back
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!canContinue}
            onClick={() =>
              onContinue({
                mode,
                n_or_k:
                  mode === "auto" || mode === "all" ? 0 : numericValue,
                quality,
              })
            }
          >
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4 — Run, expect pass**

```bash
pnpm --filter carve-web exec vitest run src/components/annotation/__tests__/VideoExtractParamsStep.test.tsx
```

Expected: 7 passed.

- [ ] **Step 5 — Commit**

```bash
git add apps/web/src/components/annotation/VideoExtractParamsStep.tsx apps/web/src/components/annotation/__tests__/VideoExtractParamsStep.test.tsx
git commit -m "feat(web): add VideoExtractParamsStep (mode + K/N + quality form)"
```

---

## Task 10 — `<VideoExtractProgressDialog />`

**Files:**
- Create: `apps/web/src/components/annotation/VideoExtractProgressDialog.tsx`
- Test: `apps/web/src/components/annotation/__tests__/VideoExtractProgressDialog.test.tsx`

- [ ] **Step 1 — Write the failing tests**

Create `apps/web/src/components/annotation/__tests__/VideoExtractProgressDialog.test.tsx`:

```typescript
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { VideoExtractProgressDialog } from "../VideoExtractProgressDialog";

const mockGetBatchStatus = vi.fn();
const mockCancelBatch = vi.fn();

vi.mock("../../../api/video_extract", () => ({
  videoExtractApi: {
    getBatchStatus: (...args: unknown[]) => mockGetBatchStatus(...args),
    cancelBatch: (...args: unknown[]) => mockCancelBatch(...args),
  },
}));

function withClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  mockGetBatchStatus.mockReset();
  mockCancelBatch.mockReset();
});

describe("<VideoExtractProgressDialog />", () => {
  it("renders per-video rows with progress and overall bar", async () => {
    mockGetBatchStatus.mockResolvedValue({
      batch_id: "b1",
      jobs: [
        {
          job_id: "j1",
          source_asset_id: "a1",
          source_filename: "race.mp4",
          status: "running",
          progress: 50,
          frames_extracted: 250,
          dedup_skipped: 0,
          error_message: null,
        },
        {
          job_id: "j2",
          source_asset_id: "a2",
          source_filename: "lap2.mp4",
          status: "queued",
          progress: 0,
          frames_extracted: 0,
          dedup_skipped: 0,
          error_message: null,
        },
      ],
    });

    render(
      withClient(
        <VideoExtractProgressDialog
          projectId="p1"
          taskId="t1"
          batchId="b1"
          onBackground={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );

    expect(await screen.findByText("race.mp4")).toBeInTheDocument();
    expect(screen.getByText("lap2.mp4")).toBeInTheDocument();
    expect(screen.getByTestId("video-extract-overall")).toHaveTextContent(/25%/);
  });

  it("Run in background calls onBackground", async () => {
    mockGetBatchStatus.mockResolvedValue({ batch_id: "b1", jobs: [] });
    const onBackground = vi.fn();
    render(
      withClient(
        <VideoExtractProgressDialog
          projectId="p1"
          taskId="t1"
          batchId="b1"
          onBackground={onBackground}
          onClose={() => undefined}
        />,
      ),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /run in background/i }),
    );
    expect(onBackground).toHaveBeenCalledOnce();
  });

  it("Cancel calls cancelBatch", async () => {
    mockGetBatchStatus.mockResolvedValue({
      batch_id: "b1",
      jobs: [
        {
          job_id: "j1",
          source_asset_id: "a1",
          source_filename: "race.mp4",
          status: "running",
          progress: 10,
          frames_extracted: 50,
          dedup_skipped: 0,
          error_message: null,
        },
      ],
    });
    render(
      withClient(
        <VideoExtractProgressDialog
          projectId="p1"
          taskId="t1"
          batchId="b1"
          onBackground={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );
    await screen.findByText("race.mp4");
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(mockCancelBatch).toHaveBeenCalledWith("p1", "t1", "b1");
  });

  it("shows failure badge for failed jobs", async () => {
    mockGetBatchStatus.mockResolvedValue({
      batch_id: "b1",
      jobs: [
        {
          job_id: "j1",
          source_asset_id: "a1",
          source_filename: "corrupt.mp4",
          status: "failed",
          progress: 0,
          frames_extracted: 0,
          dedup_skipped: 0,
          error_message: "unreadable video",
        },
      ],
    });
    render(
      withClient(
        <VideoExtractProgressDialog
          projectId="p1"
          taskId="t1"
          batchId="b1"
          onBackground={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );
    expect(await screen.findByText(/failed/i)).toBeInTheDocument();
    expect(screen.getByText("corrupt.mp4")).toBeInTheDocument();
  });

  it("auto-closes shortly after terminal-all", async () => {
    vi.useFakeTimers();
    mockGetBatchStatus.mockResolvedValue({
      batch_id: "b1",
      jobs: [
        {
          job_id: "j1",
          source_asset_id: "a1",
          source_filename: "race.mp4",
          status: "succeeded",
          progress: 100,
          frames_extracted: 500,
          dedup_skipped: 0,
          error_message: null,
        },
      ],
    });
    const onClose = vi.fn();
    render(
      withClient(
        <VideoExtractProgressDialog
          projectId="p1"
          taskId="t1"
          batchId="b1"
          onBackground={() => undefined}
          onClose={onClose}
        />,
      ),
    );
    await screen.findByText("race.mp4");
    vi.advanceTimersByTime(1500);
    expect(onClose).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2 — Run, verify failure**

```bash
pnpm --filter carve-web exec vitest run src/components/annotation/__tests__/VideoExtractProgressDialog.test.tsx
```

Expected: module not found.

- [ ] **Step 3 — Implement**

Create `apps/web/src/components/annotation/VideoExtractProgressDialog.tsx`:

```typescript
// Armin Mehri — mehri.armin@gmail.com
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";

import { useVideoExtractBatch } from "../../hooks/useVideoExtractBatch";
import {
  videoExtractApi,
  type BatchJobItem,
} from "../../api/video_extract";

interface Props {
  projectId: string;
  taskId: string;
  batchId: string;
  onBackground: () => void;
  onClose: () => void;
}

function rowStatusLabel(j: BatchJobItem): string {
  switch (j.status) {
    case "queued":
      return "queued";
    case "running":
      return `${j.frames_extracted} extracted`;
    case "succeeded":
      return `${j.frames_extracted} extracted ✓`;
    case "failed":
      return `failed — ${j.error_message ?? "unknown"}`;
    case "cancelled":
      return "cancelled";
  }
}

export function VideoExtractProgressDialog({
  projectId,
  taskId,
  batchId,
  onBackground,
  onClose,
}: Props) {
  const q = useVideoExtractBatch(projectId, taskId, batchId);
  const qc = useQueryClient();

  const jobs = q.data?.jobs ?? [];
  const overall =
    jobs.length === 0
      ? 0
      : Math.round(jobs.reduce((acc, j) => acc + j.progress, 0) / jobs.length);
  const allTerminal =
    jobs.length > 0 &&
    jobs.every((j) =>
      ["succeeded", "failed", "cancelled"].includes(j.status),
    );

  useEffect(() => {
    if (!allTerminal) return;
    const id = setTimeout(() => onClose(), 1200);
    return () => clearTimeout(id);
  }, [allTerminal, onClose]);

  async function handleCancel() {
    await videoExtractApi.cancelBatch(projectId, taskId, batchId);
    qc.invalidateQueries({
      queryKey: ["video-extract-batch", projectId, taskId, batchId],
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onBackground()}>
      <DialogContent
        data-testid="video-extract-progress-dialog"
        className="w-[min(92vw,560px)]"
      >
        <DialogHeader>
          <DialogTitle>Extracting frames</DialogTitle>
          <DialogDescription>
            <span data-testid="video-extract-overall">Overall {overall}%</span>
            <span className="ml-2 text-[color:var(--text-tertiary)]">
              ({jobs.filter((j) => j.status === "succeeded").length} of{" "}
              {jobs.length} done)
            </span>
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          {jobs.map((j) => (
            <li
              key={j.job_id}
              className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] px-3 py-2"
              data-testid={`video-extract-row-${j.job_id}`}
            >
              <span className="truncate text-[13px] text-[color:var(--text-primary)]">
                {j.source_filename}
              </span>
              <span className="font-mono tabular-nums text-[12px] text-[color:var(--text-tertiary)]">
                {j.progress}%
              </span>
              <div className="col-span-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg-subtle)]">
                <div
                  className={
                    j.status === "failed"
                      ? "h-full bg-[var(--danger)]"
                      : j.status === "succeeded"
                        ? "h-full bg-[var(--success)]"
                        : "h-full bg-[var(--accent)]"
                  }
                  style={{ width: `${j.progress}%` }}
                />
              </div>
              <span className="col-span-2 text-[11px] text-[color:var(--text-tertiary)]">
                {rowStatusLabel(j)}
              </span>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="secondary" onClick={onBackground}>
            Run in background
          </Button>
          <Button variant="danger" onClick={handleCancel} disabled={allTerminal}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4 — Run, expect pass**

```bash
pnpm --filter carve-web exec vitest run src/components/annotation/__tests__/VideoExtractProgressDialog.test.tsx
```

Expected: 5 passed.

- [ ] **Step 5 — Commit**

```bash
git add apps/web/src/components/annotation/VideoExtractProgressDialog.tsx apps/web/src/components/annotation/__tests__/VideoExtractProgressDialog.test.tsx
git commit -m "feat(web): add VideoExtractProgressDialog with per-video bars + cancel"
```

---

## Task 11 — Wire into `AssetUploadDialog`

**Files:**
- Modify: `apps/web/src/components/annotation/AssetUploadDialog.tsx`

- [ ] **Step 1 — Locate the dialog's step machine**

```bash
grep -nE "useState|setStep|wizard|pickFiles|step\\s*=" apps/web/src/components/annotation/AssetUploadDialog.tsx | head -20
```

Identify how the dialog currently progresses between pick-files and the upload action. We insert two new step values between them.

- [ ] **Step 2 — Add helper above the component**

Near the top of `AssetUploadDialog.tsx`, add:

```typescript
const VIDEO_MIME_PREFIX = "video/";

function pickVideos(files: File[]): File[] {
  return files.filter((f) => f.type.startsWith(VIDEO_MIME_PREFIX));
}
function pickImages(files: File[]): File[] {
  return files.filter((f) => !f.type.startsWith(VIDEO_MIME_PREFIX));
}
```

- [ ] **Step 3 — Insert the new wizard steps**

Walk through the existing step machine and add two new state values: `"extract-params"` and `"extract-progress"`. The flow becomes:

```
pick-files
  → (if any videos) extract-params → confirm → upload-and-extract → extract-progress → done
  → (else)                           confirm → upload                                → done
```

Implementation notes:

- After file pick, if `pickVideos(files).length > 0`, advance to `extract-params`. Otherwise advance to the existing confirm step.
- After Continue on `extract-params`, render the **Confirm** step with the summary text from the spec:
  > Upload **N images** now. Extract frames from **K videos** with **<mode label> / quality <quality>**. The original videos will be deleted after extraction.
- After Upload on Confirm:
  1. Upload images via the existing path.
  2. Upload videos via the existing path (they become `kind=video` Asset rows).
  3. Call `videoExtractApi.enqueueBatch(projectId, taskId, { source_asset_ids: <uploaded video ids>, mode, n_or_k, quality })`.
  4. Store `batch_id` in state and switch step to `extract-progress`.
- Render `<VideoExtractProgressDialog>` when step is `extract-progress`. `onBackground` closes the upload dialog (the BackgroundJobsBar entry handles re-open). `onClose` shows the completion toast, invalidates the task asset list, and closes.

> Do NOT refactor unrelated upload state. Add the minimum needed for the two new step values.

- [ ] **Step 4 — Add the completion toast picker**

Add this helper inside the dialog file:

```typescript
import type { BatchEnvelope } from "../../api/video_extract";

function buildCompletionToast(
  newImagesCount: number,
  env: BatchEnvelope,
): { variant: "success" | "warning" | "error"; message: string } | null {
  const total = env.jobs.length;
  if (total === 0) return null;
  const succeeded = env.jobs.filter((j) => j.status === "succeeded");
  const failed = env.jobs.filter((j) => j.status === "failed");
  const cancelled = env.jobs.filter((j) => j.status === "cancelled");
  if (cancelled.length === total) return null;
  if (failed.length === total) {
    return {
      variant: "error",
      message: `Frame extraction failed for all ${total} videos.`,
    };
  }
  if (failed.length > 0) {
    const names = failed.map((j) => j.source_filename).join(", ");
    return {
      variant: "warning",
      message: `Added ${newImagesCount} images (${succeeded.length} video extraction${succeeded.length === 1 ? "" : "s"}). ${failed.length} video${failed.length === 1 ? "" : "s"} failed and ${failed.length === 1 ? "was" : "were"} skipped: ${names}.`,
    };
  }
  return {
    variant: "success",
    message: `Added ${newImagesCount} images (${succeeded.length} video extraction${succeeded.length === 1 ? "" : "s"}).`,
  };
}
```

Call it on `onClose` from the progress dialog, using the latest `env` from `useVideoExtractBatch`.

- [ ] **Step 5 — Type-check + existing tests**

```bash
pnpm --filter carve-web exec tsc --noEmit
pnpm --filter carve-web exec vitest run src/components/annotation
```

Expected: tsc clean; all annotation-component tests still green.

- [ ] **Step 6 — Commit**

```bash
git add apps/web/src/components/annotation/AssetUploadDialog.tsx
git commit -m "feat(web): insert extract-params + progress steps into AssetUploadDialog"
```

---

## Task 12 — `BackgroundJobsBar` label + reopen

**Files:**
- Modify: `apps/web/src/components/BackgroundJobsBar.tsx`

- [ ] **Step 1 — Find the kind → label/icon map**

```bash
grep -nE "kind|label|icon|switch" apps/web/src/components/BackgroundJobsBar.tsx | head -20
```

- [ ] **Step 2 — Add an entry for `video_extract_to_images`**

In the existing kind → display map, add (using whatever the file's existing pattern is — `switch`, dictionary literal, or React component map):

```typescript
"video_extract_to_images": {
  label: "Extracting frames",
  icon: Film,  // lucide-react Film icon; add to top-of-file imports if missing
},
```

- [ ] **Step 3 — Click handler reopens the progress dialog**

When the user clicks the entry, navigate to the task page with a query param like `?video_extract_batch={batch_id}` so the page can mount `<VideoExtractProgressDialog>` for that batch. The query-param read lives on the task page (`AnnotateAssetPage` or wherever it makes sense).

> If wiring the reopen-from-bar is non-trivial in this file, mark it as a follow-up and leave the label/icon entry alone for now — the toast on completion + the asset grid refresh still give the user a workable signal.

- [ ] **Step 4 — Type-check**

```bash
pnpm --filter carve-web exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 5 — Commit**

```bash
git add apps/web/src/components/BackgroundJobsBar.tsx
git commit -m "feat(web): label and reopen video_extract_to_images jobs from the background bar"
```

---

## Task 13 — Manual E2E verification + container rebuild

- [ ] **Step 1 — Rebuild and recreate**

```bash
docker compose up -d --build --force-recreate api worker web
```

- [ ] **Step 2 — Happy path**

1. Open an image task in the editor.
2. Click upload, drop 2 images + 1 small video.
3. **Expect:** wizard advances to the params step with "1 video detected."
4. Pick `Total of K (smart)`, K=10, quality 75, Continue.
5. **Expect:** confirm summary "Upload 2 images now. Extract frames from 1 video … Original videos will be deleted after extraction."
6. Click Upload.
7. **Expect:** progress dialog shows per-video bars and overall %.
8. **Expect:** completion toast "Added 12 images (1 video extraction)." Asset grid contains 2 originals + 10 frames named `<video> — frame 00000.jpg`. Source video gone from grid + DB + MinIO.

- [ ] **Step 3 — Cancel path**

1. Repeat with a longer video so extraction takes ≥ 10s.
2. Click Cancel during extraction.
3. **Expect:** progress dialog shows cancelled state then auto-closes. Source video remains in the grid. Some partial frames present.

- [ ] **Step 4 — Failure path**

1. Pick a deliberately corrupt mp4 (`touch corrupt.mp4`).
2. Run extraction.
3. **Expect:** progress dialog shows the file's row in `failed` state with the error message. Toast names the file. Source video gone.

- [ ] **Step 5 — Dismissable path**

1. Start the happy path again.
2. While extraction is running, click Run in background.
3. **Expect:** dialog closes; background-jobs bar shows "Extracting frames" entry.
4. Click the entry. **Expect:** progress dialog reopens scoped to the same batch.

---

## Self-Review Checklist

Before declaring complete:

- [ ] All test files for this plan are green:
  - `tests/assets/test_video_extract_schemas.py` (11)
  - `tests/jobs/test_video_to_images_planner.py` (9)
  - `tests/jobs/test_video_to_images.py` (3)
  - `tests/assets/test_video_extract_service.py` (7)
  - `tests/assets/test_video_extract_router.py` (5)
  - `src/components/annotation/__tests__/VideoExtractParamsStep.test.tsx` (7)
  - `src/components/annotation/__tests__/VideoExtractProgressDialog.test.tsx` (5)
- [ ] Backend regression suite green: `docker compose exec api pytest tests/ -q`
- [ ] Type check clean: `pnpm --filter carve-web exec tsc --noEmit`
- [ ] All five manual verification steps in Task 13 pass.
- [ ] Commits use conventional-commits format.

## Out of Scope (Documented in Spec)

- Per-video custom params.
- `Asset.extracted_from_filename` column.
- Retry button on failed jobs.
- Pause / resume.
- Live per-frame thumbnails in the dialog.
- Adjusting extraction params after the fact.
