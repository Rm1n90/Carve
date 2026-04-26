# Plan 04 — Manual Annotation Canvas

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Annotate images and (video) frames with bounding boxes, polygons, masks, and frame-level tags. Save annotations to the API. Render the canvas with Pixi.js (WebGL) for 60 fps with thousands of shapes.

**Architecture:**
- API: `Annotation` row stores `kind` (bbox|polygon|mask|tag), `geometry` JSONB, `class_id`, `frame_id`, `track_id` (nullable; full track support is Plan 05).
- API: bulk endpoint `POST /tasks/{id}/annotations:batch` to save many shapes at once.
- Web: a single `AnnotationCanvas` Pixi.js application; state lives in Zustand (`useAnnotations`).
- Web: `Toolbar` (left), `ObjectsPanel`/`ClassesPanel` (right), `Timeline` (bottom for video).

**Tech additions:** `pixi.js@8.6.5`, `react-hotkeys-hook@4.6.1`. No new Python deps.

---

## Series context
- ✅ Plans 01–03 shipped
- **Plan 04 — Manual annotation canvas** ← *this plan*
- Plan 05 — YOLO model service
- Plan 06 — Annotation import/export
- Plan 07 — Analytics
- Plan 08 — Polish

---

## Task 1: Annotation domain model + migration 0004

**Files:** `apps/api/src/carve_api/annotations/{__init__,models}.py`; `apps/api/alembic/versions/0004_annotations.py`; modify `alembic/env.py`; tests `apps/api/tests/annotations/{__init__,test_models}.py`.

**Step 1.1 — Failing test** `tests/annotations/test_models.py`:

```python
import uuid

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.models import User, UserRole
from carve_api.projects.models import Class, Project, Task, TaskKind


def _setup(db):
    u = User(email="x@y.com", password_hash="x", role=UserRole.admin)
    db.add(u); db.flush()
    p = Project(name="P", owner_id=u.id); db.add(p); db.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image); db.add(t); db.flush()
    a = Asset(task_id=t.id, kind=AssetKind.image, xxh3_128="aa", mime="image/png",
              size_bytes=10, width=100, height=100, frames=1, original_name="a.png")
    db.add(a); db.flush()
    f = Frame(asset_id=a.id, idx=0, pts_ms=0); db.add(f); db.flush()
    c = Class(project_id=p.id, idx=0, name="car", color="#ff0000"); db.add(c); db.flush()
    return t, f, c, u


def test_create_bbox_annotation(db_session) -> None:
    t, f, c, u = _setup(db_session)
    ann = Annotation(
        task_id=t.id, frame_id=f.id, class_id=c.id,
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 10.0, "y": 12.0, "w": 30.0, "h": 40.0},
        created_by=u.id,
    )
    db_session.add(ann); db_session.flush()
    assert ann.id is not None
    assert ann.created_at is not None


def test_kinds_enum() -> None:
    assert {k.value for k in AnnotationKind} == {"bbox", "polygon", "mask", "tag"}
```

**Step 1.2 — `models.py`:**

```python
import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from carve_api.db import Base


class AnnotationKind(str, enum.Enum):
    bbox = "bbox"
    polygon = "polygon"
    mask = "mask"
    tag = "tag"


class Annotation(Base):
    __tablename__ = "annotations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    frame_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("frames.id", ondelete="CASCADE"), nullable=True, index=True
    )
    class_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("classes.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    kind: Mapped[AnnotationKind] = mapped_column(Enum(AnnotationKind, name="annotation_kind"), nullable=False)
    geometry: Mapped[dict] = mapped_column(JSONB, nullable=False)
    track_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
```

**Step 1.3 — Migration 0004** creates `annotation_kind` ENUM and the `annotations` table with all FKs, indexes (`task_id`, `frame_id`, `class_id`, `track_id`), and `created_at`/`updated_at` timestamps. Revision `0004`, down_revision `0003`. Pattern matches 0001/0002/0003.

**Step 1.4 — Update** `alembic/env.py` to import `carve_api.annotations.models`.

**Step 1.5 — Run** `pytest tests/annotations/test_models.py -v` then full suite. Commit: `feat(api): Annotation model + migration 0004`

---

## Task 2: Annotation service + REST + batch endpoint

**Files:** `apps/api/src/carve_api/annotations/{schemas,service,router}.py`; tests `tests/annotations/{test_service,test_router}.py`; modify `main.py`.

**Step 2.1 — `schemas.py`:**

```python
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from carve_api.annotations.models import AnnotationKind


class AnnotationIn(BaseModel):
    frame_id: str | None = None
    class_id: str
    kind: AnnotationKind
    geometry: dict[str, Any]
    track_id: str | None = None


class AnnotationPatch(BaseModel):
    geometry: dict[str, Any] | None = None
    class_id: str | None = None
    track_id: str | None = None


class AnnotationOut(BaseModel):
    id: str
    task_id: str
    frame_id: str | None
    class_id: str
    kind: AnnotationKind
    geometry: dict
    track_id: str | None
    created_by: str | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_orm_annotation(cls, a):
        return cls(
            id=str(a.id), task_id=str(a.task_id),
            frame_id=str(a.frame_id) if a.frame_id else None,
            class_id=str(a.class_id), kind=a.kind, geometry=a.geometry,
            track_id=str(a.track_id) if a.track_id else None,
            created_by=str(a.created_by) if a.created_by else None,
            created_at=a.created_at, updated_at=a.updated_at,
        )


class BatchUpdate(BaseModel):
    id: str
    geometry: dict[str, Any] | None = None
    class_id: str | None = None
    track_id: str | None = None


class BatchIn(BaseModel):
    create: list[AnnotationIn] = Field(default_factory=list)
    update: list[BatchUpdate] = Field(default_factory=list)
    delete: list[str] = Field(default_factory=list)


class BatchOut(BaseModel):
    created: list[AnnotationOut]
    updated: list[AnnotationOut]
    deleted: list[str]
```

**Step 2.2 — `service.py`:**

```python
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.errors import AppError
from carve_api.projects.models import Class, Task


class AnnotationInvalid(AppError):
    http_status = 422; code = "annotation_invalid"


class AnnotationNotFound(AppError):
    http_status = 404; code = "annotation_not_found"


def _validate_geometry(kind: AnnotationKind, g: dict) -> None:
    if kind == AnnotationKind.bbox:
        keys = {"x", "y", "w", "h"}
        if not keys.issubset(g) or g["w"] <= 0 or g["h"] <= 0:
            raise AnnotationInvalid("bbox geometry must include x,y,w>0,h>0")
    elif kind == AnnotationKind.polygon:
        pts = g.get("points")
        if not isinstance(pts, list) or len(pts) < 3 or any(len(p) != 2 for p in pts):
            raise AnnotationInvalid("polygon geometry needs ≥3 [x,y] points")
    elif kind == AnnotationKind.mask:
        if "size" not in g or "counts" not in g:
            raise AnnotationInvalid("mask geometry needs size and counts (RLE)")
    elif kind == AnnotationKind.tag:
        if g not in ({}, {"kind": "tag"}):
            raise AnnotationInvalid("tag geometry must be empty")


class AnnotationService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def create(self, *, task: Task, actor_id, frame_id, class_id, kind, geometry, track_id) -> Annotation:
        cls = self.session.get(Class, class_id)
        if cls is None or cls.project_id != task.project_id:
            raise AnnotationInvalid("class not in this project")
        _validate_geometry(kind, geometry)
        a = Annotation(
            task_id=task.id, frame_id=frame_id, class_id=class_id,
            kind=kind, geometry=geometry, track_id=track_id, created_by=actor_id,
        )
        self.session.add(a)
        self.session.flush()
        return a

    def list_for_task(self, *, task: Task, frame_id=None) -> list[Annotation]:
        q = select(Annotation).where(Annotation.task_id == task.id)
        if frame_id is not None:
            q = q.where(Annotation.frame_id == frame_id)
        return list(self.session.execute(q.order_by(Annotation.created_at)).scalars())

    def update(self, *, task: Task, annotation_id, **patch) -> Annotation:
        a = self.session.get(Annotation, annotation_id)
        if a is None or a.task_id != task.id:
            raise AnnotationNotFound("annotation not found")
        if patch.get("geometry") is not None:
            _validate_geometry(a.kind, patch["geometry"])
            a.geometry = patch["geometry"]
        for k in ("class_id", "track_id"):
            if patch.get(k) is not None:
                setattr(a, k, patch[k])
        self.session.flush()
        return a

    def delete(self, *, task: Task, annotation_id) -> None:
        a = self.session.get(Annotation, annotation_id)
        if a is None or a.task_id != task.id:
            raise AnnotationNotFound("annotation not found")
        self.session.delete(a)
        self.session.flush()
```

**Step 2.3 — `router.py`:** mount at `/tasks/{task_id}/annotations` with single-row `GET`, `POST`, `PATCH`, `DELETE`, plus `POST /tasks/{task_id}/annotations:batch` consuming `BatchIn` and returning `BatchOut`. Use the `_require_visible_task` helper from Plan 03 (refactor it into a shared `carve_api.deps` helper if needed).

```python
@router.post("/{task_id}/annotations:batch", response_model=BatchOut)
def batch(
    task_id: uuid.UUID, payload: BatchIn,
    user: User = Depends(get_current_user), db: Session = Depends(get_db),
) -> BatchOut:
    task = _require_visible_task(db, user, task_id)
    svc = AnnotationService(db)
    created = [svc.create(task=task, actor_id=user.id, **a.model_dump()) for a in payload.create]
    updated = [svc.update(task=task, annotation_id=u.id, **u.model_dump(exclude={"id"})) for u in payload.update]
    deleted: list[str] = []
    for ann_id in payload.delete:
        svc.delete(task=task, annotation_id=ann_id)
        deleted.append(ann_id)
    db.commit()
    return BatchOut(
        created=[AnnotationOut.from_orm_annotation(a) for a in created],
        updated=[AnnotationOut.from_orm_annotation(a) for a in updated],
        deleted=deleted,
    )
```

**Step 2.4 — Tests** (`test_service.py` and `test_router.py`):
- create one of each kind (4 happy paths)
- 422 on `bbox` with `w=0`
- 422 on `polygon` with 2 points
- 422 on cross-project class_id
- batch with 5 creates + 2 updates + 1 delete returns the right counts
- frame_id filter list returns only the matching ones

**Step 2.5 — Commit:** `feat(api): annotation CRUD + batch save endpoint`

---

## Task 3: Pixi.js application scaffold

**Files:** `apps/web/src/canvas/{App,Layers}.ts`; modify `package.json`.

**Step 3.1 — Install** `pixi.js@8.6.5` and `react-hotkeys-hook@4.6.1`. Run `npm run build` to confirm.

**Step 3.2 — `canvas/App.ts`:**

```ts
import { Application, Container } from "pixi.js";

export interface CanvasOptions {
  width: number;
  height: number;
  backgroundAlpha: number;
}

export class CanvasApp {
  app: Application;
  imageLayer: Container;
  shapeLayer: Container;
  overlayLayer: Container;

  constructor(opts: CanvasOptions) {
    this.app = new Application();
    this.imageLayer = new Container();
    this.shapeLayer = new Container();
    this.overlayLayer = new Container();
  }

  async init(opts: CanvasOptions): Promise<void> {
    await this.app.init({
      width: opts.width,
      height: opts.height,
      backgroundAlpha: opts.backgroundAlpha,
      antialias: true,
    });
    this.app.stage.addChild(this.imageLayer, this.shapeLayer, this.overlayLayer);
  }

  attach(host: HTMLDivElement): void {
    host.appendChild(this.app.canvas);
  }

  destroy(): void {
    this.app.destroy(true, { children: true });
  }
}
```

**Step 3.3 — Test scaffold:** mock Pixi `Application` and assert layer creation order.

**Step 3.4 — Commit:** `feat(web): Pixi.js canvas application scaffold`

---

## Task 4: Annotation store (Zustand) + typed API client

**Files:** `apps/web/src/state/annotations.ts`; `apps/web/src/api/annotations.ts`; tests `tests/annotation-store.test.ts`.

**Step 4.1 — `state/annotations.ts`:**

```ts
import { create } from "zustand";

export type AnnotationKind = "bbox" | "polygon" | "mask" | "tag";
export interface Bbox { kind: "bbox"; x: number; y: number; w: number; h: number; }
export interface Polygon { kind: "polygon"; points: [number, number][]; }
export interface Mask { kind: "mask"; size: [number, number]; counts: string; }
export interface Tag { kind: "tag"; }
export type Geometry = Bbox | Polygon | Mask | Tag;

export interface AnnotationDraft {
  tempId: string;
  classId: string;
  kind: AnnotationKind;
  geometry: Geometry;
  frameId: string | null;
  serverId: string | null;
  dirty: boolean;
}

interface State {
  byId: Record<string, AnnotationDraft>;
  selectedId: string | null;
  pendingDeletes: string[];                 // serverIds removed in-session
  add: (a: AnnotationDraft) => void;
  update: (id: string, patch: Partial<AnnotationDraft>) => void;
  remove: (id: string) => void;
  select: (id: string | null) => void;
  reset: (initial: AnnotationDraft[]) => void;
}

export const useAnnotations = create<State>((set, get) => ({
  byId: {},
  selectedId: null,
  pendingDeletes: [],
  add: (a) => set((s) => ({ byId: { ...s.byId, [a.tempId]: a }, selectedId: a.tempId })),
  update: (id, patch) => set((s) => {
    const cur = s.byId[id]; if (!cur) return s;
    return { byId: { ...s.byId, [id]: { ...cur, ...patch, dirty: true } } };
  }),
  remove: (id) => set((s) => {
    const cur = s.byId[id]; if (!cur) return s;
    const { [id]: _, ...rest } = s.byId;
    return {
      byId: rest,
      selectedId: s.selectedId === id ? null : s.selectedId,
      pendingDeletes: cur.serverId ? [...s.pendingDeletes, cur.serverId] : s.pendingDeletes,
    };
  }),
  select: (id) => set({ selectedId: id }),
  reset: (initial) => set({
    byId: Object.fromEntries(initial.map((a) => [a.tempId, a])),
    selectedId: null,
    pendingDeletes: [],
  }),
}));
```

**Step 4.2 — `api/annotations.ts`** wraps `GET /tasks/{tid}/annotations?frame_id=...` and `POST /tasks/{tid}/annotations:batch`. Provide `toDraft(server)` and `fromDraft(draft)` mappers.

**Step 4.3 — Tests:** add → update → pending derivation returns the right buckets; remove of a `serverId`-bearing draft pushes onto `pendingDeletes`.

**Step 4.4 — Commit:** `feat(web): annotation Zustand store + typed API client`

---

## Task 5: Bbox tool + renderer

**Files:** `apps/web/src/canvas/{ShapeRenderer,tools/BboxTool}.ts`; tests `tests/bbox-tool.test.ts`.

**Step 5.1 — Renderer for bbox:**

```ts
import { Graphics } from "pixi.js";
import type { Bbox } from "@/state/annotations";

export function renderBbox(g: Graphics, b: Bbox, color: number, selected: boolean) {
  g.clear();
  g.rect(b.x, b.y, b.w, b.h);
  g.stroke({ color, width: selected ? 3 : 2, alpha: 1 });
  g.fill({ color, alpha: selected ? 0.18 : 0.08 });
}
```

**Step 5.2 — `BboxTool.ts`:**
- `onPointerDown(p)` → store anchor at `p`, switch to `dragging` state.
- `onPointerMove(p)` → render preview rect in `overlayLayer`.
- `onPointerUp(p)` → if `|p - anchor| > 4`, commit a bbox into the store with `kind="bbox"` and the active class id; otherwise discard.

**Step 5.3 — Tests** drive the tool with synthetic events, asserting one annotation is added with the expected x/y/w/h (image-space coords).

**Step 5.4 — Commit:** `feat(web): bounding box tool with renderer + tests`

---

## Task 6: Polygon tool

**Files:** `apps/web/src/canvas/tools/PolygonTool.ts`.

- Click adds a vertex; `Enter` closes the polygon (≥ 3 points); `Esc` cancels and clears the in-progress vertex list.
- Double-click on the last point also closes.
- Renderer draws path + fill at low alpha + small vertex handles in the overlay layer.
- Test simulates `[[0,0],[10,0],[10,10]]` then `Enter`; expect one polygon committed.

**Commit:** `feat(web): polygon tool with vertex handles and Enter/Esc keys`

---

## Task 7: Mask brush + COCO RLE encode

**Files:** `apps/web/src/canvas/tools/MaskBrushTool.ts`; `apps/web/src/canvas/maskio.ts`.

- Brush paints to an offscreen canvas at the image resolution; eraser uses `globalCompositeOperation = "destination-out"`.
- On confirm (Enter), encode the raster mask to COCO RLE. Push as `{kind:"mask", size:[h,w], counts}` into the store.
- `maskio.ts` exports `encodeRLE(uint8: Uint8Array, h: number, w: number) -> string` and `decodeRLE(counts: string, h: number, w: number) -> Uint8Array`.
- Test the round-trip on a 4×4 known mask.

**Commit:** `feat(web): mask brush + eraser with COCO-RLE encoding`

---

## Task 8: Tag tool (frame-level classification)

**Files:** `apps/web/src/canvas/tools/TagTool.ts`.

- `T` adds a `{kind:"tag"}` annotation to the current frame with the active class.
- No on-canvas geometry; appears as a chip in the ObjectsPanel.

**Commit:** `feat(web): tag (frame-level classification) tool`

---

## Task 9: Toolbar + Objects/Classes panels + Command palette

**Files:** `apps/web/src/components/annotation/{Toolbar,ObjectsPanel,ClassesPanel,CommandPalette}.tsx`; `apps/web/src/state/tool.ts` (`useTool`).

**Toolbar** (left rail): cursor, bbox (B), polygon (P), brush (M), tag (T), zoom-fit (F), pan (space-hold). Active tool reflected by visual state. Driven by `useTool`.

**ObjectsPanel** (right tab): virtualised list of all annotations on the current frame, with class color swatch, kind icon, lock/hide controls.

**ClassesPanel** (right tab): list of project classes with hotkeys 1–9. `Cmd+L` opens fuzzy switcher (modal listing all classes, arrow + Enter to pick).

**CommandPalette**: `Cmd+K` global; actions include "switch class…", "jump to frame…", "save now", "undo", "redo".

Tests: keyboard `1` sets active class to index 0; `Cmd+L` opens the switcher.

**Commit:** `feat(web): toolbar + objects/classes panels + command palette`

---

## Task 10: AnnotationCanvas React component

**Files:** `apps/web/src/components/annotation/AnnotationCanvas.tsx`.

```tsx
import { useEffect, useRef } from "react";
import { Assets, Sprite } from "pixi.js";

import { CanvasApp } from "@/canvas/App";
import { useAnnotations } from "@/state/annotations";
import { useTool } from "@/state/tool";

export function AnnotationCanvas({
  width,
  height,
  imageUrl,
}: {
  width: number;
  height: number;
  imageUrl: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const app = new CanvasApp({ width, height, backgroundAlpha: 0 });
    let cancelled = false;
    (async () => {
      await app.init({ width, height, backgroundAlpha: 0 });
      if (cancelled) { app.destroy(); return; }
      app.attach(ref.current!);
      const tex = await Assets.load(imageUrl);
      const sprite = new Sprite(tex);
      app.imageLayer.addChild(sprite);
      // wire active tool's pointer handlers (see Task 5–8)
      // subscribe to useAnnotations and re-render shapeLayer on change
    })();
    return () => { cancelled = true; app.destroy(); };
  }, [width, height, imageUrl]);
  return <div ref={ref} style={{ width, height, background: "#0a0a14" }} />;
}
```

The canvas reads `useAnnotations`, draws shapes via the renderers from Tasks 5–7, and routes pointer events to the active tool from Task 9.

**Commit:** `feat(web): AnnotationCanvas mounting Pixi app + active tool wiring`

---

## Task 11: Annotation page + autosave

**Files:** `apps/web/src/pages/AnnotateAssetPage.tsx`; `apps/web/src/routes/projects.$projectId.tasks.$taskId.assets.$assetId.tsx`; modify `main.tsx`.

- Page layout: top bar (project · task · save indicator · undo/redo) | left toolbar | canvas | right panel.
- Loads the asset's `presigned_get` URL via `assetsApi.get(id)`.
- Loads initial annotations: `useQuery(["annotations", taskId, frameId])` → seed the Zustand store via `reset(initial)`.
- Autosave: 2-second debounce on dirty changes; calls `annotationsApi.batch({ create, update, delete })`. After server returns, replace `tempId → serverId`, mark non-dirty, clear `pendingDeletes`.
- Manual `Cmd+S` triggers immediate save.
- Tests: integration test with mocked batch API; assert tempIds get replaced by serverIds after save.

**Commit:** `feat(web): per-asset annotation page with autosave`

---

## Task 12: Frame timeline (video, basic)

**Files:** `apps/web/src/components/annotation/FrameTimeline.tsx`; modify `AnnotateAssetPage.tsx`. New endpoint `GET /assets/{id}/frames/{n}` (presigned URL of an extracted frame, falling back to RQ-extracted thumbnail or returning 404 if not yet extracted; full video frame extraction is a stretch goal here — Plan 05 will integrate the worker).

- Bottom strip ticks per keyframe with per-class color bands; click jumps to frame.
- `[`/`]` jumps to previous/next keyframe; `Space` toggles play/pause (1 fps stepper for v1).
- For image tasks the timeline is hidden.

**Commit:** `feat(web): basic frame timeline for video assets with keyboard nav`

---

## Task 13: Tag

```bash
git tag -a v0.4.0-canvas -m "Plan 04 complete: manual annotation canvas with bbox/polygon/mask/tag"
```

---

## Self-Review

| Spec § | Implemented |
|---|---|
| §8 Annotation UI (5 zones, tools, panels, hotkeys) | Tasks 9–11 |
| §8.4 Performance (Pixi.js WebGL) | Tasks 3, 5–7 |
| §11 Class hotkeys 1-9 + Cmd+L | Task 9 |
| §10 Video frame timeline (basic) | Task 12 |

Out of scope (deferred):
- SAM smart annotation → Plan 05
- SAM video tracker → Plan 05
- Track-mode interpolation between keyframes → Plan 05
- Active learning → v2

**Type consistency:** `AnnotationKind`, `Bbox`, `Polygon`, `Mask`, `Tag` mirror across server JSONB shapes and TS types.
