# Video Upload + Frame Extraction Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken two-dialog/no-progress/auto-extract-race video upload flow with a single phase-machine dialog that hands off to the existing BackgroundJobsBar for live extraction progress.

**Architecture:** Backend stops auto-enqueuing extraction at upload (kills the race); the upload dialog becomes a 3-phase state machine (`pick → videoSetup → uploading`); each video kicks an explicit `/frames/extract` job whose `job_id` is registered in the existing Zustand `useBackgroundJobs` store; the bar polls `/frames/extract/status` per registered job; the asset card and editor guard read from the same store.

**Tech Stack:** FastAPI + RQ + Redis (backend); React + Zustand + TanStack Query + vitest + RTL (frontend); existing `react-dropzone` upload pool stays. Spec: `docs/superpowers/specs/2026-05-07-video-upload-extract-flow-design.md`.

---

## File structure

**Backend (modify):**
- `apps/api/src/carve_api/jobs/thumbs.py` — remove auto-extract tail (lines 149–185)
- `apps/api/src/carve_api/jobs/frames.py` — write `job_id` to Redis hash
- `apps/api/src/carve_api/assets/router.py` — 409 on duplicate POST + stale-key cleanup + add `extract_required` to upload response
- `apps/api/src/carve_api/assets/schemas.py` — `AssetOut.extract_required`

**Backend (create):**
- `apps/api/tests/jobs/test_thumbs_no_autoextract.py`
- `apps/api/tests/assets/test_extract_router.py`
- `apps/api/tests/jobs/test_frames_progress.py`

**Frontend (modify):**
- `apps/web/src/state/backgroundJobs.ts` — add `assetId?: string` + `FrameExtractProgress` discriminator
- `apps/web/src/components/BackgroundJobsBar.tsx` — per-job poller for `frame-extract` kind
- `apps/web/src/components/annotation/FrameExtractDialog.tsx` — consume the new `VideoExtractPanel`
- `apps/web/src/pages/AssetUploadDialog.tsx` — REWRITE as phase machine
- `apps/web/src/pages/AssetGrid.tsx` — extracting overlay on video cards
- `apps/web/src/pages/AnnotateAssetPage.tsx` — redirect guard for videos with `frames === 0`

**Frontend (create):**
- `apps/web/src/components/annotation/VideoExtractPanel.tsx` — pure presentational strategy picker
- `apps/web/src/state/useAssetExtractStatus.ts` — single-source hook backed by the store
- `apps/web/tests/video-extract-panel.test.tsx`
- `apps/web/tests/upload-dialog-phase-machine.test.tsx`
- `apps/web/tests/asset-grid-extract-state.test.tsx`
- `apps/web/tests/background-jobs-bar-extract.test.tsx`
- `apps/web/tests/annotate-page-video-guard.test.tsx`
- `apps/web/tests/use-asset-extract-status.test.tsx`
- `apps/web/tests/video-upload-flow-integration.test.tsx`

---

## Task 1: Remove auto-extract tail from `thumbs.py`

**Files:**
- Modify: `apps/api/src/carve_api/jobs/thumbs.py:149-185`
- Create: `apps/api/tests/jobs/test_thumbs_no_autoextract.py`

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/jobs/test_thumbs_no_autoextract.py
"""After v3.26 the upload pipeline stops silently auto-enqueueing
frame extraction. The client always supplies a strategy via
POST /assets/{id}/frames/extract, so probe_video_metadata must NOT
enqueue extract_frames_for_video.
"""
from unittest.mock import patch, MagicMock

import pytest


@pytest.mark.unit
def test_probe_video_metadata_does_not_enqueue_extract():
    from carve_api.jobs import thumbs

    with patch("carve_api.jobs.frames.extract_frames_for_video") as fake_extract, \
         patch("carve_api.jobs.queue.enqueue_with_defaults") as fake_enq, \
         patch("carve_api.jobs.thumbs._make_thumbnail_jpeg", return_value=b""), \
         patch("carve_api.jobs.thumbs._persist_thumbnail_key"), \
         patch("carve_api.storage.client.MinioClient.from_settings") as fake_minio, \
         patch("ffmpeg.probe", return_value={
             "streams": [{"codec_type": "video", "width": 16, "height": 16,
                          "nb_frames": "10", "avg_frame_rate": "30/1"}],
             "format": {"duration": "1.0"},
         }), \
         patch("ffmpeg.input") as fake_input:
        fake_minio.return_value = MagicMock(
            presigned_get_internal=MagicMock(return_value="http://x"),
            put_object=MagicMock(),
        )
        fake_input.return_value.output.return_value.run.return_value = (b"", b"")
        with patch("carve_api.db.get_session_factory") as fake_sf:
            sess = MagicMock()
            fake_sf.return_value.begin.return_value.__enter__.return_value = sess
            sess.get.return_value = MagicMock(
                xxh3_128="abc", original_name="v.mp4",
            )
            thumbs.probe_video_metadata(
                "00000000-0000-0000-0000-000000000001", "abc", "mp4"
            )

    fake_extract.assert_not_called()
    fake_enq.assert_not_called()
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && pytest tests/jobs/test_thumbs_no_autoextract.py -v
```
Expected: FAIL — `fake_enq.assert_not_called()` raises because `thumbs.py:172` still calls `enqueue_with_defaults`.

- [ ] **Step 3: Delete the auto-extract block**

In `apps/api/src/carve_api/jobs/thumbs.py`, remove lines 149–185 (the entire `# v3.8 Phase 4-video step B -- enqueue per-frame extraction…` block, from the comment through the `except Exception:` handler that logs `"failed to enqueue frame extraction"`). The function should end after `_persist_thumbnail_key(asset_id, key)` plus the existing `except Exception: pass` for the thumbnail.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && pytest tests/jobs/test_thumbs_no_autoextract.py -v
```
Expected: PASS.

- [ ] **Step 5: Run sibling thumbs tests to confirm no regression**

```bash
cd apps/api && pytest tests/jobs/test_thumbs.py -v
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/carve_api/jobs/thumbs.py apps/api/tests/jobs/test_thumbs_no_autoextract.py
git commit -m "fix(api): stop auto-enqueueing frame extraction at upload (kill race)"
```

---

## Task 2: Add `extract_required` field to `AssetOut`

**Files:**
- Modify: `apps/api/src/carve_api/assets/schemas.py`
- Modify: `apps/web/src/api/assets.ts` (add `extract_required?: boolean` to `Asset`)
- Create: `apps/api/tests/assets/test_extract_required_field.py`

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/assets/test_extract_required_field.py
"""AssetOut.extract_required is True for fresh video uploads, False for images."""
import io
import pytest
from fastapi.testclient import TestClient


@pytest.mark.integration
def test_video_upload_response_has_extract_required_true(
    test_client: TestClient, fresh_task_id: str
):
    fake_mp4 = io.BytesIO(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 1024)
    r = test_client.post(
        f"/tasks/{fresh_task_id}/assets",
        files={"file": ("clip.mp4", fake_mp4, "video/mp4")},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["kind"] == "video"
    assert body["extract_required"] is True


@pytest.mark.integration
def test_image_upload_response_has_extract_required_false(
    test_client: TestClient, fresh_task_id: str
):
    png = io.BytesIO(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
    r = test_client.post(
        f"/tasks/{fresh_task_id}/assets",
        files={"file": ("a.png", png, "image/png")},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["kind"] == "image"
    assert body["extract_required"] is False
```

(`test_client` and `fresh_task_id` fixtures must already exist in `apps/api/tests/conftest.py` — copy fixture invocation patterns from `apps/api/tests/assets/test_router.py` if the names differ in this codebase.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && pytest tests/assets/test_extract_required_field.py -v
```
Expected: FAIL — `KeyError: 'extract_required'` (field doesn't exist yet).

- [ ] **Step 3: Add the field to `AssetOut`**

In `apps/api/src/carve_api/assets/schemas.py`, add `extract_required: bool = False` to the `AssetOut` model. Update the constructor — `extract_required` is `True` when `a.kind == AssetKind.video and (a.frames or 0) == 0`, else `False`:

```python
class AssetOut(BaseModel):
    id: uuid.UUID
    task_id: uuid.UUID
    kind: AssetKind
    xxh3_128: str
    mime: str
    size_bytes: int
    width: int | None
    height: int | None
    frames: int
    original_name: str
    created_at: datetime
    thumbnail_url: str | None = None
    tag_class_ids: list[str] = []
    # v3.26 — true when this asset needs the client to kick a
    # POST /frames/extract before the editor can open it.
    extract_required: bool = False

    @classmethod
    def from_asset(cls, a, *, thumbnail_url: str | None = None,
                   tag_class_ids: list[str] | None = None) -> "AssetOut":
        return cls(
            id=a.id, task_id=a.task_id, kind=a.kind, xxh3_128=a.xxh3_128,
            mime=a.mime, size_bytes=a.size_bytes, width=a.width, height=a.height,
            frames=a.frames, original_name=a.original_name, created_at=a.created_at,
            thumbnail_url=thumbnail_url,
            tag_class_ids=tag_class_ids or [],
            extract_required=(a.kind == AssetKind.video and (a.frames or 0) == 0),
        )
```

If the existing constructor isn't named `from_asset`, locate the existing constructor in `schemas.py` (search for `frames=a.frames` to find it) and add the same `extract_required=` line there.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && pytest tests/assets/test_extract_required_field.py -v
```
Expected: PASS.

- [ ] **Step 5: Mirror the field in the frontend `Asset` interface**

In `apps/web/src/api/assets.ts`, add `extract_required?: boolean;` to the `Asset` interface (just below `tag_class_ids?: string[];`). Optional so older API responses don't break TS consumers:

```typescript
export interface Asset {
  id: string;
  task_id: string;
  kind: AssetKind;
  xxh3_128: string;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  frames: number;
  original_name: string;
  created_at: string;
  thumbnail_url: string | null;
  tag_class_ids?: string[];
  /** v3.26 — true when the client should kick POST /frames/extract
   *  before the editor can open this asset. Always false for images. */
  extract_required?: boolean;
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/carve_api/assets/schemas.py apps/api/tests/assets/test_extract_required_field.py apps/web/src/api/assets.ts
git commit -m "feat(api): add extract_required field to AssetOut for video uploads"
```

---

## Task 3: 409 + stale-key cleanup on `POST /frames/extract`

**Files:**
- Modify: `apps/api/src/carve_api/assets/router.py:313-360`
- Create: `apps/api/tests/assets/test_extract_router.py`

- [ ] **Step 1: Write the failing tests**

```python
# apps/api/tests/assets/test_extract_router.py
"""POST /assets/{id}/frames/extract idempotency.

- 409 when an extract is already running (live RQ job) for this asset.
- Stale Redis key (no live RQ job) is cleared and request proceeds.
"""
from unittest.mock import patch, MagicMock
import pytest
from fastapi.testclient import TestClient


@pytest.mark.integration
def test_duplicate_extract_returns_409_with_existing_job_id(
    test_client: TestClient, video_asset_id: str
):
    fake_redis = MagicMock()
    fake_redis.hgetall.return_value = {
        "status": "running",
        "phase": "decoding",
        "decoded": "12",
        "expected": "100",
        "uploaded": "0",
        "job_id": "existing-rq-job-abc",
    }
    with patch("redis.Redis", return_value=fake_redis), \
         patch("rq.job.Job.fetch", return_value=MagicMock(get_status=lambda: "started")):
        r = test_client.post(
            f"/assets/{video_asset_id}/frames/extract",
            json={"strategy": "auto"},
        )

    assert r.status_code == 409, r.text
    body = r.json()
    assert body["detail"]["error"] == "extract_in_progress"
    assert body["detail"]["job_id"] == "existing-rq-job-abc"


@pytest.mark.integration
def test_stale_running_key_with_dead_job_is_cleared_and_request_proceeds(
    test_client: TestClient, video_asset_id: str
):
    from rq.exceptions import NoSuchJobError

    fake_redis = MagicMock()
    fake_redis.hgetall.return_value = {
        "status": "running",
        "job_id": "ghost-job-xyz",
    }
    fake_q = MagicMock()
    fake_q.enqueue.return_value = MagicMock(id="new-job-id")

    with patch("redis.Redis", return_value=fake_redis), \
         patch("rq.Queue", return_value=fake_q), \
         patch("rq.job.Job.fetch", side_effect=NoSuchJobError):
        r = test_client.post(
            f"/assets/{video_asset_id}/frames/extract",
            json={"strategy": "auto"},
        )

    assert r.status_code == 202, r.text
    assert r.json()["job_id"] == "new-job-id"
    fake_redis.delete.assert_called_with(f"frame-extract:{video_asset_id}")
```

(The `video_asset_id` fixture must yield a UUID string of an existing video asset belonging to the authenticated user. If it does not exist, copy from the upload-then-yield-id pattern in `apps/api/tests/assets/test_router.py`.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && pytest tests/assets/test_extract_router.py -v
```
Expected: both FAIL — current handler doesn't check Redis at all and never returns 409.

- [ ] **Step 3: Add the idempotency check to the handler**

Replace the body of `reextract_frames` in `apps/api/src/carve_api/assets/router.py:316-360` with:

```python
def reextract_frames(
    asset_id: uuid.UUID,
    payload: FrameExtractIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    from carve_api.assets.models import Asset, AssetKind

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    if a.kind != AssetKind.video:
        raise HTTPException(status_code=422, detail="asset_not_video")

    import os as _os
    import redis as _redis
    from rq import Queue as _Queue
    from rq.job import Job as _Job
    from rq.exceptions import NoSuchJobError as _NoSuchJobError

    from carve_api.jobs.frames import extract_frames_for_video

    client = _redis.Redis(
        host=_os.environ.get("REDIS_HOST", "redis"),
        port=int(_os.environ.get("REDIS_PORT", "6379")),
        decode_responses=True,
    )
    progress_key = f"frame-extract:{asset_id}"

    # Idempotency: if a previous extract is still running, attach the
    # caller to it (return 409 with the existing job_id) instead of
    # racing a second worker against the same MinIO prefix.
    existing = client.hgetall(progress_key) or {}
    if existing.get("status") == "running":
        existing_job_id = existing.get("job_id")
        if existing_job_id:
            try:
                _Job.fetch(existing_job_id, connection=client)
                raise HTTPException(
                    status_code=409,
                    detail={
                        "error": "extract_in_progress",
                        "job_id": existing_job_id,
                    },
                )
            except _NoSuchJobError:
                client.delete(progress_key)
        else:
            client.delete(progress_key)

    try:
        q = _Queue("default", connection=client)
        job = q.enqueue(
            extract_frames_for_video,
            str(a.id),
            payload.strategy,
            payload.n,
            payload.quality,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="enqueue_failed") from exc

    return {"job_id": job.id, "strategy": payload.strategy, "n": payload.n}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && pytest tests/assets/test_extract_router.py -v
```
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/carve_api/assets/router.py apps/api/tests/assets/test_extract_router.py
git commit -m "feat(api): 409 on duplicate extract + stale-key cleanup"
```

---

## Task 4: Worker writes `job_id` to Redis hash

**Files:**
- Modify: `apps/api/src/carve_api/jobs/frames.py:178-200` (the initial Redis `hset` block)
- Modify: `apps/api/src/carve_api/assets/router.py:367-373` (`FrameExtractStatusOut` schema — add `job_id`)
- Modify: `apps/api/src/carve_api/assets/router.py:407-420` (`frame_extract_status` response — surface `job_id`)
- Modify: `apps/web/src/api/assets.ts` (add `job_id` to `frameExtractStatus` return type)
- Create: `apps/api/tests/jobs/test_frames_progress.py`

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/jobs/test_frames_progress.py
"""The worker must write its RQ job_id into the Redis progress hash so
the API status endpoint can return it and the client poller can
correlate to a registered background job.
"""
from unittest.mock import patch, MagicMock
import pytest


@pytest.mark.unit
def test_extract_frames_writes_job_id_to_redis():
    from carve_api.jobs import frames as fmod
    from carve_api.assets.models import AssetKind

    fake_redis = MagicMock()
    fake_current_job = MagicMock(id="rq-job-0001")

    with patch("redis.Redis", return_value=fake_redis), \
         patch("rq.get_current_job", return_value=fake_current_job), \
         patch("ffmpeg.probe", return_value={
             "streams": [{"codec_type": "video", "nb_frames": "100",
                          "avg_frame_rate": "30/1"}],
             "format": {"duration": "3.33"},
         }), \
         patch("ffmpeg.input") as fake_input, \
         patch("carve_api.storage.client.MinioClient.from_settings") as fake_minio, \
         patch("carve_api.db.get_session_factory") as fake_sf:
        proc = MagicMock()
        proc.poll.side_effect = [None, 0]
        proc.returncode = 0
        proc.stderr.read.return_value = b""
        fake_input.return_value.filter.return_value.output.return_value.run_async.return_value = proc

        fake_minio.return_value = MagicMock(
            presigned_get_internal=MagicMock(return_value="http://x"),
            put_object=MagicMock(),
            remove_object=MagicMock(),
            _s3=MagicMock(),
            bucket="b",
        )
        sess = MagicMock()
        sess.get.return_value = MagicMock(
            xxh3_128="abc", original_name="v.mp4", frames=100,
            kind=AssetKind.video,
        )
        fake_sf.return_value.begin.return_value.__enter__.return_value = sess

        # Force "no produced frames" so the function bails out early.
        # We only care that the early hset call recorded the job_id.
        with patch("pathlib.Path.glob", return_value=[]):
            try:
                fmod.extract_frames_for_video(
                    "00000000-0000-0000-0000-000000000001",
                    strategy="auto",
                )
            except Exception:
                pass

    saw_job_id = False
    for call in fake_redis.hset.call_args_list:
        args, kwargs = call
        mapping = kwargs.get("mapping") or (args[1] if len(args) > 1 else {})
        if isinstance(mapping, dict) and mapping.get("job_id") == "rq-job-0001":
            saw_job_id = True
            break
    assert saw_job_id, (
        f"expected job_id 'rq-job-0001' in hset mapping; "
        f"calls={fake_redis.hset.call_args_list}"
    )
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && pytest tests/jobs/test_frames_progress.py -v
```
Expected: FAIL — current `frames.py` never writes `job_id`.

- [ ] **Step 3: Write `job_id` in the worker's initial hset block**

In `apps/api/src/carve_api/jobs/frames.py`, locate the `_r.hset(progress_key, mapping={...})` near the top of the worker (around line 184). Just before that block, add:

```python
    # v3.26 — record the RQ job id so the status endpoint can return
    # it and the client poller can correlate the job in its store.
    try:
        from rq import get_current_job as _get_current_job
        _current_job = _get_current_job()
        _current_job_id = _current_job.id if _current_job is not None else ""
    except Exception:
        _current_job_id = ""
```

Then add `"job_id": _current_job_id,` to the `mapping=` dict of the first `_r.hset(progress_key, mapping={...})` call.

- [ ] **Step 4: Surface `job_id` from the status endpoint**

In `apps/api/src/carve_api/assets/router.py`:

a) Add `job_id: str | None = None` to `FrameExtractStatusOut` (around line 367):

```python
class FrameExtractStatusOut(BaseModel):
    status: str
    phase: str
    decoded: int
    expected: int
    uploaded: int
    message: str | None = None
    job_id: str | None = None
```

b) In `frame_extract_status` (around line 407), include the value in the returned model:

```python
    return FrameExtractStatusOut(
        status=h.get("status") or "idle",
        phase=h.get("phase") or "idle",
        decoded=int(h.get("decoded") or 0),
        expected=int(h.get("expected") or 0),
        uploaded=int(h.get("uploaded") or 0),
        message=h.get("message"),
        job_id=h.get("job_id") or None,
    )
```

c) Mirror in the frontend `apps/web/src/api/assets.ts` `frameExtractStatus` return type — add `job_id: string | null` to both occurrences (the `Promise<{...}>` type and the inner `api.get<{...}>` generic).

- [ ] **Step 5: Run test to verify it passes**

```bash
cd apps/api && pytest tests/jobs/test_frames_progress.py -v
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/carve_api/jobs/frames.py apps/api/src/carve_api/assets/router.py apps/web/src/api/assets.ts apps/api/tests/jobs/test_frames_progress.py
git commit -m "feat(api): worker writes job_id to redis; status endpoint returns it"
```

---

## Task 5: Extend `backgroundJobs.ts` for frame-extract jobs

**Files:**
- Modify: `apps/web/src/state/backgroundJobs.ts`
- Create: `apps/web/src/state/useAssetExtractStatus.ts`
- Create: `apps/web/tests/use-asset-extract-status.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/tests/use-asset-extract-status.test.tsx
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBackgroundJobs } from "@/state/backgroundJobs";
import { useAssetExtractStatus } from "@/state/useAssetExtractStatus";

describe("useAssetExtractStatus", () => {
  beforeEach(() => {
    useBackgroundJobs.setState({ jobs: {}, expandRequest: null });
  });

  it("returns undefined when no job exists for the asset", () => {
    const { result } = renderHook(() =>
      useAssetExtractStatus("asset-no-job"),
    );
    expect(result.current).toBeUndefined();
  });

  it("returns extract progress for the asset's frame-extract job", () => {
    act(() => {
      useBackgroundJobs.getState().add({
        jobId: "j1",
        taskId: "t1",
        kind: "frame-extract",
        label: "Extracting frames",
        startedAt: Date.now(),
        assetId: "asset-A",
        cancel: async () => {},
        progress: {
          status: "running",
          phase: "decoding",
          decoded: 42,
          expected: 100,
          uploaded: 0,
        },
      });
    });

    const { result } = renderHook(() => useAssetExtractStatus("asset-A"));
    expect(result.current?.status).toBe("running");
    expect(result.current?.phase).toBe("decoding");
    expect(result.current?.decoded).toBe(42);
    expect(result.current?.expected).toBe(100);
  });

  it("ignores non-frame-extract jobs that happen to share an assetId", () => {
    act(() => {
      useBackgroundJobs.getState().add({
        jobId: "j2",
        taskId: "t1",
        kind: "yolo-predict-batch",
        label: "YOLO",
        startedAt: Date.now(),
        assetId: "asset-A",
        cancel: async () => {},
        progress: { status: "running", done: 1, total: 10 },
      });
    });
    const { result } = renderHook(() => useAssetExtractStatus("asset-A"));
    expect(result.current).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && pnpm vitest run tests/use-asset-extract-status.test.tsx
```
Expected: FAIL — `useAssetExtractStatus` doesn't exist; `BackgroundJob` doesn't accept `assetId`.

- [ ] **Step 3: Extend `backgroundJobs.ts`**

In `apps/web/src/state/backgroundJobs.ts`:

a) Extend `BackgroundJobProgress` with the optional extract fields:

```typescript
export interface BackgroundJobProgress {
  status: string;
  done?: number;
  total?: number;
  failed?: number;
  message?: string;
  // v3.26 — frame-extract specifics. Optional so other kinds ignore them.
  phase?: "decoding" | "uploading" | "done" | "idle";
  decoded?: number;
  expected?: number;
  uploaded?: number;
}
```

b) Add `assetId?: string` to `BackgroundJob`:

```typescript
export interface BackgroundJob {
  jobId: string;
  taskId: string;
  kind: BackgroundJobKind;
  label: string;
  startedAt: number;
  // v3.26 — when set, the bar can match a job to a specific asset for
  // per-card overlays. Required for kind:"frame-extract"; optional
  // elsewhere.
  assetId?: string;
  cancel: () => Promise<void>;
  progress?: BackgroundJobProgress;
}
```

- [ ] **Step 4: Create the hook**

```typescript
// apps/web/src/state/useAssetExtractStatus.ts
// Armin Mehri — mehri.armin@gmail.com
import { useBackgroundJobs } from "./backgroundJobs";

export interface FrameExtractStatusView {
  status: "running" | "completed" | "failed" | "idle";
  phase: "decoding" | "uploading" | "done" | "idle";
  decoded: number;
  expected: number;
  uploaded: number;
  message?: string;
}

/**
 * v3.26 — single source of truth for "is this asset's frames currently
 * being extracted, and how far along?" Reads from the same Zustand
 * store the BackgroundJobsBar polls into. No per-card pollers.
 */
export function useAssetExtractStatus(
  assetId: string | undefined,
): FrameExtractStatusView | undefined {
  return useBackgroundJobs((s) => {
    if (!assetId) return undefined;
    const job = Object.values(s.jobs).find(
      (j) => j.kind === "frame-extract" && j.assetId === assetId,
    );
    if (!job?.progress) return undefined;
    const p = job.progress;
    return {
      status: (p.status as FrameExtractStatusView["status"]) ?? "idle",
      phase: (p.phase as FrameExtractStatusView["phase"]) ?? "idle",
      decoded: p.decoded ?? 0,
      expected: p.expected ?? 0,
      uploaded: p.uploaded ?? 0,
      message: p.message,
    };
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd apps/web && pnpm vitest run tests/use-asset-extract-status.test.tsx
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/state/backgroundJobs.ts apps/web/src/state/useAssetExtractStatus.ts apps/web/tests/use-asset-extract-status.test.tsx
git commit -m "feat(web): add assetId to BackgroundJob + useAssetExtractStatus hook"
```

---

## Task 6: Wire frame-extract poller in `BackgroundJobsBar`

**Files:**
- Modify: `apps/web/src/components/BackgroundJobsBar.tsx`
- Create: `apps/web/tests/background-jobs-bar-extract.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/tests/background-jobs-bar-extract.test.tsx
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/assets", () => ({
  assetsApi: {
    frameExtractStatus: vi.fn(),
  },
}));

import { assetsApi } from "@/api/assets";
import { useBackgroundJobs } from "@/state/backgroundJobs";
import { BackgroundJobsBar } from "@/components/BackgroundJobsBar";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("BackgroundJobsBar — frame-extract polling", () => {
  beforeEach(() => {
    useBackgroundJobs.setState({ jobs: {}, expandRequest: null });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("polls assetsApi.frameExtractStatus and pushes progress into the store", async () => {
    (assetsApi.frameExtractStatus as any).mockResolvedValue({
      status: "running",
      phase: "decoding",
      decoded: 50,
      expected: 100,
      uploaded: 0,
      message: null,
      job_id: "j-poll",
    });

    act(() => {
      useBackgroundJobs.getState().add({
        jobId: "j-poll",
        taskId: "t1",
        kind: "frame-extract",
        label: "Extracting frames",
        startedAt: Date.now(),
        assetId: "asset-X",
        cancel: async () => {},
      });
    });

    render(wrap(<BackgroundJobsBar />));

    await act(async () => {
      vi.advanceTimersByTime(1600);
    });

    await waitFor(() => {
      expect(assetsApi.frameExtractStatus).toHaveBeenCalledWith("asset-X");
    });

    const stored = useBackgroundJobs.getState().jobs["j-poll"];
    expect(stored.progress?.decoded).toBe(50);
    expect(stored.progress?.phase).toBe("decoding");
  });

  it("removes the job 5s after status becomes completed", async () => {
    (assetsApi.frameExtractStatus as any).mockResolvedValue({
      status: "completed",
      phase: "done",
      decoded: 100,
      expected: 100,
      uploaded: 100,
      message: null,
      job_id: "j-done",
    });

    act(() => {
      useBackgroundJobs.getState().add({
        jobId: "j-done",
        taskId: "t1",
        kind: "frame-extract",
        label: "Extracting frames",
        startedAt: Date.now(),
        assetId: "asset-Y",
        cancel: async () => {},
      });
    });

    render(wrap(<BackgroundJobsBar />));

    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    await waitFor(() => {
      const j = useBackgroundJobs.getState().jobs["j-done"];
      expect(j?.progress?.status).toBe("completed");
    });

    await act(async () => {
      vi.advanceTimersByTime(5100);
    });
    expect(useBackgroundJobs.getState().jobs["j-done"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && pnpm vitest run tests/background-jobs-bar-extract.test.tsx
```
Expected: FAIL — bar has no extract poller yet.

- [ ] **Step 3: Add the per-job extract poller hook to `BackgroundJobsBar`**

Add this hook helper inside `apps/web/src/components/BackgroundJobsBar.tsx` (above the component body) and call it once per registered `frame-extract` job:

```tsx
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { assetsApi } from "@/api/assets";
import { useBackgroundJobs, type BackgroundJob } from "@/state/backgroundJobs";

const EXTRACT_POLL_MS = 1500;
const EXTRACT_REMOVE_DELAY_MS = 5000;

function useFrameExtractPoller(job: BackgroundJob): void {
  const setProgress = useBackgroundJobs((s) => s.setProgress);
  const remove = useBackgroundJobs((s) => s.remove);
  const qc = useQueryClient();

  useEffect(() => {
    if (job.kind !== "frame-extract" || !job.assetId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let removeTimer: ReturnType<typeof setTimeout> | null = null;
    let canceled = false;

    const tick = async () => {
      try {
        const s = await assetsApi.frameExtractStatus(job.assetId!);
        if (canceled) return;
        setProgress(job.jobId, {
          status: s.status,
          phase: s.phase,
          decoded: s.decoded,
          expected: s.expected,
          uploaded: s.uploaded,
          message: s.message ?? undefined,
        });
        if (s.status === "completed" || s.status === "failed") {
          qc.invalidateQueries({ queryKey: ["task-assets", job.taskId] });
          qc.invalidateQueries({ queryKey: ["task-assets-count", job.taskId] });
          qc.invalidateQueries({ queryKey: ["frames", job.assetId] });
          removeTimer = setTimeout(
            () => remove(job.jobId),
            EXTRACT_REMOVE_DELAY_MS,
          );
          return;
        }
      } catch {
        // Best-effort — keep polling. A persistent backend outage is
        // visible via the bar's status; the user can dismiss.
      }
      timer = setTimeout(tick, EXTRACT_POLL_MS);
    };

    timer = setTimeout(tick, EXTRACT_POLL_MS);
    return () => {
      canceled = true;
      if (timer) clearTimeout(timer);
      if (removeTimer) clearTimeout(removeTimer);
    };
  }, [job.jobId, job.kind, job.assetId, job.taskId, setProgress, remove, qc]);
}

function FrameExtractPollerNode({ job }: { job: BackgroundJob }) {
  useFrameExtractPoller(job);
  return null;
}
```

In the component body, render one poller node per `frame-extract` job alongside the existing per-kind pollers:

```tsx
{Object.values(jobs)
  .filter((j) => j.kind === "frame-extract")
  .map((j) => <FrameExtractPollerNode key={j.jobId} job={j} />)}
```

For the visible row, when `job.kind === "frame-extract"` show the decoded counter and phase label:

```tsx
const decoded = job.progress?.decoded ?? 0;
const expected = job.progress?.expected ?? 0;
const phaseLabel = job.progress?.phase ?? "idle";
const display = job.kind === "frame-extract"
  ? `${decoded} / ${expected} frames (${phaseLabel})`
  : `${job.progress?.done ?? 0} / ${job.progress?.total ?? 0}`;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && pnpm vitest run tests/background-jobs-bar-extract.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/BackgroundJobsBar.tsx apps/web/tests/background-jobs-bar-extract.test.tsx
git commit -m "feat(web): live polling for frame-extract jobs in BackgroundJobsBar"
```

---

## Task 7: New `VideoExtractPanel` component

**Files:**
- Create: `apps/web/src/components/annotation/VideoExtractPanel.tsx`
- Create: `apps/web/tests/video-extract-panel.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/tests/video-extract-panel.test.tsx
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import {
  VideoExtractPanel,
  DEFAULT_EXTRACT_STRATEGY,
  type ExtractStrategy,
} from "@/components/annotation/VideoExtractPanel";

describe("VideoExtractPanel", () => {
  it("renders the video count header", () => {
    render(
      <VideoExtractPanel
        videoCount={3}
        value={DEFAULT_EXTRACT_STRATEGY}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText(/3 videos/i)).toBeInTheDocument();
  });

  it("calls onChange when strategy radio changes", () => {
    const onChange = vi.fn();
    render(
      <VideoExtractPanel
        videoCount={1}
        value={DEFAULT_EXTRACT_STRATEGY}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("frame-extract-strategy-all"));
    const last = onChange.mock.calls.at(-1)?.[0] as ExtractStrategy;
    expect(last.strategy).toBe("all");
  });

  it("only shows the N input when strategy needs it", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <VideoExtractPanel
        videoCount={1}
        value={{ strategy: "auto", n: null, quality: 75 }}
        onChange={onChange}
      />,
    );
    expect(screen.queryByTestId("frame-extract-n")).toBeNull();

    rerender(
      <VideoExtractPanel
        videoCount={1}
        value={{ strategy: "count", n: 250, quality: 75 }}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("frame-extract-n")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && pnpm vitest run tests/video-extract-panel.test.tsx
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create the component**

```tsx
// apps/web/src/components/annotation/VideoExtractPanel.tsx
// Armin Mehri — mehri.armin@gmail.com
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";

export type ExtractStrategyKind = "auto" | "all" | "every_nth" | "count";

export interface ExtractStrategy {
  strategy: ExtractStrategyKind;
  n: number | null;
  quality: number;
}

export const DEFAULT_EXTRACT_STRATEGY: ExtractStrategy = {
  strategy: "count",
  n: 500,
  quality: 75,
};

interface Option {
  key: ExtractStrategyKind;
  title: string;
  desc: string;
}

const OPTIONS: readonly Option[] = [
  { key: "auto", title: "Auto", desc: "Caps at ~500 frames; downsamples long videos." },
  { key: "all", title: "All frames", desc: "Every frame. Most accurate; biggest storage." },
  { key: "every_nth", title: "Every N-th frame", desc: "Skip in steps. Good for high-fps videos." },
  { key: "count", title: "Total of K frames (smart)", desc: "Evenly spaced K frames across the video." },
];

interface Props {
  videoCount: number;
  value: ExtractStrategy;
  onChange: (next: ExtractStrategy) => void;
}

export function VideoExtractPanel({ videoCount, value, onChange }: Props) {
  const needsN = value.strategy === "every_nth" || value.strategy === "count";

  return (
    <div className="grid gap-3">
      <p className="text-[12.5px] text-[color:var(--text-secondary)]">
        {videoCount} {videoCount === 1 ? "video" : "videos"} detected — pick how
        many frames to extract. The same setting applies to every video.
      </p>

      <div className="grid gap-2">
        {OPTIONS.map((opt) => {
          const active = value.strategy === opt.key;
          return (
            <label
              key={opt.key}
              data-testid={`frame-extract-strategy-${opt.key}`}
              className={cn(
                "flex items-start gap-2.5 px-3 py-2 cursor-pointer",
                "rounded-[var(--radius-sm)] border transition-colors",
                active
                  ? "border-[var(--accent)] bg-[var(--accent-bg)]"
                  : "border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]",
              )}
            >
              <input
                type="radio"
                name="video-extract-strategy"
                checked={active}
                onChange={() =>
                  onChange({
                    ...value,
                    strategy: opt.key,
                    n:
                      opt.key === "auto" || opt.key === "all"
                        ? null
                        : value.n ?? (opt.key === "count" ? 500 : 5),
                  })
                }
                className="mt-0.5"
              />
              <div className="grid gap-0.5">
                <div className="text-[13px] text-[color:var(--text-primary)]">
                  {opt.title}
                </div>
                <div className="text-[11.5px] text-[color:var(--text-tertiary)]">
                  {opt.desc}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {needsN && (
        <div className="flex items-center gap-2">
          <label
            htmlFor="frame-extract-n"
            className="text-[12px] text-[color:var(--text-secondary)]"
          >
            {value.strategy === "every_nth" ? "N (step):" : "K (total frames):"}
          </label>
          <Input
            id="frame-extract-n"
            type="number"
            min={1}
            max={100000}
            value={value.n ?? 1}
            onChange={(e) =>
              onChange({
                ...value,
                n: Math.max(1, parseInt(e.target.value, 10) || 1),
              })
            }
            data-testid="frame-extract-n"
            className="w-24"
          />
        </div>
      )}

      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <label
            htmlFor="frame-extract-quality"
            className="text-[12px] text-[color:var(--text-secondary)]"
          >
            Quality
          </label>
          <span className="font-mono text-[11.5px] text-[color:var(--text-tertiary)] tabular-nums">
            {value.quality} / 100
          </span>
        </div>
        <input
          id="frame-extract-quality"
          type="range"
          min={0}
          max={100}
          step={5}
          value={value.quality}
          onChange={(e) =>
            onChange({ ...value, quality: parseInt(e.target.value, 10) || 0 })
          }
          data-testid="frame-extract-quality"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && pnpm vitest run tests/video-extract-panel.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/annotation/VideoExtractPanel.tsx apps/web/tests/video-extract-panel.test.tsx
git commit -m "feat(web): VideoExtractPanel — pure presentational strategy picker"
```

---

## Task 8: Refactor `FrameExtractDialog` to consume `VideoExtractPanel`

**Files:**
- Modify: `apps/web/src/components/annotation/FrameExtractDialog.tsx`

This is internal cleanup — the editor toolbar's Re-extract dialog reuses the same panel. Behavior must be identical.

- [ ] **Step 1: Replace the panel body in `FrameExtractDialog`**

In `apps/web/src/components/annotation/FrameExtractDialog.tsx`, replace the strategy-radios `<div>`, the `needsN` block, and the quality slider section with a single `<VideoExtractPanel videoCount={1} value={picker} onChange={setPicker} />`. Keep the dialog wrapper, header, footer, mutation, and submit logic untouched.

Replace the three separate state hooks with a single `ExtractStrategy` state:

```tsx
import {
  VideoExtractPanel,
  DEFAULT_EXTRACT_STRATEGY,
  type ExtractStrategy,
} from "@/components/annotation/VideoExtractPanel";

// Replace:
//   const [strategy, setStrategy] = useState<Strategy>("count");
//   const [nValue, setNValue] = useState<number>(500);
//   const [quality, setQuality] = useState<number>(75);
// With:
const [picker, setPicker] = useState<ExtractStrategy>(DEFAULT_EXTRACT_STRATEGY);

// In `submit`:
const body = {
  strategy: picker.strategy,
  n:
    picker.strategy === "every_nth" || picker.strategy === "count"
      ? Math.max(1, picker.n ?? 1)
      : null,
  quality: picker.quality,
};
```

Render the panel where the inline UI used to be:

```tsx
<VideoExtractPanel
  videoCount={1}
  value={picker}
  onChange={setPicker}
/>
```

- [ ] **Step 2: Run existing dialog tests + the panel tests**

```bash
cd apps/web && pnpm vitest run tests/video-extract-panel.test.tsx
ls apps/web/tests/frame-extract-dialog.test.tsx 2>/dev/null && \
  cd apps/web && pnpm vitest run tests/frame-extract-dialog.test.tsx
```
Expected: PASS for the panel test; if a dialog test exists, it must also still pass.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/annotation/FrameExtractDialog.tsx
git commit -m "refactor(web): FrameExtractDialog uses shared VideoExtractPanel"
```

---

## Task 9: Rewrite `AssetUploadDialog` as a phase machine

**Files:**
- Modify: `apps/web/src/pages/AssetUploadDialog.tsx` (full rewrite)
- Modify: `apps/web/tests/asset-upload-dialog.test.tsx` (existing tests need updating)
- Create: `apps/web/tests/upload-dialog-phase-machine.test.tsx`

- [ ] **Step 1: Write the failing test for the phase machine**

```tsx
// apps/web/tests/upload-dialog-phase-machine.test.tsx
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/assets", () => ({
  assetsApi: {
    upload: vi.fn(),
    uploadZip: vi.fn(),
    reextractFrames: vi.fn(),
  },
}));

import { assetsApi } from "@/api/assets";
import { useBackgroundJobs } from "@/state/backgroundJobs";
import { AssetUploadDialog } from "@/pages/AssetUploadDialog";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

function pickFiles(container: HTMLElement, files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

describe("AssetUploadDialog phase machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBackgroundJobs.setState({ jobs: {}, expandRequest: null });
  });

  it("skips videoSetup when no videos are dropped", async () => {
    (assetsApi.upload as any).mockResolvedValue({
      id: "a1", kind: "image", extract_required: false,
    });
    const { container } = render(
      wrap(<AssetUploadDialog projectId="p" taskId="t1" />),
    );
    pickFiles(container, [
      new File([new Uint8Array([0x89, 0x50])], "x.png", { type: "image/png" }),
    ]);
    await waitFor(() => expect(assetsApi.upload).toHaveBeenCalled());
    expect(screen.queryByTestId("frame-extract-strategy-count")).toBeNull();
    expect(assetsApi.reextractFrames).not.toHaveBeenCalled();
  });

  it("goes pick → videoSetup → uploading and registers a frame-extract job", async () => {
    (assetsApi.upload as any).mockResolvedValue({
      id: "v1", kind: "video", extract_required: true,
    });
    (assetsApi.reextractFrames as any).mockResolvedValue({
      job_id: "j-extract-1", strategy: "count", n: 500,
    });

    const { container } = render(
      wrap(<AssetUploadDialog projectId="p" taskId="t1" />),
    );

    pickFiles(container, [
      new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" }),
    ]);

    await waitFor(() =>
      expect(screen.getByTestId("frame-extract-strategy-count"))
        .toBeInTheDocument(),
    );
    expect(assetsApi.upload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("upload-continue"));

    await waitFor(() => expect(assetsApi.upload).toHaveBeenCalled());
    await waitFor(() =>
      expect(assetsApi.reextractFrames).toHaveBeenCalledWith("v1", {
        strategy: "count",
        n: 500,
        quality: 75,
      }),
    );

    await waitFor(() => {
      const jobs = Object.values(useBackgroundJobs.getState().jobs);
      const j = jobs.find((x) => x.kind === "frame-extract");
      expect(j?.jobId).toBe("j-extract-1");
      expect(j?.assetId).toBe("v1");
      expect(j?.taskId).toBe("t1");
    });
  });

  it("Cancel from videoSetup returns to pick and clears files", async () => {
    const { container } = render(
      wrap(<AssetUploadDialog projectId="p" taskId="t1" />),
    );
    pickFiles(container, [
      new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" }),
    ]);
    await waitFor(() =>
      expect(screen.getByTestId("frame-extract-strategy-count"))
        .toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("upload-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("frame-extract-strategy-count")).toBeNull(),
    );
    expect(assetsApi.upload).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && pnpm vitest run tests/upload-dialog-phase-machine.test.tsx
```
Expected: FAIL — current dialog has no phase machine and no `upload-continue` testid.

- [ ] **Step 3: Rewrite `AssetUploadDialog`**

Rewrite `apps/web/src/pages/AssetUploadDialog.tsx`. Keep the existing behaviors that aren't being changed: extension validation, 429 retry, parallel upload pool with concurrency 6, ZIP support, query invalidation. The new shape:

```tsx
// apps/web/src/pages/AssetUploadDialog.tsx
// Armin Mehri — mehri.armin@gmail.com
import { useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { useQueryClient } from "@tanstack/react-query";
import { Upload, FileImage, ArrowLeft } from "lucide-react";

import { assetsApi } from "@/api/assets";
import { Button } from "@/components/ui/Button";
import {
  VideoExtractPanel,
  DEFAULT_EXTRACT_STRATEGY,
  type ExtractStrategy,
} from "@/components/annotation/VideoExtractPanel";
import { useBackgroundJobs } from "@/state/backgroundJobs";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";

const ALLOWED_UPLOAD_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mov", ".zip",
];
const ANNOTATION_EXTENSIONS = [".txt", ".yaml", ".yml", ".json"];

function validateExtension(file: File) {
  const lower = file.name.toLowerCase();
  if (ALLOWED_UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext))) return null;
  if (ANNOTATION_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return {
      code: "wrong-dialog-annotation",
      message:
        "That looks like an annotation file (YOLO/COCO labels). Use the Import button next to Upload.",
    };
  }
  return {
    code: "ext-not-allowed",
    message: `Unsupported file type — accepted: ${ALLOWED_UPLOAD_EXTENSIONS.join(", ")}`,
  };
}

const MAX_RETRIES = 3;
const FALLBACK_RETRY_AFTER_SECONDS = 60;

interface RateLimitedResponse {
  response?: {
    status?: number;
    data?: { error?: string; retry_after_seconds?: number };
    headers?: Record<string, string | undefined>;
  };
}

function extractRetryAfterSeconds(err: unknown): number | null {
  const e = err as RateLimitedResponse;
  if (e?.response?.status !== 429) return null;
  const fromBody = e.response?.data?.retry_after_seconds;
  if (typeof fromBody === "number" && fromBody > 0) return fromBody;
  const headerVal = e.response?.headers?.["retry-after"];
  if (headerVal) {
    const parsed = Number(headerVal);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return FALLBACK_RETRY_AFTER_SECONDS;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const VIDEO_RE = /\.(mp4|webm|mov)$/i;

interface UploadError {
  name: string;
  error: string;
}

type Phase =
  | { kind: "pick" }
  | {
      kind: "videoSetup";
      images: File[];
      videos: File[];
      strategy: ExtractStrategy;
    }
  | {
      kind: "uploading";
      images: File[];
      videos: File[];
      strategy: ExtractStrategy;
      done: number;
      total: number;
      errors: UploadError[];
      retryNotice: string | null;
    };

interface Props {
  projectId: string;
  taskId: string;
}

export function AssetUploadDialog({ projectId: _projectId, taskId }: Props) {
  const qc = useQueryClient();
  const addJob = useBackgroundJobs((s) => s.add);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });

  const onDrop = (files: File[]) => {
    if (files.length === 0) return;
    const videos = files.filter((f) => VIDEO_RE.test(f.name));
    const others = files.filter((f) => !VIDEO_RE.test(f.name));
    if (videos.length === 0) {
      void runUpload({
        images: others, videos: [], strategy: DEFAULT_EXTRACT_STRATEGY,
      });
      return;
    }
    setPhase({
      kind: "videoSetup",
      images: others,
      videos,
      strategy: DEFAULT_EXTRACT_STRATEGY,
    });
  };

  const runUpload = async (cfg: {
    images: File[];
    videos: File[];
    strategy: ExtractStrategy;
  }) => {
    const total = cfg.images.length + cfg.videos.length;
    setPhase({
      kind: "uploading",
      images: cfg.images,
      videos: cfg.videos,
      strategy: cfg.strategy,
      done: 0,
      total,
      errors: [],
      retryNotice: null,
    });

    const all = [...cfg.images, ...cfg.videos];
    const CONCURRENCY = 6;
    let cursor = 0;
    let count = 0;
    const errors: UploadError[] = [];

    const uploadOne = async (file: File): Promise<void> => {
      const isZip = file.name.toLowerCase().endsWith(".zip");
      const isVideo = VIDEO_RE.test(file.name);
      let attempt = 0;
      while (true) {
        try {
          if (isZip) {
            const created = await assetsApi.uploadZip(taskId, file);
            if (Array.isArray(created) && created.length === 0) {
              showToast(
                `"${file.name}" had no images inside. ` +
                  "If it's a YOLO/COCO label bundle, use Import.",
                { variant: "warning", duration: 7000 },
              );
            }
          } else {
            const asset = await assetsApi.upload(taskId, file);
            if (isVideo && asset?.id) {
              try {
                const { job_id } = await assetsApi.reextractFrames(asset.id, {
                  strategy: cfg.strategy.strategy,
                  n:
                    cfg.strategy.strategy === "every_nth" ||
                    cfg.strategy.strategy === "count"
                      ? Math.max(1, cfg.strategy.n ?? 1)
                      : null,
                  quality: cfg.strategy.quality,
                });
                addJob({
                  jobId: job_id,
                  taskId,
                  kind: "frame-extract",
                  label: `Extracting ${file.name}`,
                  startedAt: Date.now(),
                  assetId: asset.id,
                  cancel: async () => {},
                });
              } catch {
                errors.push({
                  name: file.name,
                  error: "extract_failed_open_re_extract_in_editor",
                });
              }
            }
          }
          return;
        } catch (err: unknown) {
          const retryAfterSec = extractRetryAfterSeconds(err);
          if (retryAfterSec !== null && attempt < MAX_RETRIES) {
            attempt += 1;
            setPhase((p) =>
              p.kind === "uploading"
                ? {
                    ...p,
                    retryNotice:
                      `Upload paused — retrying in ${retryAfterSec}s ` +
                      `(${attempt}/${MAX_RETRIES})`,
                  }
                : p,
            );
            await sleep(retryAfterSec * 1000);
            continue;
          }
          throw err;
        }
      }
    };

    const worker = async () => {
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= all.length) return;
        const file = all[idx];
        try {
          await uploadOne(file);
        } catch (err: unknown) {
          const code =
            (err as { response?: { data?: { error?: string } } })?.response?.data
              ?.error ?? "upload_failed";
          errors.push({ name: file.name, error: code });
        } finally {
          count += 1;
          setPhase((p) =>
            p.kind === "uploading"
              ? { ...p, done: count, errors: [...errors] }
              : p,
          );
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, all.length) }, () => worker()),
    );

    qc.invalidateQueries({ queryKey: ["task-assets", taskId] });
    qc.invalidateQueries({ queryKey: ["task-assets-count", taskId] });

    showToast(
      cfg.videos.length > 0
        ? `Uploaded ${total} files; extracting frames in background.`
        : `Uploaded ${total} files.`,
      { variant: "success" },
    );

    setTimeout(() => setPhase({ kind: "pick" }), 1000);
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    validator: validateExtension,
    onDrop,
    onDropRejected: (rejections: FileRejection[]) => {
      showToast(
        rejections.length === 1
          ? `Couldn't accept "${rejections[0].file.name}" — ${rejections[0].errors[0]?.message ?? ""}`
          : `${rejections.length} files were rejected.`,
        { variant: "error", duration: 6000 },
      );
    },
  });

  return (
    <section className="grid gap-3" data-testid="asset-upload-dialog">
      <h2 className="text-[18px] font-light tracking-tight text-primary">
        Upload assets
      </h2>

      {phase.kind === "pick" && (
        <div
          {...getRootProps()}
          className={cn(
            "grid place-items-center gap-2 px-6 py-10 cursor-pointer transition-all",
            "rounded-[var(--radius-lg)] border-2 border-dashed",
            isDragActive
              ? "border-[var(--border-accent)] bg-[var(--accent-bg)]"
              : "border-[var(--border-subtle)] bg-[oklch(0.18_0.012_240_/_0.30)] hover:border-[var(--border-strong)]",
          )}
        >
          <input {...getInputProps()} aria-label="upload-input" />
          <FileImage
            className={cn(
              "h-7 w-7 transition-colors",
              isDragActive ? "text-[color:var(--accent)]" : "text-tertiary",
            )}
          />
          <p className="text-[13px] text-secondary tracking-tight text-center">
            {isDragActive
              ? "Drop to upload"
              : "Drag & drop images, videos, or .zip — or click to choose"}
          </p>
        </div>
      )}

      {phase.kind === "videoSetup" && (
        <div className="grid gap-3">
          <VideoExtractPanel
            videoCount={phase.videos.length}
            value={phase.strategy}
            onChange={(next) =>
              setPhase((p) =>
                p.kind === "videoSetup" ? { ...p, strategy: next } : p,
              )
            }
          />
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="md"
              data-testid="upload-back"
              leftIcon={<ArrowLeft className="h-3.5 w-3.5" />}
              onClick={() => setPhase({ kind: "pick" })}
            >
              Back
            </Button>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="md"
                data-testid="upload-cancel"
                onClick={() => setPhase({ kind: "pick" })}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="md"
                data-testid="upload-continue"
                onClick={() =>
                  void runUpload({
                    images: phase.images,
                    videos: phase.videos,
                    strategy: phase.strategy,
                  })
                }
              >
                Continue
              </Button>
            </div>
          </div>
        </div>
      )}

      {phase.kind === "uploading" && (
        <>
          <p className="flex items-center gap-2 text-tertiary text-[12px]">
            <Upload className="h-3.5 w-3.5 animate-pulse text-[color:var(--accent)]" />
            Uploaded {phase.done} / {phase.total}
          </p>
          {phase.retryNotice && (
            <p
              role="status"
              aria-live="polite"
              className="text-[12px] text-[color:var(--warning,oklch(0.78_0.18_85))]"
            >
              {phase.retryNotice}
            </p>
          )}
          {phase.errors.length > 0 && (
            <ul role="alert" className="grid gap-1 text-[color:var(--danger)] text-[12px]">
              {phase.errors.map((e, i) => (
                <li key={i}>
                  <span className="font-mono-data text-tertiary mr-2">{e.name}:</span>
                  {e.error}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Update existing `asset-upload-dialog.test.tsx` if it asserts on the old surface**

Re-run the existing test:

```bash
cd apps/web && pnpm vitest run tests/asset-upload-dialog.test.tsx
```

If it fails because the old test assumes a single-stage upload that triggers immediately on file drop, simplify it to only assert image and ZIP paths (which still bypass `videoSetup` in the new implementation). The new `tests/upload-dialog-phase-machine.test.tsx` covers the video flow.

- [ ] **Step 5: Run new + old tests together**

```bash
cd apps/web && pnpm vitest run tests/upload-dialog-phase-machine.test.tsx tests/asset-upload-dialog.test.tsx
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/AssetUploadDialog.tsx apps/web/tests/upload-dialog-phase-machine.test.tsx apps/web/tests/asset-upload-dialog.test.tsx
git commit -m "feat(web): rewrite AssetUploadDialog as pick→videoSetup→uploading phase machine"
```

---

## Task 10: Asset card extracting overlay in `AssetGrid`

**Files:**
- Modify: `apps/web/src/pages/AssetGrid.tsx`
- Create: `apps/web/tests/asset-grid-extract-state.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/tests/asset-grid-extract-state.test.tsx
import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useBackgroundJobs } from "@/state/backgroundJobs";
import { AssetGrid } from "@/pages/AssetGrid";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

const videoAsset = {
  id: "v-1",
  task_id: "t1",
  kind: "video" as const,
  xxh3_128: "h",
  mime: "video/mp4",
  size_bytes: 1,
  width: 16,
  height: 16,
  frames: 0,
  original_name: "clip.mp4",
  created_at: "2026-05-07T00:00:00Z",
  thumbnail_url: null,
  extract_required: true,
};

describe("AssetGrid — extracting state", () => {
  beforeEach(() => {
    useBackgroundJobs.setState({ jobs: {}, expandRequest: null });
  });

  it("renders an extracting overlay when a frame-extract job is running", () => {
    act(() => {
      useBackgroundJobs.getState().add({
        jobId: "j1",
        taskId: "t1",
        kind: "frame-extract",
        label: "Extracting",
        startedAt: Date.now(),
        assetId: "v-1",
        cancel: async () => {},
        progress: {
          status: "running",
          phase: "decoding",
          decoded: 50,
          expected: 200,
          uploaded: 0,
        },
      });
    });
    render(wrap(<AssetGrid taskId="t1" assets={[videoAsset]} />));
    const card = screen.getByTestId("asset-card-v-1");
    expect(card).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/50 \/ 200 frames/i)).toBeInTheDocument();
  });

  it("does not render the overlay when no extract job exists", () => {
    render(
      wrap(
        <AssetGrid
          taskId="t1"
          assets={[{ ...videoAsset, frames: 100, extract_required: false }]}
        />,
      ),
    );
    const card = screen.getByTestId("asset-card-v-1");
    expect(card).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText(/frames/i)).toBeNull();
  });
});
```

(The test assumes the card root has `data-testid={`asset-card-${asset.id}`}`. If `AssetGrid` doesn't already expose that, add it as part of this task. The `AssetGrid` props in the test (`taskId`, `assets`) must match its actual signature — adapt the wrapper to the existing API.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && pnpm vitest run tests/asset-grid-extract-state.test.tsx
```
Expected: FAIL — overlay isn't rendered.

- [ ] **Step 3: Add the extracting overlay to the video card**

In `apps/web/src/pages/AssetGrid.tsx`, locate the per-card render. For `asset.kind === "video"`, call `useAssetExtractStatus(asset.id)` and conditionally render an overlay:

```tsx
import { useAssetExtractStatus } from "@/state/useAssetExtractStatus";

// inside the card sub-component:
const extractStatus = useAssetExtractStatus(asset.id);
const isExtracting = !!extractStatus && extractStatus.status === "running";

return (
  <div
    data-testid={`asset-card-${asset.id}`}
    aria-disabled={isExtracting || undefined}
    className={cn(
      /* existing classes */,
      isExtracting && "pointer-events-none opacity-70",
    )}
    title={isExtracting ? "Extracting frames…" : undefined}
  >
    {/* existing thumb + label */}

    {isExtracting && (
      <div className="absolute inset-x-0 bottom-0 grid gap-1 px-2 py-1.5 bg-[oklch(0.12_0.01_240_/_0.85)]">
        <div className="h-1 rounded-full bg-[oklch(1_0_0_/_0.10)] overflow-hidden">
          <div
            className="h-full bg-[var(--accent)] transition-[width] duration-300"
            style={{
              width: `${
                extractStatus.expected > 0
                  ? Math.min(
                      100,
                      (extractStatus.decoded / extractStatus.expected) * 100,
                    )
                  : 0
              }%`,
            }}
          />
        </div>
        <p className="text-[10.5px] text-[color:var(--text-tertiary)] tabular-nums">
          {extractStatus.decoded} / {extractStatus.expected} frames ({extractStatus.phase})
        </p>
      </div>
    )}
  </div>
);
```

If `AssetGrid` is virtualized and the card is inline, place the overlay in the same render. If the card is a separate sub-component, add it there.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && pnpm vitest run tests/asset-grid-extract-state.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/AssetGrid.tsx apps/web/tests/asset-grid-extract-state.test.tsx
git commit -m "feat(web): extracting overlay + click-block on video asset cards"
```

---

## Task 11: Editor mount-time guard for not-yet-extracted videos

**Files:**
- Modify: `apps/web/src/pages/AnnotateAssetPage.tsx`
- Create: `apps/web/tests/annotate-page-video-guard.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/tests/annotate-page-video-guard.test.tsx
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<any>("@tanstack/react-router");
  return { ...actual, useNavigate: () => navigate };
});

const toast = vi.fn();
vi.mock("@/lib/toast", () => ({ showToast: (...a: any[]) => toast(...a) }));

vi.mock("@/api/assets", () => ({
  assetsApi: {
    get: vi.fn().mockResolvedValue({
      asset: {
        id: "v-1",
        task_id: "t1",
        kind: "video",
        frames: 0,
        original_name: "clip.mp4",
      },
      url: "http://x",
      frame_id: null,
    }),
  },
}));

import { AnnotateAssetPage } from "@/pages/AnnotateAssetPage";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("AnnotateAssetPage — extract guard", () => {
  beforeEach(() => {
    navigate.mockReset();
    toast.mockReset();
  });

  it("redirects with a toast when video has frames==0", async () => {
    render(
      wrap(<AnnotateAssetPage projectId="p" taskId="t1" assetId="v-1" />),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(toast).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && pnpm vitest run tests/annotate-page-video-guard.test.tsx
```
Expected: FAIL — page doesn't redirect.

- [ ] **Step 3: Add the guard**

In `apps/web/src/pages/AnnotateAssetPage.tsx`, after the asset query resolves, add:

```tsx
useEffect(() => {
  if (!data?.asset) return;
  const a = data.asset;
  if (a.kind === "video" && (a.frames ?? 0) === 0) {
    showToast(
      "Frames still extracting — opening when ready",
      { variant: "info" },
    );
    navigate({
      to: "/projects/$projectId/tasks/$taskId",
      params: { projectId, taskId },
    });
  }
}, [data?.asset, navigate, projectId, taskId]);
```

The exact route path string must match this codebase's existing routes — copy from a sibling `navigate({...})` call elsewhere in the file. Add `useNavigate` and `showToast` imports if they aren't already imported.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && pnpm vitest run tests/annotate-page-video-guard.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/AnnotateAssetPage.tsx apps/web/tests/annotate-page-video-guard.test.tsx
git commit -m "feat(web): redirect editor when opened on not-yet-extracted video"
```

---

## Task 12: Full-stack integration smoke test

**Files:**
- Create: `apps/web/tests/video-upload-flow-integration.test.tsx`

- [ ] **Step 1: Write the integration test**

```tsx
// apps/web/tests/video-upload-flow-integration.test.tsx
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/assets", () => ({
  assetsApi: {
    upload: vi.fn(),
    uploadZip: vi.fn(),
    reextractFrames: vi.fn(),
    frameExtractStatus: vi.fn(),
  },
}));

import { assetsApi } from "@/api/assets";
import { useBackgroundJobs } from "@/state/backgroundJobs";
import { AssetUploadDialog } from "@/pages/AssetUploadDialog";
import { BackgroundJobsBar } from "@/components/BackgroundJobsBar";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("video upload + extract integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBackgroundJobs.setState({ jobs: {}, expandRequest: null });
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("drops video → picks strategy → uploads → bar shows progress → completes", async () => {
    (assetsApi.upload as any).mockResolvedValue({
      id: "v-1", kind: "video", extract_required: true,
    });
    (assetsApi.reextractFrames as any).mockResolvedValue({
      job_id: "j-1", strategy: "count", n: 500,
    });
    let decoded = 0;
    (assetsApi.frameExtractStatus as any).mockImplementation(async () => {
      decoded += 50;
      if (decoded >= 200) {
        return {
          status: "completed", phase: "done", decoded: 200, expected: 200,
          uploaded: 200, message: null, job_id: "j-1",
        };
      }
      return {
        status: "running", phase: "decoding", decoded, expected: 200,
        uploaded: 0, message: null, job_id: "j-1",
      };
    });

    const { container } = render(
      wrap(
        <>
          <AssetUploadDialog projectId="p" taskId="t1" />
          <BackgroundJobsBar />
        </>,
      ),
    );

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" })],
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId("frame-extract-strategy-count"))
        .toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("upload-continue"));

    await waitFor(() => expect(assetsApi.reextractFrames).toHaveBeenCalled());
    await waitFor(() => {
      const j = Object.values(useBackgroundJobs.getState().jobs)
        .find((x) => x.kind === "frame-extract");
      expect(j?.assetId).toBe("v-1");
    });

    for (let i = 0; i < 5; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1600);
      });
    }

    await waitFor(() => {
      const j = Object.values(useBackgroundJobs.getState().jobs)
        .find((x) => x.kind === "frame-extract");
      expect(j?.progress?.status === "completed" || j === undefined).toBe(true);
    });

    await act(async () => {
      vi.advanceTimersByTime(5100);
    });
    expect(
      Object.values(useBackgroundJobs.getState().jobs).find(
        (x) => x.kind === "frame-extract",
      ),
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

```bash
cd apps/web && pnpm vitest run tests/video-upload-flow-integration.test.tsx
```
Expected: PASS. (If it fails, the failure should localize to the layer at fault — fix the layer's task, not the test.)

- [ ] **Step 3: Run the full suite to confirm no regressions**

```bash
cd apps/web && pnpm vitest run
cd apps/api && pytest -x
```
Expected: green on both.

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/video-upload-flow-integration.test.tsx
git commit -m "test(web): integration test for video upload + extract flow"
```

---

## Final verification

- [ ] **Manual smoke** — run the dev stack, upload a small `.mp4`, confirm:
  - Strategy panel appears in the same dialog (no second modal stacked on top).
  - Dialog auto-closes ~1s after the upload finishes.
  - `BackgroundJobsBar` shows `"X / Y frames (decoding)"`, then `(uploading)`, then disappears after completion.
  - The video card in `AssetGrid` shows the same progress bar and is non-clickable while extracting.
  - Clicking the card after completion opens the editor with the first frame.
  - Trying to open the editor URL directly while extracting redirects to the task page with an info toast.

- [ ] **No double-extract check** — upload a video; while the first extract is in flight, click the editor toolbar's Re-extract button on it. Expected: 409 → client attaches to the existing job (no error toast, no duplicate row in bar).

---

## Self-review notes

Spec coverage: every spec section has tasks (auto-extract removal → T1; extract_required → T2; 409+stale-key → T3; job_id surface → T4; backgroundJobs ext + hook → T5; bar polling → T6; VideoExtractPanel → T7; FrameExtractDialog reuse → T8; phase-machine dialog → T9; card overlay → T10; editor guard → T11; integration smoke → T12).

Type consistency: `ExtractStrategy` defined in T7, used by T8/T9/T12. `FrameExtractStatusView` defined in T5, consumed in T10. `BackgroundJobKind` already includes `"frame-extract"` (no enum change). `assetId?: string` added in T5 is used in T6 (poller key), T9 (registration), T10 (card lookup). `BackgroundJobProgress` extension in T5 (`phase/decoded/expected/uploaded`) is consumed in T6 (`setProgress` call) and T10 (overlay numerator/denominator).

No placeholders, no "TBD", no "similar to Task N" without code.
