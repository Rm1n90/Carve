# YOLOE — multi-asset visual references (v3.24)

**Date:** 2026-05-06
**Author:** Armin Mehri
**Version:** v3.24
**Builds on:** v3.23.7 (single-source visual prompts)

---

## 1. Goal

Let the user build up a richer YOLOE visual prompt by picking
reference bboxes/polygons from **multiple assets** in the task, with
per-pick class assignment. Run the result on either the current
asset or every asset in the task. The output should be **better
detections** (more reference variability captures more of a class's
visual diversity), with **more freedom** for the user, while
preserving the cancel/background/progress UX from v3.23.6.

---

## 2. Why this is non-trivial

YOLOE's `model.predict(target, refer_image=ref, visual_prompts=...)`
takes **one** reference image. Visual prompts inside that dict are
parallel `bboxes`/`cls` arrays, all interpreted in the reference
image's coordinate space.

To use refs from *N* different source assets, we have to call YOLOE
*N* times per target asset, then merge per-target detections across
the *N* passes (with cross-source NMS to dedupe). There is no native
multi-reference API; the api service must orchestrate the loop.

---

## 3. Wire shape

### Old (v3.23.7)

```jsonc
// POST /assets/{asset_id}/yoloe/visual
{
  "refer_asset_id": "<uuid>",       // single source
  "groups": [                       // groups inside that one source
    {"class_id": "<uuid>", "bboxes": [[x1,y1,x2,y2], ...]}
  ]
}
```

### New (v3.24)

```jsonc
// POST /assets/{asset_id}/yoloe/visual
{
  "sources": [                      // one entry per distinct source asset
    {
      "asset_id": "<uuid>",
      "groups": [
        {"class_id": "<uuid>", "bboxes": [[x1,y1,x2,y2], ...]}
      ]
    },
    ...
  ]
}
```

For backward compatibility on the wire, the legacy `refer_asset_id`
+ top-level `groups` shape is still accepted: the api converts it
into a `sources: [{asset_id: refer_asset_id, groups: groups}]`
structure internally. The frontend ships the new shape exclusively.

The same `sources` shape goes into the batch payload's `params` dict.

---

## 4. Server-side orchestration

### `apps/api/src/carve_api/inference/yoloe.py`

New dataclass:

```python
@dataclass
class YoloeVisualSource:
    asset_id: uuid.UUID
    refer_bytes: bytes              # fetched once at endpoint time
    groups: list[YoloeVisualGroup]  # class -> bboxes inside THIS source
```

`YoloeVisualParams` becomes:

```python
@dataclass
class YoloeVisualParams:
    sources: list[YoloeVisualSource]
    conf: float = 0.25
    iou: float = 0.7
```

`predict_for_asset(image_bytes, mode=visual, params)` loops:

```python
all_detections, all_polygons = [], []
token_to_class_id: dict[str, uuid.UUID] = {}

for source in params.sources:
    flat_bboxes, flat_cls, class_name_tokens = _flatten_groups(source.groups)
    if not flat_bboxes:
        continue
    for token, group in zip(class_name_tokens, source.groups):
        token_to_class_id[token] = group.class_id

    sub = yoloe_visual_predict(
        image_b64,
        _b64(source.refer_bytes),
        flat_bboxes, flat_cls, class_name_tokens,
        conf=params.conf, iou=params.iou,
    )
    all_detections.extend(sub.get("detections") or [])
    all_polygons.extend(sub.get("polygons") or [])

# Cross-source NMS (greedy, per-class)
all_detections = _nms_dedupe(all_detections, iou_threshold=0.6)
all_polygons   = _nms_dedupe(all_polygons,   iou_threshold=0.6)

return {
    "detections": all_detections,
    "polygons": all_polygons,
    "_token_to_class_id": token_to_class_id,
}
```

### NMS helper (handles both bbox and polygon shapes)

```python
def _bbox_xyxy(d: dict) -> tuple[float, float, float, float]:
    if "bbox" in d:
        b = d["bbox"]
        return (b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"])
    pts = d.get("points") or []
    if not pts:
        return (0.0, 0.0, 0.0, 0.0)
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def _iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw = max(0.0, ix2 - ix1); ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    ua = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    ub = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = ua + ub - inter
    return (inter / union) if union > 0 else 0.0


def _nms_dedupe(dets: list[dict], iou_threshold: float) -> list[dict]:
    """Per-class greedy NMS across detections from multiple sources."""
    by_class: dict[str, list[dict]] = {}
    for d in dets:
        by_class.setdefault(str(d.get("class_name", "")), []).append(d)
    out: list[dict] = []
    for _, group in by_class.items():
        group.sort(key=lambda d: float(d.get("confidence", 0.0)), reverse=True)
        kept_xyxy: list[tuple[float, float, float, float]] = []
        for cand in group:
            cx = _bbox_xyxy(cand)
            if any(_iou(cx, kx) > iou_threshold for kx in kept_xyxy):
                continue
            kept_xyxy.append(cx)
            out.append(cand)
    return out
```

### `apply_yoloe_to_asset`

No change. The persistence loop iterates the merged `detections` /
`polygons` and uses the `_token_to_class_id` resolver — same code
path the v3.23.7 single-source flow uses.

### `apps/api/src/carve_api/inference/router.py`

Endpoint validates, fetches each source's bytes from MinIO with
auth checks, builds typed sources, calls `apply_yoloe_to_asset`.

```python
class YoloeVisualSourceIn(BaseModel):
    asset_id: uuid.UUID
    groups: list[YoloeVisualGroupIn] = Field(..., min_length=1, max_length=64)


class YoloeVisualIn(BaseModel):
    sources: list[YoloeVisualSourceIn] = Field(..., min_length=1, max_length=32)
    conf: float = 0.25
    iou: float = 0.7
    overwrite: bool = False
    frame_id: uuid.UUID | None = None
    output_kind: str = Field(default="bbox", pattern="^(bbox|polygon)$")
```

Per-source auth: each source asset must belong to a task visible to
the user. Bytes via `_resolve_yoloe_asset_bytes(refer_asset, None)`
to handle videos (frame 0).

### `apps/api/src/carve_api/inference/batch.py`

Worker reconstruction (one source bytes fetch per source — NOT per
target):

```python
sources_in = list(p.get("sources") or [])
typed_sources: list[YoloeVisualSource] = []
boot = get_session_factory()()
try:
    for s in sources_in:
        asset_id = uuid.UUID(str(s["asset_id"]))
        asset = boot.get(Asset, asset_id)
        if asset is None: continue
        refer_bytes = _resolve_yoloe_asset_bytes_in_worker(asset, None)
        groups = [
            YoloeVisualGroup(
                class_id=uuid.UUID(str(g["class_id"])),
                bboxes=[list(b) for b in g.get("bboxes") or []],
            )
            for g in (s.get("groups") or [])
            if g.get("class_id") and g.get("bboxes")
        ]
        if not groups: continue
        typed_sources.append(YoloeVisualSource(asset_id, refer_bytes, groups))
finally:
    boot.close()
typed_params = YoloeVisualParams(sources=typed_sources, conf=..., iou=...)
```

With *N* sources × *T* targets, we already pay *N×T* model calls;
fetching from MinIO *N×T* times would add minutes. Single-fetch
guard is critical.

---

## 5. Frontend

### `apps/web/src/api/yoloe.ts`

```ts
export interface YoloeVisualGroupItem {
  class_id: string;
  bboxes: [number, number, number, number][];
}

export interface YoloeVisualSource {
  asset_id: string;
  groups: YoloeVisualGroupItem[];
}

export interface YoloeVisualRequest {
  sources: YoloeVisualSource[];
  conf?: number;
  iou?: number;
  overwrite?: boolean;
  frame_id?: string | null;
  output_kind?: YoloeOutputKind;
}
```

The legacy top-level `refer_b64` / `refer_asset_id` / `groups`
fields are removed from the typed wire (the api still accepts them
optionally, but the dialog ships only the new shape).

### `apps/web/src/components/annotation/YoloeDialog.tsx`

#### Layout

```
┌────────────────────────────────────────────────────────┐
│  YOLOE  Real-Time Seeing Anything                  [×] │
├────────────────────────────────────────────────────────┤
│  [Text]  [ Visual ]  [Prompt-Free]                     │
├────────────────────────────────────────────────────────┤
│  Pick references — N picks · M sources · K classes     │
│                                                        │
│  Source assets in this task (scrollable strip)         │
│  ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐                              │
│  │A•│ │B │ │C•│ │D │ │E•│  • = has picks              │
│  └──┘ └──┘ └──┘ └──┘ └──┘  selected highlighted        │
│                                                        │
│  References on asset A (12 annotations)                │
│  ☑  ●Worker  bbox 240×150  → [Worker ▾]               │
│  ☑  ●Worker  bbox 220×170  → [Worker ▾]               │
│  ☐   Vehicle bbox 410×310  not picked                 │
│                                                        │
│  Picks aggregated across all sources you've touched.   │
├────────────────────────────────────────────────────────┤
│  Scope: [ This image ]  [ All assets in task ]         │
│  Confidence  IoU  Save as  Replace existing            │
│                                                        │
│                         [Cancel]  [ Run on N assets ]  │
└────────────────────────────────────────────────────────┘
```

#### State

```ts
interface VisualPick {
  assetId: string;            // source asset id
  annotationId: string;       // server or temp id
  classId: string;            // assigned project class
  xyxy: [number, number, number, number];  // in source image coords
  className: string;
  color: string;
  sourceKind: "bbox" | "polygon";
}

const [picks, setPicks] = useState<Record<string, VisualPick>>({});
// key = `${assetId}:${annotationId}`
const [activeSourceAssetId, setActiveSourceAssetId] = useState<string | null>(assetId);
```

#### Data fetches (gated `enabled: open && mode === "visual"`)

- **Task assets** — `assetsApi.listForTask(taskId)` → thumbnail strip data.
- **Task annotations** — `annotationsApi.listForTask(taskId)` (no
  frame filter) returns all rows with `asset_id` per row. Group
  client-side by asset_id.
- **Currently-open asset** continues to read from
  `useAnnotations(s => s.byId)` so in-flight edits show up
  immediately.

#### Run-payload builder

```ts
function buildVisualSources(): YoloeVisualSource[] {
  const bySource = new Map<string, Map<string, [number,number,number,number][]>>();
  for (const p of Object.values(picks)) {
    if (!p.classId) continue;
    const groupMap = bySource.get(p.assetId) ?? new Map();
    const bboxes = groupMap.get(p.classId) ?? [];
    bboxes.push(p.xyxy);
    groupMap.set(p.classId, bboxes);
    bySource.set(p.assetId, groupMap);
  }
  return Array.from(bySource.entries()).map(([asset_id, groupMap]) => ({
    asset_id,
    groups: Array.from(groupMap.entries()).map(([class_id, bboxes]) => ({
      class_id,
      bboxes,
    })),
  }));
}
```

#### canRun (visual)

- ≥1 source.
- Every pick has a non-empty class assignment.
- Every produced source has ≥1 group with ≥1 bbox.

---

## 6. Cancel / background semantics

Existing v3.23.6 logic continues to work without change:

- **Outside-click / ESC / X with running batch** → auto-background.
- **Cancel button** → optimistic close; api flips Redis status.
- **Background button** → register with `useBackgroundJobs`.

The per-asset cancel check inside the batch worker fires between
*assets*, not between sources. Within one asset, all *N* source
passes complete first, then the cancel check decides. A cancel
during one asset's multi-source run delays the cancel by ≤ N ×
~70 ms (typically <1s). Acceptable.

---

## 7. Performance

| Scenario | Calls | Wall time (rough) |
|---|---|---|
| 1 source × 1 target | 1 | identical to v3.23.7 |
| 5 sources × 1 target | 5 | <1 s |
| 1 source × 100 targets | 100 | ~7 s |
| 5 sources × 100 targets | 500 | ~35 s |
| 5 sources × 1000 targets | 5000 | ~6 min |

Source bytes fetched once per source per batch, not per target.
NMS is per-target, runs in pure Python, ~1 ms for typical detection
counts.

---

## 8. Out of scope (this iteration)

- **Frame-level reference picking from videos.** The picker uses
  frame 0 of any selected video asset. A frame slider per source is
  separate.
- **Saved reference libraries.** Picks are dialog-local React
  state; reset on close.
- **Per-source max-detections / conf / iou.** All sources share the
  global conf/iou sliders.
- **Polygon-IoU NMS.** Uses enclosing-bbox IoU for polygons too.

---

## 9. Verification plan

1. `pytest apps/model/tests/yoloe/` — model tests pass.
2. `npx tsc --noEmit` clean.
3. Direct python check: NMS unit-test on synthetic detection lists
   to confirm dedupe at IoU > 0.6.
4. Browser smoke:
   - Open dialog on asset A; pick 2 refs as class X.
   - Click thumbnail of asset B; pick 1 as X, 1 as Y.
   - Run "this image" → both signatures applied to asset A.
   - Run "all assets in task" → batch progress fires, every asset
     gets detections.
5. Cancel mid-batch → optimistic close, server flips status, worker
   exits gracefully between assets.

---

## 10. Implementation order

1. ✅ Spec (this doc).
2. Backend service layer (`yoloe.py`): new dataclasses + NMS helper +
   multi-source `predict_for_asset`.
3. Backend API endpoint (`router.py`): new `YoloeVisualIn` body,
   per-source auth + bytes fetch, build typed `sources`.
4. Backend batch worker (`batch.py`): typed-sources reconstruction
   with one-fetch-per-source guard.
5. Frontend wire types (`yoloe.ts`).
6. Frontend dialog UI: thumbnail strip, per-asset picker, picks
   summary, run-payload builder.
7. Smoke test, commit, push.
