# SAM 3.1 Video Tracking Redesign

**Date:** 2026-05-07
**Author:** Armin Mehri
**Status:** Approved (pending implementation plan)

## Problem

The current video tracking stack carries three competing backends (SAM 2 click,
SAM 3 transformers dispatcher, SAM 3.1 native multiplex), wraps them behind a
generic `TrackerProtocol`, and forces every request through an unnecessary
mp4-stitching round-trip. The UI on top inherits the lowest-common-denominator
of those three and forces all object seeding onto the start frame before any
propagation can begin. The result:

- ~30–60 s of latency before the first prompt can register on a long video,
  driven by per-frame downloads + ffmpeg re-encode that SAM 3.1 doesn't need.
- Lazy `image_size` probing on the first click adds another spike of latency
  even though the dimensions are already in our DB.
- Refining an already-tracked object means deleting it and re-seeding from
  scratch — you can't add positive/negative clicks to an existing `obj_id`.
- Cross-frame seeding (the SAM 3.1 notebook's "seed on frame 0, then refine on
  frame 100") is impossible because the panel only seeds at `currentFrameIdx`
  and locks scrubbing while a session is open.
- No live mask preview during propagation; the user presses *Start* and waits.
- Two text-mode dispatch branches in `track_router.py` exist purely for the
  SAM 3 transformers fallback that we're removing.

The native SAM 3.1 multiplex predictor is a request-style API with five verbs
(`start_session`, `add_prompt`, `propagate_in_video`, `remove_object`,
`reset_session`, `close_session`) and accepts a directory of `<idx>.jpg` files
directly. The wrapping we have today is fighting that grain.

## Goals

- Tracking is **SAM 3.1 multiplex only**. One backend, one code path.
- The model service consumes a directory of JPEGs natively; no mp4 stitching.
- Image size is passed through the API from `Asset.width/height`; no probe.
- The UI supports the SAM 3.1 notebook's full workflow: seed at any frame,
  refine an existing object with point/negative clicks, run propagation,
  re-refine, run again.
- Tracked masks are auto-committed to the annotations store live during
  propagation so the timeline thumbnails update as frames arrive. Discard
  wipes everything by `track_id` in one round trip.
- Smart click semantics: a click inside an existing tracked mask refines that
  object; a click on empty canvas seeds a new one; Alt-click is a negative
  click on whichever object was hit. No mode toggle.
- Class assignment is per-`obj_id` and re-assignable from the panel without
  re-seeding.
- Track button is hidden unless the asset is a video, frames have been
  extracted, and the model service reports SAM 3.1 in `/capabilities`.

## Non-Goals

- WebSocket / SSE streaming of propagation. We chunk-poll instead — simpler.
- Cross-tab session coordination. Each tab opens its own session.
- Backwards compatibility with existing `/sam-track/*` endpoints. Removed
  atomically with the new endpoints.
- Persisting tracker sessions across model-service restarts. Sessions are
  process-local; a restart asks the user to re-open.

## Design

### Backend (model service) — `apps/model/src/carve_model/sam/`

`tracker.py` collapses to a thin session wrapper around the native multiplex
predictor. The `TrackerProtocol` abstraction goes away. Tracking always uses
`build_sam3_multiplex_video_predictor()` from the native `sam3` package, which
becomes a non-optional dependency of the model service.

```python
# tracker.py — new shape
class TrackSession:
    session_id: str          # native predictor session id
    predictor: Any           # singleton multiplex predictor
    image_size: tuple[int, int]
    frame_dir: str           # /tmp/sam-frames/<asset_hash>/
    obj_classes: dict[int, str]  # client-supplied classId per obj_id
    last_used: float

def open_session(*, frame_urls: list[str], image_size: tuple[int, int],
                 asset_hash: str) -> TrackSession: ...
def add_prompt(sid, frame_idx, *, obj_id=None, points=None, labels=None,
               box=None, text=None) -> dict[int, np.ndarray]: ...
def propagate(sid, *, start_frame=None, end_frame=None,
              batch=8) -> Iterator[tuple[int, dict[int, np.ndarray]]]: ...
def remove_object(sid, obj_id): ...
def reset_session(sid): ...
def close_session(sid): ...
```

#### Frame loading

`open_session` downloads each presigned URL into
`/tmp/sam-frames/<asset_hash>/<idx:06d>.jpg`. The directory is content-addressed
by `asset_hash`, so subsequent track sessions on the same video reuse the cache.
A separate sweeper trims the cache when total size exceeds 5 GB. The directory
is passed directly to the native predictor's `start_session`; no ffmpeg
re-encode.

#### Image size

The API supplies `image_size: (h, w)` in the `start_session` body, derived from
`Asset.width/height`. The native multiplex adapter uses it for ABS→REL
coordinate conversion without probing.

### API surface — `apps/model/src/carve_model/sam/track_router.py`

Endpoints rename from `/sam-track/*` to `/track/sessions/*` and mirror the
native SAM 3.1 vocabulary:

```
POST   /track/sessions
       body: { frame_urls: string[], image_size: [h, w] }
       resp: { session_id, frame_count }

POST   /track/sessions/{sid}/prompts
       body: {
         frame_idx: int,
         obj_id?: int,            # omit → server allocates new id
         text?: string,
         points?: [[x, y], ...],  # ABS pixel coords
         labels?: [0|1, ...],     # 1=positive, 0=negative
         box?: [x1, y1, x2, y2]   # ABS pixel coords
       }
       resp: {
         frame_idx,
         masks: { [obj_id]: { counts, size, polygon } }
       }
       422: prompt_required | exclusive_prompt_modes | unknown_obj_id

POST   /track/sessions/{sid}/propagate
       body: { start_frame?: int, end_frame?: int, batch?: int = 8 }
       resp: { frames: [{ frame_idx, masks: {...} }] }
       (chunked; client polls again with last_frame+1 until empty)
       422: no_objects_seeded

DELETE /track/sessions/{sid}/objects/{obj_id}
DELETE /track/sessions/{sid}/prompts          # reset text-mode prompts
DELETE /track/sessions/{sid}                  # close + cleanup
```

The API service (`apps/api/src/carve_api/inference/track.py`, replacing
`sam_track.py`) proxies these under `/assets/{asset_id}/track/...`, performs
asset-permission checks, fetches `Asset.width/height`, and builds the
per-frame presigned URLs from the `Frame` rows. The model service never sees
asset/project identity — only URLs and a session.

### UI — `apps/web/src/`

#### Panel layout (right rail, replaces `SamTrackPanel`)

- Header: `Frame {idx + 1} / {total}` (clickable from the object rows).
- Mode chips: `[Click]` (default) `[Box]` `[Text "person"…]` — only `Box` and
  `Text` are explicit modes; click is the default canvas behavior.
- Hint card: smart-click rules ("click empty → seed new", "click on mask →
  refine that object", "Alt-click for negative").
- Object list: `●color #obj_id className ▸ frame N [P][R][×]` rows.
- Active-class chip with class picker.
- Primary CTA: `[▶ Run full track]` `[✕ Discard]`.
- Progress strip while propagating: `Tracked X / N frames (P%)`.

#### Canvas interactions in track mode

When the active tool is `track`, `AnnotationCanvas` dispatches:

```
ON CLICK at (x, y) on frame F:
  1. Hit-test (x, y) against current-frame masks in masksByFrame[F].
  2. targetObjId = hitObjId or null
     mode       = hit ? "refine" : "new"
     label      = altKey ? 0 : 1
  3. POST /prompts { frame_idx: F, obj_id: targetObjId,
                     points: [[x, y]], labels: [label] }
  4. Server returns masks at F. Panel updates masksByFrame[F].
  5. Panel fires auto-preview: POST /propagate
     ?start_frame=max(0, F-5)&end_frame=min(end, F+5)
     Cancellable via AbortController on the next click.

ON DRAG (rectangle complete) at frame F:
  Same as click but with { box: [x1,y1,x2,y2] }; always allocates a new
  obj_id (boxes don't refine).

ON TEXT submit:
  POST /prompts { frame_idx: F, text: "..." }
  Server returns { masks: { [obj_id]: ... } } with one or more obj_ids
  (multiplex auto-allocates). Each gets a row under the active class.
```

#### Cross-frame seeding

The `FrameTimeline` is fully scrubbable in track mode. The `currentFrameIdx`
flows into every `add_prompt` call, so seeding on frame 0 then frame 47 then
frame 200 is just three clicks on three different scrubbed positions.

#### Auto-preview (±5 frames)

Each prompt fires a non-blocking `POST /propagate?start_frame=F-5&end_frame=F+5`
request. The returned masks render on the timeline thumbnails as a fast
correctness check. ~10 frames of inference per click; cancellable.

#### Run full track + auto-commit

`Run full track` calls `POST /propagate?start_frame=0` in a loop until the
response returns zero frames. Each chunk's masks are written immediately into
the annotations store, keyed by `(frame_id, track_id)` with one stable
`track_id` per `obj_id`. The timeline thumbnails update live as frames arrive.

`Discard` calls a new bulk-delete API
(`DELETE /assets/{id}/annotations:by-track-ids`) followed by panel reset and
session release.

#### Class re-assignment

The `[R]` button on each object row opens a class picker. Picking a class
mutates `obj_classes[obj_id]` in panel state and re-emits the affected
annotations through the store with the new `class_id`. No backend round-trip.

#### Track mode entry point

`EditorToolbar` adds a `Track` button visible only when:

- `asset.kind === "video"`
- `asset.frames > 0`
- `/capabilities` reports `sam_model: "sam3.1"`

Otherwise the button renders disabled with a tooltip explaining why.

## Files

```
apps/model/src/carve_model/sam/
  tracker.py                 — REWRITE (thin session wrapper, native predictor)
  track_router.py            — REWRITE (new /track/sessions/* surface)
  sam3p1_adapter.py          — keep image-predictor side; video adapter
                                merges into tracker.py
  sam3_adapter.py            — DELETE video tracker portion; keep image side
  sam2_adapter.py            — DELETE video tracker portion; keep image side

apps/model/tests/sam/
  test_track_session.py      — NEW
  test_track_router.py       — REWRITE
  test_sam3p1_video_adapter.py — NEW
  test_tracker.py            — DELETE
  test_tracker_multi.py      — DELETE
  test_tracker_resolver.py   — DELETE
  test_multiplex_track_router.py — DELETE

apps/api/src/carve_api/inference/
  track.py                   — NEW (replaces sam_track.py)
  sam_track.py               — DELETE
  model_client.py            — replace sam_track_* helpers with track_*
apps/api/src/carve_api/assets/router.py
                              — add proxy endpoints under /assets/{id}/track/*
apps/api/src/carve_api/annotations/router.py
                              — NEW DELETE /annotations:by-track-ids
apps/api/tests/inference/
  test_track_proxy.py        — NEW
  test_sam_track.py          — DELETE
  test_sam_track_multiplex.py — DELETE
apps/api/tests/annotations/
  test_bulk_delete_by_track.py — NEW

apps/web/src/api/
  track.ts                   — NEW (replaces sam_track.ts)
  sam_track.ts               — DELETE
apps/web/src/state/
  trackBridge.ts             — REWRITE (replaces samTrackBridge.ts)
  samTrackBridge.ts          — DELETE
apps/web/src/canvas/tools/
  TrackTool.ts               — NEW (replaces TrackPropagateTool.ts)
  TrackPropagateTool.ts      — DELETE
apps/web/src/components/annotation/
  TrackPanel.tsx             — NEW (replaces SamTrackPanel.tsx)
  SamTrackPanel.tsx          — DELETE
  AnnotationCanvas.tsx       — modify click/drag dispatch in track mode
  FrameTimeline.tsx          — modify (scrub-to-seed in track mode)
  EditorToolbar.tsx          — Track button entry point
apps/web/tests/
  track-tool.test.ts         — NEW
  track-panel.test.tsx       — NEW
  track-bridge.test.ts       — NEW
  track-flow-integration.test.tsx — NEW
  v35-sam-track-panel.test.tsx — DELETE
  track-propagate-tool.test.ts — DELETE
  sam-track-multiplex-panel.test.tsx — DELETE
```

## Component contracts

```ts
// apps/web/src/api/track.ts
export interface OpenSessionResp {
  session_id: string;
  frame_count: number;
}

export interface PromptIn {
  frame_idx: number;
  obj_id?: number;
  text?: string;
  points?: [number, number][];
  labels?: number[];
  box?: [number, number, number, number];
}

export interface FrameMasks {
  frame_idx: number;
  masks: Record<number, { counts: string; size: [number, number]; polygon: [number, number][] }>;
}

export interface PromptResp extends FrameMasks {}
export interface PropagateResp { frames: FrameMasks[]; }

export const trackApi = {
  open: (assetId: string) => Promise<OpenSessionResp>,
  prompt: (assetId: string, sid: string, body: PromptIn,
           signal?: AbortSignal) => Promise<PromptResp>,
  propagate: (assetId: string, sid: string,
              opts: { start_frame?: number; end_frame?: number; batch?: number },
              signal?: AbortSignal) => Promise<PropagateResp>,
  removeObject: (assetId: string, sid: string, objId: number) => Promise<void>,
  resetPrompts: (assetId: string, sid: string) => Promise<void>,
  close: (assetId: string, sid: string) => Promise<void>,
};
```

```ts
// apps/web/src/state/trackBridge.ts
type Status =
  | "idle" | "seeding" | "previewing" | "running" | "done" | "failed";

interface TrackBridge {
  sessionId: string | null;
  status: Status;
  objects: Map<number, { classId: string; seedFrame: number; seedKind: "click"|"box"|"text" }>;
  trackIds: Map<number, string>;
  masksByFrame: Map<number, Map<number, { counts: string; size: [number, number]; polygon: [number, number][] }>>;
  framesPropagated: number;
  totalFrames: number;
  errorMessage: string | null;

  openSession(assetId: string): Promise<void>;
  prompt(args: PromptIn): Promise<void>;
  runFullTrack(): Promise<void>;
  cancel(): void;
  discard(): Promise<void>;
  close(): Promise<void>;
  reassignClass(objId: number, classId: string): void;
  removeObject(objId: number): Promise<void>;
}
```

## Data flow

```
User opens video editor
  → AnnotationCanvas mounts, frames query resolves
  → Track button visible if SAM3.1 capable + frames>0

User clicks Track button
  → useTool.setActiveTool("track")
  → TrackPanel opens; status=idle
  → trackBridge.openSession(assetId)
       POST /assets/{id}/track/sessions
       API: build presigned frame URLs, POST to model service
       Model: download frames into cache, init_state on dir
  → status=seeding

User scrubs to frame F, clicks (x, y) on canvas
  → AnnotationCanvas.onCanvasClick reads track mode
  → hit-test masksByFrame[F] for (x, y)
  → trackBridge.prompt({ frame_idx: F, obj_id: hit?.obj_id,
                         points: [[x, y]], labels: [altKey?0:1] })
       POST /prompts
       resp.masks merged into masksByFrame[F]
  → status=previewing
  → fire /propagate?start_frame=F-5&end_frame=F+5 with AbortController
  → preview chunks merge into masksByFrame
  → status=seeding

User clicks Run full track
  → status=running
  → loop POST /propagate?start_frame=last+1 until response.frames.length===0
  → for each chunk:
       merge masksByFrame
       upsert annotations: id=hash(frameId, trackId), kind=polygon,
         class_id=obj_classes[obj_id], track_id=trackIds[obj_id]
       framesPropagated += chunk.length
  → status=done

User clicks Discard
  → trackBridge.discard()
       DELETE /assets/{id}/annotations:by-track-ids { track_ids: [...] }
       DELETE /assets/{id}/track/sessions/{sid}
       annotationsStore.removeMany(byTrackIds)
       reset bridge state
  → status=idle

User closes panel without Discard
  → trackApi.close (best-effort) — server cleans up cache
  → bridge resets except for any committed annotations
```

## Error handling

| Scenario | Behavior |
|---|---|
| Click before session opens | Panel opens session lazily; click queued and replayed once session is ready. |
| Frame-cache download fails partway | Model returns 502 `frame_cache_failed`. Panel toasts retry option. |
| `add_prompt` text returns no masks | Panel toasts "No matches for X". No object row created. |
| Refine on stale `obj_id` | API returns 422 `unknown_obj_id`. Panel falls back to creating a new object with the same click. |
| Worker restart mid-session | Next request 404 `session_not_found`. Panel offers "Re-open session" — re-opens and replays the local prompt log. |
| Two tabs open same asset | Each gets its own session. Last commit wins on save. |
| Class deleted mid-session | At commit time, fall back to project's first class with a warning toast. |
| Cancel during propagation | Abort in-flight request; masks already committed remain. Status → `done`. |
| GPU OOM during propagation | Model returns 502 `gpu_oom`. Panel toasts "Try shorter segment or restart model service." |
| Asset has 0 extracted frames | Track button disabled. |

## Testing

Per `rules/common/testing.md`, 80% coverage minimum.

```
apps/model/tests/sam/test_track_session.py
  - open_session writes frame cache, returns session_id
  - cache reused on second open_session for same asset_hash
  - close_session evicts and cleans

apps/model/tests/sam/test_track_router.py
  - POST /track/sessions returns session_id + frame_count
  - POST /prompts (text) auto-allocates obj_ids
  - POST /prompts (point + obj_id) refines existing
  - POST /prompts (point + box) → 422 exclusive_prompt_modes
  - POST /prompts (none) → 422 prompt_required
  - POST /prompts (stale obj_id) → 422 unknown_obj_id
  - POST /propagate streams chunks; last empty
  - POST /propagate (no objects) → 422 no_objects_seeded
  - DELETE /objects/{id} removes from session
  - DELETE /sessions/{sid}/prompts resets text-mode
  - DELETE /sessions/{sid} releases + cleans cache

apps/model/tests/sam/test_sam3p1_video_adapter.py
  - native predictor sees JPEG dir (no mp4 stitch)
  - image_size from API skips probe
  - hit-test contains() helper for RLE masks

apps/api/tests/inference/test_track_proxy.py
  - asset permission check rejects 403
  - frame URLs derived from Asset.xxh3_128 + Frame rows
  - image_size from Asset.width/height
  - 422 from model surfaces as 422

apps/api/tests/annotations/test_bulk_delete_by_track.py
  - bulk delete by track_ids removes all matching annotations
  - cascade respects task permission

apps/web/tests/track-tool.test.ts
  - smart hit-test → refine vs. new
  - Alt-click → label=0
  - cross-frame seed uses currentFrameIdx
  - auto-preview cancels on subsequent click

apps/web/tests/track-panel.test.tsx
  - text submit → rows for each obj_id
  - class re-assign updates store annotations
  - run full track auto-commits each chunk
  - discard wipes by track_ids and resets

apps/web/tests/track-bridge.test.ts
  - state machine transitions follow design

apps/web/tests/track-flow-integration.test.tsx
  - drop video → seed obj on frame 0 → preview → seed obj on frame 50 →
    run full track → masks land in annotations store
```

## Migration / rollout

- The legacy `/sam-track/*` endpoints and the SAM 2 / SAM 3 (transformers)
  tracker code are removed in the same release as the new endpoints land.
  No compatibility shim. Tabs open at deploy time will fail their next
  track request with 404 — expected, user refreshes.
- `SAM_VIDEO_BACKEND` env var is retired (tracking is multiplex-only).
- The native `sam3` package becomes a non-optional dependency of the model
  service. Already present in the model Dockerfile.
- No DB schema changes. `track_id` already exists on `annotations`.

## Open questions

None at design time.
