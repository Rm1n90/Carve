# Video Upload + Frame Extraction Flow Redesign

**Date:** 2026-05-07
**Author:** Armin Mehri
**Status:** Approved (pending implementation plan)

## Problem

Today's video upload flow is broken in four observable ways:

1. **Two stacked dialogs.** `AssetUploadDialog` (rendered as an inline `<section>`) opens `FrameExtractDialog` on top of itself after upload `onSuccess`. The user sees both at once. The first never dismisses.
2. **No realtime progress.** The backend already writes Redis-backed extraction progress (`apps/api/src/carve_api/jobs/frames.py`, key `frame-extract:{asset_id}`). The frontend has `assetsApi.frameExtractStatus` and a `BackgroundJobsBar` with a `"frame-extract"` job kind. None of it is wired — the client just shows a static "Extracting frames…" toast and walks away.
3. **Auto-extraction races user choice.** A worker tail in `apps/api/src/carve_api/jobs/thumbs.py` auto-enqueues frame extraction at upload. Then the user-facing dialog kicks a *second* extraction with the user's chosen strategy. Two competing jobs run against the same asset.
4. **Editor opens with zero frames.** Nothing blocks navigation to `AnnotateAssetPage` for a video whose `frames == 0`. The user lands in a broken editor.

## Goals

- A single, linear, modal-free flow from drop to background-extraction.
- Live progress visible in a persistent surface (background bar) and on the asset card.
- Editor cannot be opened until extraction completes.
- One extraction per asset at a time. No silent auto-extraction.

## Non-Goals

- Per-video custom strategies in the upload batch (one strategy applies to all). Per-video override remains available later via the editor toolbar's existing **Re-extract** button.
- Cancel-in-flight controls. Out of scope for this revision.
- Changes to SAM video tracking, the timeline component, or annotation propagation.

## Design

### User Flow (state machine)

`AssetUploadDialog` becomes a single modal with three internal phases. No nested dialogs.

```
Phase A — PICK
  Dropzone visible. User drops files.
  Files split: images[], videos[].
  videos.length == 0 → jump to Phase C
  videos.length  > 0 → Phase B

Phase B — VIDEO SETUP
  Dropzone hides. Inline panel shows:
    "N videos detected — pick frame extraction strategy"
    Strategy radios: Auto | All | Every Nth | Count K   (default: Count K=500)
    Quality slider 0–100 (default 75)
    [Back]                              [Cancel] [Continue]
  Back     → Phase A (clears file list)
  Continue → Phase C, attaching {strategy, n, quality}

Phase C — UPLOAD + KICK
  Body swaps to compact progress: "Uploading 12/40…"
  Per file: POST /assets (image OR video).
  For each video, on its own upload success:
    POST /assets/{id}/frames/extract { strategy, n, quality }
    backgroundJobs.register({ kind: "frame-extract", assetId, jobId })
  When all files uploaded:
    1s grace + summary toast → dialog auto-closes.
    BackgroundJobsBar takes over progress reporting.
```

### Progress surface (after dialog closes)

The existing `BackgroundJobsBar` shows aggregate live progress. Each registered `frame-extract` job has a poller (1.5s interval) calling `GET /assets/{id}/frames/extract/status`. On `status === "completed"` or `"failed"`:

- Clear interval.
- Invalidate React Query keys: `["task-assets", taskId]`, `["task-assets-count", taskId]`, `["frames", assetId]`.
- Remove job from store after a 5s grace fade.

Per-asset card (in `AssetGrid`) reads from the same store via a new `useAssetExtractStatus(assetId)` hook — no duplicate pollers per asset. While a video's extract is `running`:

- Thin progress bar at card bottom: `"312 / 500 frames"`.
- Card click target: `pointer-events-none`, `aria-disabled`, `title="Extracting frames…"`.
- Editor open button disabled.

### Editor gating

`AnnotateAssetPage` mount-time guard: if asset is a video with `frames === 0`, redirect back to the task page with `showToast("Frames still extracting — opening when ready", { variant: "info" })`. Defense in depth — the asset card already prevents the click in normal flow.

### Backend changes

**Kill the auto-extract race.** Remove the auto-enqueue tail from `apps/api/src/carve_api/jobs/thumbs.py`. Frame extraction becomes explicit-only.

**Upload response carries an extraction hint.** `AssetOut` gains `extract_required: bool = False` (true for videos with `frames == 0` and no in-flight job). The client uses it to decide whether to call `/frames/extract`, instead of guessing based on file extension.

**Idempotency on `POST /assets/{id}/frames/extract`.**
```python
existing = redis.hgetall(f"frame-extract:{asset_id}")
if existing.get("status") == "running":
    return 409, {"error": "extract_in_progress", "job_id": existing.get("job_id")}
```
Client uses the returned `job_id` to attach to the in-flight job rather than failing.

**Status payload includes `job_id`.** `extract_frames_for_video` writes `_r.hset(progress_key, "job_id", str(job.id))` immediately after enqueue. The status endpoint includes it in the response so the client poller can correlate.

**Stale Redis key cleanup.** On a fresh `POST /frames/extract`, if Redis says `status:running` but `rq.job.Job.fetch(job_id)` raises `NoSuchJobError`, clear the stale key before enqueueing.

No DB schema changes. `assets.frames` is the readiness source of truth; Redis covers in-flight progress.

## Files

```
apps/api/src/carve_api/jobs/thumbs.py            — remove auto-extract tail
apps/api/src/carve_api/jobs/frames.py            — write job_id to redis
apps/api/src/carve_api/assets/router.py          — 409 on duplicate POST,
                                                    stale-key cleanup,
                                                    extract_required in response
apps/api/src/carve_api/assets/schemas.py         — extract_required field

apps/web/src/pages/AssetUploadDialog.tsx         — REWRITE as phase machine
apps/web/src/components/annotation/
  VideoExtractPanel.tsx                          — NEW: pure presentational
                                                    panel, reused by upload
                                                    dialog and re-extract dialog
apps/web/src/components/annotation/
  FrameExtractDialog.tsx                         — refactor to consume
                                                    VideoExtractPanel; only
                                                    used by editor toolbar
apps/web/src/state/backgroundJobs.ts             — frame-extract poller +
                                                    useAssetExtractStatus hook
apps/web/src/components/BackgroundJobsBar.tsx    — render frame-extract rows
apps/web/src/pages/AssetGrid.tsx                 — extracting overlay on
                                                    video cards
apps/web/src/pages/AnnotateAssetPage.tsx         — redirect guard for
                                                    frames==0 videos
```

## Component contracts

```ts
// apps/web/src/components/annotation/VideoExtractPanel.tsx
export type ExtractStrategy = {
  strategy: "auto" | "all" | "every_nth" | "count";
  n: number | null;
  quality: number;
};

interface VideoExtractPanelProps {
  videoCount: number;
  value: ExtractStrategy;
  onChange: (next: ExtractStrategy) => void;
}
```

```ts
// apps/web/src/state/backgroundJobs.ts
interface FrameExtractProgress {
  status: "running" | "completed" | "failed";
  phase: "decoding" | "uploading" | "done";
  decoded: number;
  expected: number;
  uploaded: number;
  jobId?: string;
  message?: string;
}

// New hook — single source of truth, no per-card pollers.
export function useAssetExtractStatus(
  assetId: string,
): FrameExtractProgress | undefined;
```

```ts
// apps/web/src/pages/AssetUploadDialog.tsx
type Phase =
  | { kind: "pick" }
  | { kind: "videoSetup"; images: File[]; videos: File[]; strategy: ExtractStrategy }
  | { kind: "uploading"; done: number; total: number; errors: UploadError[] };
```

## Data flow

```
User drops files
  → split images[] | videos[]
  → if videos.length > 0: phase=videoSetup, hold files in component state
  → else: phase=uploading, start upload pool

Continue from videoSetup
  → phase=uploading
  → upload pool (existing concurrency=6 worker pattern)
  → for each successful video upload:
       POST /assets/{id}/frames/extract → { job_id }
       backgroundJobs.register({ kind:"frame-extract", assetId, jobId })
       (poller starts; lives independently of the dialog)

All uploads complete
  → 1s grace + summary toast
  → dialog closes

BackgroundJobsBar
  → reads jobs from store, polls each one's status
  → on completed/failed: invalidate queries, remove after 5s

AssetGrid card (parallel)
  → useAssetExtractStatus(asset.id) → reads from same store
  → renders inline progress + disables click while running

AnnotateAssetPage mount
  → if asset.kind=="video" && asset.frames==0: redirect + toast
```

## Error handling

| Failure | Behavior |
|---|---|
| Upload of a single file fails | Existing per-file error row in dialog; other files continue. Video that failed to upload: no extract kicked. |
| `POST /frames/extract` returns 409 (already running) | Client attaches to the returned `job_id`; treats as success. |
| `POST /frames/extract` returns other error | Toast on dialog close: "Extraction failed for N videos — re-extract from the editor." Asset card shows no extracting state; user can retry via toolbar. |
| Status poll fails repeatedly (5 consecutive errors) | Mark job `failed` in store with message; bar shows error state; user can retry via editor toolbar. |
| ffmpeg fails inside the worker | Worker writes `status:"failed"` + `message` to Redis (already implemented). Client surfaces in bar. |
| Stale `running` key with no live RQ job | Server-side cleanup before re-enqueue (described in Backend changes). |

## Testing

Per `rules/common/testing.md`, 80% coverage minimum. Unit + integration + E2E.

```
apps/api/tests/jobs/test_frames_progress.py
  - decoded/expected/uploaded transitions
  - phase decoding → uploading → done
  - failure path writes status:failed + message

apps/api/tests/assets/test_extract_router.py
  - 409 on duplicate POST
  - 409 response includes job_id
  - stale-key cleanup re-enqueues successfully
  - extract_required field correct for image vs video

apps/api/tests/jobs/test_thumbs_no_autoextract.py
  - thumbs job does not enqueue extract_frames_for_video

apps/web/tests/upload-dialog.test.tsx
  - phase: pick → videoSetup → uploading → close
  - no-video drop skips videoSetup
  - cancel from videoSetup returns to pick and clears files
  - back from videoSetup returns to pick

apps/web/tests/asset-grid-extract-state.test.tsx
  - extracting overlay renders when status==running
  - card non-clickable while running
  - overlay clears on completed
  - editor open button disabled while running

apps/web/tests/background-jobs-bar.test.tsx
  - frame-extract job shows decoded/expected
  - phase label switches decoding → uploading
  - auto-removes 5s after completed

apps/web/e2e/video-upload.spec.ts
  - drop video → strategy picker shown
  - pick Count=10 → Continue → dialog closes
  - background bar shows progress
  - asset card shows extracting state
  - editor open disabled while extracting
  - bar clears + card unlocks on completion
  - opening editor after completion shows first frame
```

## Migration / rollout

- No DB migration. Redis keys are TTL'd, so any in-flight extractions at deploy time will either complete or expire naturally.
- Removing the auto-extract tail in `thumbs.py` is the only behavior change visible to existing users. Mitigation: the upload dialog now always supplies a strategy, so the auto-extract was only valuable as a fallback for direct-API uploads. Direct-API users can call `/frames/extract` themselves; documented in the API surface.

## Open questions

None at design time.
