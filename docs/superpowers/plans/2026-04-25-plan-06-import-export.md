# Plan 06 — Annotation Import + YOLO/COCO Export with Class Remap

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Import existing YOLO and COCO annotations into a task so users can review and correct them; export annotations to YOLO and COCO with optional class remap (merge / rename / skip). Both formats handle detection, segmentation, and classification.

**Architecture:**
- A small `apps/api/src/vaa_api/io/` package holds parsers (`yolo_in.py`, `coco_in.py`) and writers (`yolo_out.py`, `coco_out.py`).
- Imports: a streaming RQ job parses the uploaded archive, matches files by name to existing assets, and creates `Annotation` rows.
- Exports: an RQ job streams output into a ZIP file in MinIO at `exports/<task_id>/<export_id>.zip`; the user downloads via a presigned URL.
- Class remap is stored alongside the export config as JSONB.

---

## Series context
- ✅ Plans 01–05 shipped
- **Plan 06 — Import/Export** ← *this plan*
- Plan 07 — Analytics
- Plan 08 — Polish

---

## Task 1: `Export` model + migration 0006

**Files:** `apps/api/src/vaa_api/exports/{__init__,models}.py`; `apps/api/alembic/versions/0006_exports.py`; modify `alembic/env.py`.

**Step 1.1 — `models.py`:**

```python
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from vaa_api.db import Base


class Export(Base):
    __tablename__ = "exports"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    format: Mapped[str] = mapped_column(String(20), nullable=False)            # "yolo" | "coco"
    class_remap: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    minio_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
```

**Step 1.2 — Migration 0006** creates `exports` with index on `task_id`. Revision `0006`, down_revision `0005`.

**Step 1.3 — Tests** create rows with each `format` and verify default `status="pending"`.

**Step 1.4 — Commit:** `feat(api): Export row model + migration 0006`

---

## Task 2: YOLO writer

**Files:** `apps/api/src/vaa_api/io/{__init__,yolo_out}.py`; `apps/api/tests/io/test_yolo_out.py`.

**Behavior:**
- Detection (`bbox`): one `.txt` per image at `labels/<asset_basename>.txt`, lines `class_idx cx cy w h` (normalized 0–1).
- Segmentation (`polygon` or `mask`): same path; lines `class_idx x1 y1 x2 y2 ...` (normalized).
- Classification (`tag`): single class per image; one line `class_idx` in `<image>.txt`. If multiple tags exist, take the first by `created_at` and emit a warning.
- Writes `data.yaml` at archive root with `path:`, `train:`, `val:`, `test:`, `nc:`, `names:`.
- Splits: 80/10/10 default; configurable.
- Applies the class remap dict.

**Step 2.1 — Test fixture** has 1 image (640×480), one bbox `(50,50,100,80)` of class "car". Expect normalized line `0 0.156 0.187 0.156 0.166`. Round-trip with the importer (Task 4) preserves the geometry up to remap.

**Step 2.2 — `yolo_out.py` skeleton:**

```python
from collections.abc import Iterable

from vaa_api.annotations.models import Annotation, AnnotationKind
from vaa_api.projects.models import Class


def write_yolo_label(
    annotations: list[Annotation],
    classes_by_id: dict,                     # project_class_id -> Class
    remap: dict,                             # project_class_id (str) -> {"export_id": int, "name": str} | None
    image_w: int, image_h: int,
) -> tuple[list[str], list[str]]:
    """Returns (yolo_lines, warnings)."""
    lines: list[str] = []
    warnings: list[str] = []
    for ann in annotations:
        target = remap.get(str(ann.class_id))
        if target is None:
            continue                         # skipped by remap
        idx = target["export_id"]
        g = ann.geometry
        if ann.kind == AnnotationKind.bbox:
            cx = (g["x"] + g["w"] / 2) / image_w
            cy = (g["y"] + g["h"] / 2) / image_h
            w = g["w"] / image_w
            h = g["h"] / image_h
            lines.append(f"{idx} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
        elif ann.kind == AnnotationKind.polygon:
            pts = " ".join(f"{p[0]/image_w:.6f} {p[1]/image_h:.6f}" for p in g["points"])
            lines.append(f"{idx} {pts}")
        elif ann.kind == AnnotationKind.mask:
            warnings.append("yolo writer skipped mask (use polygon export); class_id={}".format(ann.class_id))
        elif ann.kind == AnnotationKind.tag:
            lines.append(f"{idx}")
    return lines, warnings


def write_data_yaml(remap_targets: list[tuple[int, str]], splits: dict[str, str]) -> str:
    names = ", ".join(f'"{name}"' for _, name in sorted(set(remap_targets)))
    return (
        f"path: .\n"
        f"train: {splits.get('train', 'images/train')}\n"
        f"val: {splits.get('val', 'images/val')}\n"
        f"test: {splits.get('test', 'images/test')}\n"
        f"nc: {len({i for i, _ in remap_targets})}\n"
        f"names: [{names}]\n"
    )
```

**Step 2.3 — Tests** unit-cover bbox (normalised math), polygon (normalised), tag (single int), and mask warning.

**Step 2.4 — Commit:** `feat(api): YOLO writer for detect/segment/classify with normalized coords`

---

## Task 3: COCO writer

**Files:** `apps/api/src/vaa_api/io/coco_out.py`; tests.

**Behavior:**
- Single `coco.json` plus optional `images/<asset_basename>` files (controlled by `include_images` flag).
- Detection: `bbox: [x, y, w, h]` (xywh, pixel coords); `area = w * h`; `category_id` after remap.
- Segmentation: `segmentation: [[x1, y1, x2, y2, ...]]` for polygons; for masks, encode COCO RLE into `segmentation: {"size": [h,w], "counts": "…"}`.
- Classification: emits `categories` for each class and per-image `image_classification` annotation with `bbox: [0,0,w,h]` and `area = w*h`.

**Step 3.1 — Skeleton:**

```python
from typing import Any

from vaa_api.annotations.models import Annotation, AnnotationKind


def build_coco(
    images: list[dict],                                # {id, file_name, width, height}
    annotations_by_image_id: dict[int, list[Annotation]],
    classes_by_id: dict,
    remap: dict,
) -> dict[str, Any]:
    categories: dict[int, dict] = {}
    coco_anns: list[dict] = []
    next_id = 1
    for img_id, anns in annotations_by_image_id.items():
        img = next(i for i in images if i["id"] == img_id)
        for ann in anns:
            target = remap.get(str(ann.class_id))
            if target is None:
                continue
            cat_id = int(target["export_id"])
            categories.setdefault(cat_id, {"id": cat_id, "name": target["name"]})
            entry: dict[str, Any] = {
                "id": next_id, "image_id": img_id, "category_id": cat_id,
                "iscrowd": 0,
            }
            next_id += 1
            g = ann.geometry
            if ann.kind == AnnotationKind.bbox:
                entry["bbox"] = [g["x"], g["y"], g["w"], g["h"]]
                entry["area"] = g["w"] * g["h"]
            elif ann.kind == AnnotationKind.polygon:
                flat = [c for p in g["points"] for c in p]
                entry["bbox"] = _bbox_of(g["points"])
                entry["area"] = entry["bbox"][2] * entry["bbox"][3]
                entry["segmentation"] = [flat]
            elif ann.kind == AnnotationKind.mask:
                entry["segmentation"] = {"size": g["size"], "counts": g["counts"]}
                entry["bbox"] = [0, 0, img["width"], img["height"]]
                entry["area"] = img["width"] * img["height"]
            elif ann.kind == AnnotationKind.tag:
                entry["bbox"] = [0, 0, img["width"], img["height"]]
                entry["area"] = img["width"] * img["height"]
            coco_anns.append(entry)
    return {
        "images": images,
        "annotations": coco_anns,
        "categories": list(categories.values()),
    }


def _bbox_of(points):
    xs = [p[0] for p in points]; ys = [p[1] for p in points]
    return [min(xs), min(ys), max(xs)-min(xs), max(ys)-min(ys)]
```

**Step 3.2 — Tests** unit-cover the four kinds; assert COCO category list shape.

**Step 3.3 — Commit:** `feat(api): COCO writer (bbox + polygon + RLE + classification)`

---

## Task 4: Importers — YOLO + COCO

**Files:** `apps/api/src/vaa_api/io/{yolo_in,coco_in}.py`; tests.

**`yolo_in.py`** parses `data.yaml` (the names list) and walks `labels/`. For each `.txt`:
- 5 numbers per line → bbox (un-normalize using the matched asset's `width`/`height`).
- ≥ 7 odd numbers per line → polygon.
- Single integer → tag (frame-level classification).

Returns `(filename_basename, list[AnnotationDraft], warnings: list[str])`. Class names from `data.yaml.names` resolve case-insensitively against the project class list; unknown names go to `warnings`.

**`coco_in.py`** parses `coco.json` and returns the same shape. Detect bbox / polygon / RLE per `segmentation` shape.

**Tests:** 
- One YOLO archive with 3 image labels (one per kind) round-trips through writer + importer (Tasks 2–4) preserving geometry within ±1 pixel.
- One COCO file with 3 annotations does the same.
- Unknown class name produces a warning, not a failure.

**Commit:** `feat(api): YOLO + COCO importers with class-name → class-id resolution`

---

## Task 5: Import endpoint + RQ job

**Files:** `apps/api/src/vaa_api/io/{import_router,import_job}.py`; modify `main.py`.

**Endpoint:** `POST /tasks/{tid}/imports?format=yolo|coco` accepts a multipart `.zip`. Save to MinIO at `imports/<task_id>/<import_id>.zip`, enqueue RQ job, return `{"import_id": "<uuid>"}`.

**RQ job** parses, matches files to existing `Asset` rows by `original_name` (basename if not unique). For each annotation row insert with `created_by = NULL` (system import). Track per-import progress in Redis hash `imp:job:<rq_id>` with fields `done`, `total`, `warnings` (JSON-serialized list).

**GET endpoint** `GET /tasks/{tid}/imports/{import_id}` returns `{status, done, total, warnings}`.

**Tests:** end-to-end with mocked MinIO and a small in-memory fixture archive; assert annotations appear, warnings recorded.

**Commit:** `feat(api): annotation import (YOLO/COCO) via RQ job`

---

## Task 6: Export endpoint + RQ job

**Files:** `apps/api/src/vaa_api/exports/{schemas,service,router,job}.py`; modify `main.py`.

**Endpoint:** `POST /tasks/{tid}/exports` body:

```json
{
  "format": "yolo" | "coco",
  "class_remap": {
    "<project_class_id>": { "export_id": 0, "name": "vehicle" },
    "<another_id>": null
  },
  "splits": { "train": 0.8, "val": 0.1, "test": 0.1 },
  "include_images": true
}
```

Returns `{"export_id": "<uuid>"}`. The RQ job builds the archive in a temp directory, uploads to `exports/<task_id>/<export_id>.zip`, sets `status="completed"` and `minio_key`. On error: `status="failed"`, `error` set.

**GET endpoint** `GET /tasks/{tid}/exports/{export_id}` returns `{status, download_url}` (presigned URL when completed).

**Tests:** end-to-end with 3 images + 6 annotations + a class remap; verify the produced ZIP contains the expected files.

**Commit:** `feat(api): export job (YOLO + COCO) with class remap and split control`

---

## Task 7: Web UI — Import dialog

**Files:** `apps/web/src/api/imports.ts`; `apps/web/src/pages/ImportDialog.tsx`; modify task page.

UI: dropzone for `.zip`, format selector (YOLO / COCO), import-now button. After upload, poll `GET /tasks/{tid}/imports/{import_id}` every 1 s; show progress + warnings list when done. Refresh `useQuery(["annotations", taskId])` upon completion.

Tests: mock the API; verify the dialog calls `imports.create` with the right format.

**Commit:** `feat(web): annotation import dialog with progress + warnings`

---

## Task 8: Web UI — Export dialog with class remap

**Files:** `apps/web/src/api/exports.ts`; `apps/web/src/pages/ExportDialog.tsx`; modify task page.

UI: format selector (YOLO / COCO), splits sliders (train/val/test sums to 1.0), class remap table — rows per project class with destination id, destination name, skip toggle. "Save as preset" button stores the remap on the project (extension to Plan 02 patch endpoint).

After clicking "Export", poll status; show a download button that opens the presigned URL when complete.

Tests: render with 5 mocked classes; verify the remap payload sent to the API.

**Commit:** `feat(web): export dialog with class-remap table + download link`

---

## Task 9: Tag

```bash
git tag -a v0.6.0-import-export -m "Plan 06 complete: YOLO + COCO import/export with class remap"
```

---

## Self-Review

| Spec § | Implemented |
|---|---|
| §11 Class remap at export | Tasks 6, 8 |
| §12 YOLO + COCO export | Tasks 2, 3, 6 |
| §2.2 Annotation import | Tasks 4, 5, 7 |

Out of scope (deferred): VOC, KITTI, MOT, Datumaro (v2).

**Type consistency:** Same `Annotation.geometry` JSONB shape from Plan 04 used by parsers and writers.
