# Mixed-Upload Video Frame Extraction — Design

**Status:** Draft (awaiting review)
**Date:** 2026-05-27
**Owner:** Armin Mehri

## Problem

Today, a task in Carve is either `kind=image` (each asset = one image) or `kind=video` (asset = one video with multi-frame scrubbing in the editor + tracking semantics). A user who wants to annotate a mix of still images *and* sampled frames from a few videos is forced to choose: either create a video task (and lose image-task ergonomics) or extract frames manually outside Carve before upload.

The user wants: drop a mix of images and videos into the upload dialog of an **image** task, pick how many frames to extract per video, and end up with an image task whose assets are the originals + the extracted frames. The original videos go away after extraction (no wasted disk).

## Goal

Extend `AssetUploadDialog` so that when an upload to an `image`-kind task contains one or more videos, the user picks a single extraction policy (mode + params), the server-side worker extracts frames and registers them as image assets, deletes the source videos, and surfaces realtime progress that survives tab close.

## Non-Goals

- Per-video custom extraction params (single param set applies to every video in the batch).
- A new `kind=mixed` task type. The task stays `kind=image`; only the upload pipeline changes.
- A persistent provenance column on `Asset` (`extracted_from_filename`). Provenance lives in `original_name` only (e.g. `race.mp4 — frame 00042.jpg`).
- Pause / resume of in-flight extraction. Cancel + re-upload is the only restart path.
- Live per-frame thumbnails in the progress dialog. Numeric progress only.
- Retry button on a failed video. The user re-uploads.
- Adjusting params after extraction. Frames are permanent; delete + re-upload to redo.

## Approved Design Decisions

| Decision | Choice |
| --- | --- |
| Trigger scope | Any upload to an `image`-kind task. Video-kind tasks unchanged. |
| Param model | One param set applies to every video in the batch. |
| Failure semantics | Best-effort: successful frames are committed; failed videos drop with a named toast. All source videos deleted regardless of success/failure (except two carve-outs: worker crash, disk full). |
| Source video cleanup on **cancel** | Source kept; partial frames kept. |
| Progress UX | Dismissable modal during upload + background-jobs bar entry. |
| Provenance | Encoded only in `original_name`. |
| New task kind | None. Stays `kind=image`. |
| Tracking infra | Existing `jobs` table + RQ worker + WS fanout. No new table. |

## UX Flow

The existing `AssetUploadDialog` wizard gains one conditional step:

1. **Pick files** — current behavior. Dialog inspects MIME types as files are added.
2. **Extraction params** *(only if ≥1 video detected)* — the dialog you mocked up: *"K videos detected. The same setting applies to every video."* Modes: `Auto` (~500 cap) / `All frames` / `Every N-th` / `Total of K (smart)`. Quality slider 1..100. Back / Cancel / Continue.
3. **Confirm** — short summary:
   > Upload **30 images** now.
   > Extract frames from **5 videos** with **Total 500 / quality 75**; the original videos will be deleted after extraction.
   > [Cancel] [Back] **[Upload]**
4. **Progress dialog** — per-video bars + overall bar + ETA. *Run in background* dismisses but the work continues.
5. **Completion toast** — fires once when every job in the batch reaches a terminal state. Variants:
   - All succeeded: *"Added N images (K video extractions)."*
   - Mixed: *"Added N images (K video extractions). M videos failed and were skipped: foo.mp4, bar.mov."*
   - All failed: *"Frame extraction failed for all K videos."* (source videos still deleted per rule)
   - All cancelled: no toast (user already knows).

**Re-open path:** the modal is dismissable to background. The background-jobs bar carries a label + icon for the new job kind; clicking it restores the progress dialog from the GET batch-status endpoint. Closing the tab is safe — work continues server-side, the bar repopulates on return.

## Data Model

**Zero schema changes** to `Asset`, `Frame`, `Task`.

**Reuse the existing jobs table.** Add one new job kind constant: `video_extract_to_images`. Each uploaded video → one row.

| Field | Value |
| --- | --- |
| `kind` | `video_extract_to_images` |
| `task_id` | the destination image task |
| `batch_id` | new nullable UUID column on `Job` — groups multiple jobs from one upload |
| `payload` | `{ source_asset_id, mode, n_or_k, quality }` |
| `status` | `queued` → `running` → `succeeded` / `failed` / `cancelled` |
| `progress` | 0..100 (% of target frames written) |
| `result_summary` | `{ frames_extracted, dedup_skipped, source_filename, error_message? }` on terminal status |

The `batch_id` column is the single schema change in this feature.

**Source-video lifecycle:** standard `Asset(kind=video)` row + MinIO object are created at upload time (same as today). The worker deletes both the row and the object at terminal status, with the two carve-outs documented under "Failure Semantics."

**Provenance:** new image asset's `original_name` is `<source video original_name> — frame <NNNNN>.jpg`. The frame index is the position within the chosen extraction set (0-based), zero-padded to 5 digits.

**Realtime:** the existing `job_updated` WS topic broadcasts on every status/progress change. The progress modal and the background-jobs bar both subscribe. No new WS topic.

## API

All routes nested under the existing project-task routes; auth = existing task-write membership for POSTs, task-read for GET.

### `POST /projects/{pid}/tasks/{tid}/video-extract/batch`

**Body:**
```json
{
  "source_asset_ids": ["uuid", "uuid"],
  "mode": "auto" | "all" | "every_nth" | "total_k",
  "n_or_k": 1,
  "quality": 75
}
```

**Server validates:**
- Task is `kind=image` (else 422).
- Every `source_asset_id` exists in this task and is `kind=video` (else 422).
- Modes / params coherent: `n_or_k > 0` for `every_nth` / `total_k`. `quality` clamped to `[1..100]`.
- No `source_asset_id` already has a `queued`/`running` `video_extract_to_images` job (else 409).

Creates one `Job(kind=video_extract_to_images, batch_id=<fresh uuid>)` per video.

**Response 202:**
```json
{
  "batch_id": "uuid",
  "jobs": [
    { "job_id": "uuid", "source_asset_id": "uuid", "source_filename": "race.mp4" }
  ]
}
```

### `GET /projects/{pid}/tasks/{tid}/video-extract/batch/{batch_id}`

Returns the per-video job rows + their progress. Used by the modal dialog on mount and as a poll fallback if the WS connection drops.

```json
{
  "batch_id": "uuid",
  "jobs": [
    {
      "job_id": "uuid",
      "source_asset_id": "uuid",
      "source_filename": "race.mp4",
      "status": "running",
      "progress": 50,
      "frames_extracted": 250,
      "dedup_skipped": 0,
      "error_message": null
    }
  ]
}
```

404 for an unknown `batch_id`.

### `POST /projects/{pid}/tasks/{tid}/video-extract/batch/{batch_id}/cancel`

Marks all `queued`/`running` jobs in the batch as `cancelled`. The worker polls a cancel flag between frames so cancellation is graceful (no half-written frame).

**Cancel semantics:**

| State at cancel | Source video | Frames extracted so far |
| --- | --- | --- |
| `queued` (not yet running) | kept | none |
| `running` | kept | kept (whatever made it to MinIO) |
| `succeeded` (race) | already deleted | already kept |
| `failed` | already deleted | already kept |

So Cancel = "I changed my mind, leave my videos alone."

## Worker Flow

`queued → running → (extract loop) → succeeded | failed | cancelled`

1. **Lock and load.** Worker pulls the job. Marks status `running`. Fetches source `Asset`; if missing/deleted → `failed` (`"source video gone"`).
2. **Stream from MinIO** into a local temp path (or stdin pipe to ffmpeg — implementation choice).
3. **Probe** the video with `ffprobe` for `duration_s`, `fps`, `frame_count`. If any zero/unreadable → `failed` (`"unreadable video"`).
4. **Compute target frame timestamps** based on mode:
   - `auto`: `frame_count ≤ 500` → all frames; else 500 evenly-spaced.
   - `all`: every frame.
   - `every_nth`: indices `0, N, 2N, …` clipped to last frame.
   - `total_k`: K evenly-spaced timestamps in `[0, duration_s]`.
5. **Extract loop.** For each target frame:
   - Run ffmpeg with the requested quality, capture JPEG bytes.
   - Compute `xxh3_128` content hash.
   - **Dedup guard:** if an Asset with that hash already exists in the task, skip (increment `dedup_skipped`, increment `frames_extracted` to keep progress honest, no DB / MinIO write).
   - Otherwise: insert `Asset(kind=image, …, original_name="<source> — frame NNNNN.jpg")` + `Frame(asset_id, idx=0)`, upload bytes to MinIO.
   - Bump `job.progress` at most once per second (rate-limit to avoid WS spam).
   - Between frames: check `cancel_requested`; if set → `cancelled`, break out of the loop.
6. **Terminal cleanup:**
   - `succeeded` → delete source `Asset` row + MinIO object.
   - `failed` → delete source `Asset` row + MinIO object (subject to the two carve-outs below).
   - `cancelled` → leave source `Asset` intact; leave already-written frames in place.
7. **Final job row update:** terminal timestamp + `result_summary={ frames_extracted, dedup_skipped, source_filename, error_message? }`.

Temp file cleanup is wrapped in a `try/finally`.

**Worker concurrency:** unchanged. RQ runs one job at a time per worker; multiple workers in `docker compose` parallelise. Each job touches its own source asset, so no contention.

## Failure Semantics

Default: failed videos drop with a toast, source deleted, partial frames kept.

**Carve-outs that override the default delete-source-on-failure rule:**
1. **Worker process crash (SIGKILL/OOM):** the worker never reaches the cleanup step → source naturally preserved. Job marked `failed` by RQ's failure handler.
2. **Disk full / write error during extraction:** source is **preserved** because the failure is environmental, not data-quality. Toast guides the user to free space and retry.

Everything else (corrupt video, unreadable bytes, MinIO source missing) follows the default rule.

## Edge Cases

| Scenario | Behavior |
| --- | --- |
| All-images upload | Extraction step skipped; existing flow unchanged. |
| All-videos upload into image task | Extraction step shown; works the same as mixed. |
| `n_or_k <= 0` | 422 with clear message. |
| `K > frame_count` | Treated as `all frames` silently. |
| `quality` outside `[1..100]` | Clamped server-side. |
| Single-frame video | One frame extracted; success. |
| Unreadable / corrupt video | Job `failed` (`"unreadable video"`); source deleted; named in toast. |
| Source Asset deleted between enqueue and worker run | Job `failed` (`"source video gone"`); no cleanup needed. |
| Worker crash mid-extraction | RQ marks job `failed`. Partial frames remain. Source preserved (carve-out 1). |
| Disk full | Job `failed` (`"disk full or write error"`). Source preserved (carve-out 2). |
| WebSocket disconnect during progress | Frontend falls back to polling the GET batch endpoint every 2s until reconnect. |
| User closes the tab mid-extraction | Worker keeps running. On return, jobs bar still shows the batch; click restores the dialog from GET. |
| Concurrent extraction triggered on same source video | Enqueue endpoint returns 409. |
| Duplicate file in same batch (same content hash) | Asset upload UNIQUE constraint dedupes at upload time; one source asset, one job. |
| Frame-content collision across videos in same task | Dedup guard skips silently; progress stays honest. |
| MinIO source object missing while DB row exists | Treated like unreadable video — job `failed`, source row deleted. |

## Test Plan

### Backend unit (pytest)
- Frame-timestamp computation for each mode (boundary: `auto` at exactly 500 frames, `every_nth` past the end, `total_k` with K > frame_count).
- Param validation rejects `n_or_k <= 0`; clamps `quality`.
- Worker dedup-guard: identical hash skipped, no IntegrityError, counters incremented.

### Backend integration
- `POST /…/video-extract/batch`:
  - Happy path with image task + valid videos → 202 + batch shape.
  - Rejections: video-kind task (422), asset not in task (422), asset is image-kind (422), concurrent same source (409).
- `GET /…/video-extract/batch/{batch_id}` returns expected shape; 404 for unknown.
- `POST /…/cancel` flips `queued`/`running` to `cancelled`; leaves terminal states; preserves source videos per the cancel-semantics table.

### Worker integration (small `.mp4` fixture)
- Happy: `total_k=10` → 10 image assets with named `original_name`; source row + MinIO object gone.
- Corrupt video: source deleted, job `failed`.
- Cancellation between frames: partial frames remain, source preserved.
- Worker-crash simulation (kill the process mid-run): no cleanup; source preserved.

### Frontend unit (vitest)
- `AssetUploadDialog` shows the extraction step iff ≥1 file has a video MIME (`video/mp4`, `video/quicktime`, `video/webm`, `video/x-msvideo`).
- Params form validates K/N positive and integer; quality slider snaps to integer.
- Confirm step copy renders the correct counts and params.
- Progress dialog per-video row states (queued/running/succeeded/failed/cancelled) render with correct icons.
- Toast picker: pure-success vs partial vs all-failed vs all-cancelled all produce the right copy.
- `BackgroundJobsBar` shows a label + icon for `video_extract_to_images`.

### E2E (manual, scripted)
1. Image task → upload 2 images + 1 small fixture video → extraction step → confirm → progress → completion. Asset grid shows 2 originals + N extracted frames; source video gone.
2. Same flow → click Cancel mid-extraction → source video remains; partial frames remain; no completion toast.
3. Corrupt video → progress dialog shows failure → toast names the file.

## Coverage Target

Match the project's 80% line-coverage rule for new code in:
- `apps/api/src/carve_api/jobs/video_to_images.py` (new worker module)
- `apps/api/src/carve_api/assets/video_extract.py` or wherever the new endpoints land
- `apps/web/src/components/annotation/AssetUploadDialog.tsx` (modified)
- `apps/web/src/components/annotation/VideoExtractParamsStep.tsx` (new)
- `apps/web/src/components/annotation/VideoExtractProgressDialog.tsx` (new)

## Out of Scope (Future Work)

- Per-video custom params.
- `Asset.extracted_from_filename` column.
- Retry button on failed jobs.
- Pause / resume.
- Live per-frame thumbnails in the dialog.
- Adjusting extraction params after the fact.
