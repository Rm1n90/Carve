# Resume Task Progress — Design

**Status:** Draft (awaiting review)
**Date:** 2026-05-26
**Owner:** Armin Mehri

## Problem

A task can contain up to ~1,000 images. An annotator working through them sequentially currently has no way to remember where they stopped after closing the app, switching projects, or moving to a different machine. They reopen the task at the beginning and re-check each image one-by-one to find their last annotated frame. With multiple users working in parallel on the same task, the resume position must be tracked per user — not as a single shared cursor.

## Goal

When a user reopens a task in which they have prior annotations, surface a non-intrusive banner offering to jump back to their last annotated frame, including a progress count ("N of M annotated").

## Non-Goals

- A shared / team-wide cursor (each user's resume is independent).
- Storing the *last selected bounding box* — resume targets the frame, not a specific annotation within it.
- Surfacing other users' progress in the banner (out of scope for this iteration).
- Marking frames as "reviewed / empty" without an annotation (would need a new action; out of scope).
- Persisting "Dismiss" across task re-opens (intentionally session-only).

## Approved Design Decisions

| Decision | Choice |
| --- | --- |
| Resume scope | Per-user, per-task |
| Resume UX | Banner with "Resume" and "Dismiss" buttons; non-intrusive |
| What counts as "last position" | Last frame with a saved annotation by the user |
| Storage approach | Derive from existing `annotations` table — no new table |
| Timestamp field | `updated_at` (captures edits to old annotations, not just creates) |
| Dismiss persistence | In-memory, lifetime of the task page only |
| Resume target | Frame id (the asset), not a specific annotation |

## Data Model

**No schema changes.** Resume is derived from the existing `annotations` table:

```python
# apps/api/src/carve_api/annotations/models.py
class Annotation(Base):
    task_id: UUID            # already indexed
    frame_id: UUID | None    # nullable for tag-kind annotations
    created_by: UUID | None  # nullable on user deletion (SET NULL)
    created_at: datetime
    updated_at: datetime     # server_default + onupdate
    ...
```

### New index

Resume reads run on every task open, so they need a dedicated covering index:

```sql
CREATE INDEX ix_annotations_task_user_updated
  ON annotations (task_id, created_by, updated_at DESC)
  WHERE frame_id IS NOT NULL;
```

Migration: single-statement Alembic revision, no data backfill.

### Resume query (single row)

```sql
SELECT frame_id, updated_at
FROM annotations
WHERE task_id = :task_id
  AND created_by = :user_id
  AND frame_id IS NOT NULL
ORDER BY updated_at DESC
LIMIT 1;
```

### Annotated-count query (companion)

```sql
SELECT COUNT(DISTINCT frame_id)
FROM annotations
WHERE task_id = :task_id
  AND created_by = :user_id
  AND frame_id IS NOT NULL;
```

Reuses the same index. Both queries together are sub-millisecond on indexed lookups.

## API

### New endpoint

```
GET /projects/{project_id}/tasks/{task_id}/resume
```

All task routes in this codebase are project-scoped (mounted via `projects/router.py`); the new route mirrors the existing `/projects/{project_id}/tasks/{task_id}/completion-status` shape.

**Auth:** existing task-access middleware (user must be a project member with task visibility). The authenticated user is the `:user_id` — clients never pass a user id.

**Response (200):**

```json
{
  "last_asset_id": "a4e2…",
  "last_frame_id": "f1b8…",
  "annotated_assets": 350,
  "total_assets": 1000,
  "last_activity_at": "2026-05-26T16:04:00Z"
}
```

When the user has no annotations in this task:

```json
{
  "last_asset_id": null,
  "last_frame_id": null,
  "annotated_assets": 0,
  "total_assets": 1000,
  "last_activity_at": null
}
```

**Field-naming rationale:** `total_assets` and `annotated_assets` mirror the existing `TaskCompletionStatus` endpoint so future readers see one consistent vocabulary. Annotations are stored against frames, but the editor URL routes by asset — so the response returns both: `last_asset_id` (the routing key the banner uses) and `last_frame_id` (kept for future video deep-link).

**Errors:** 401 unauthenticated, 403 no task access, 404 task not found. No bespoke error codes.

**No caching.** Sub-ms read; stale data is more confusing than fresh data.

**Location:** new route handler under `apps/api/src/carve_api/tasks/routes.py` (or the closest existing task routes module — match current layout when implementing).

## Frontend

### Hook

`useTaskResume(taskId: string)` — TanStack Query wrapper around `GET /tasks/{taskId}/resume`. Fetches once on mount of `AnnotateAssetPage`. No polling. No automatic refetch on annotation save (the user is already at their latest position by the time they save).

### Banner component

`<ResumeProgressBanner />`

**Placement:** top of `AnnotateAssetPage.tsx`, between the toolbar and the canvas, full editor width.

**Copy:**

> You last annotated **{annotated_count} of {task_frame_count}** images here — last activity **{relativeTime}**.
> [ Resume there ] [ Dismiss ]

`relativeTime` is rendered via `Intl.RelativeTimeFormat` (e.g., "moments ago", "yesterday").

**Show/hide truth table:**

| Condition | Banner |
| --- | --- |
| Query loading | hidden |
| `last_frame_id === null` | hidden |
| `last_frame_id === currentAssetId` | hidden |
| Dismissed during this task-page lifetime | hidden |
| Otherwise | **shown** |

**Interaction:**

- **Resume click:** navigate to the editor route for `last_frame_id`, then hide the banner.
- **Dismiss click:** set an in-memory flag; banner stays hidden for the rest of the task page lifetime. The flag does NOT persist; next time the task is re-opened, the banner returns.
- **Multi-user:** each user fetches their own resume; no cross-user UI interaction.

## Edge Cases

| Case | Behavior |
| --- | --- |
| User has never annotated in this task | `last_frame_id: null` → no banner. |
| User's last annotation was deleted | Query falls back to the next most recent annotation. If all deleted → `null` → no banner. |
| Resumed frame was deleted | FK cascade removes the annotation row with the frame; query already picks the next valid one. No special code. |
| `created_by` is NULL (deleted account, model predictions) | Naturally excluded by `created_by = :user_id`. New users start fresh. |
| User accepted a model prediction (status change) | If the row's `created_by` is the user, it counts. If not, it doesn't. Matches user expectation. |
| Deep link to a specific image | Banner still appears unless that image *is* the resume target. User chooses to jump or stay. |
| Task with zero frames | `annotated_count: 0`, `task_frame_count: 0`, `last_frame_id: null` → no banner. |
| `updated_at` touched by reviewer status change | Reviewer marking your annotation accepted/rejected shifts `updated_at`. Resume target may move slightly. Acceptable in v1; documented quirk. **Mitigation if needed later:** filter `reviewed_by_id IS NULL OR reviewed_by_id = created_by`. |
| Two simultaneous tabs | Each fetches independently on mount. Tab opened later sees the newer position. No locking. |
| Realtime: annotation deleted by another user while banner is open | Banner is informational, not a lock. If Resume now points at a deleted frame, the editor's existing 404 handling takes over. |
| Banner copy under 1 hour | Renders "moments ago" via `Intl.RelativeTimeFormat`, localized. |

## Test Plan

### Backend (pytest)

- **Resume query — unit:**
  - returns `None` when user has no annotations in task
  - returns the frame with the latest `updated_at`
  - excludes annotations with `frame_id IS NULL`
  - excludes annotations by other users
  - excludes annotations with `created_by = NULL`
- **Annotated-count query — unit:**
  - returns 0 when no annotations
  - returns distinct count, not raw row count (multiple bboxes on one frame count once)
- **API integration:**
  - `GET /tasks/{id}/resume` returns the documented shape
  - 401 without auth, 403 for non-member, 404 for unknown task
  - Per-user isolation: two users on the same task get independent results

### Frontend (vitest)

- **`useTaskResume` hook:**
  - loading state
  - null `last_frame_id` returns "no banner needed" signal
  - populated state returns parsed fields
- **`<ResumeProgressBanner />` component:**
  - hidden during loading
  - hidden when `last_frame_id` is null
  - hidden when `last_frame_id` equals current asset
  - shown when populated and not on that asset
  - Dismiss click hides and stays hidden
  - Resume click invokes the expected navigation
  - Relative-time text renders ("yesterday", "moments ago")

### E2E (Playwright)

Happy path:
1. Open a task as user A.
2. Annotate frames 1–5.
3. Close the task page.
4. Reopen the task — banner shows "5 of N".
5. Click Resume — editor lands on frame 5.

Multi-user isolation:
1. User A annotates frames 1–5; user B annotates frames 100–105 on the same task.
2. Each user reopens the task — each sees their own banner with their own count.

## Coverage Target

Match the project's testing rules (80% line coverage minimum) for new code in:
- `apps/api/src/carve_api/tasks/` (new route + resume service function)
- `apps/web/src/components/annotation/ResumeProgressBanner.tsx`
- `apps/web/src/hooks/useTaskResume.ts`

## Open Questions

None blocking. The `updated_at`-shifted-by-review quirk is documented as a known minor effect; a follow-up can refine the filter if it shows up in real use.

## Out of Scope (Future Work)

- Team-wide progress overlay ("team is at 850/1000").
- "Jump to next un-annotated frame" action (different feature, different semantics).
- Per-asset reviewed/empty marker so users can mark "no objects here" and still advance the cursor.
- Persisting dismissal across sessions if user feedback shows session-only is annoying.
