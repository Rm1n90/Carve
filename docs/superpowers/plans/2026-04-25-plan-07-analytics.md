# Plan 07 — Analytics Dashboards

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Per-project and per-task analytics: class frequency, annotation density, task progress, object size distribution (COCO small/medium/large), spatial heatmap, aspect-ratio histogram, basic time-on-task per annotator.

**Architecture:**
- Stats are computed via SQL aggregates over `annotations`, `classes`, `frames`, `assets`, `users` (Plans 01–04 tables — no new migrations needed).
- Endpoints under `/tasks/{tid}/stats/*` and `/projects/{pid}/stats`.
- Frontend uses **Recharts** (lightweight) for charts; heatmap is a 2D grid.

**Tech additions:** `recharts@2.15.0`.

---

## Series context
- ✅ Plans 01–06 shipped
- **Plan 07 — Analytics** ← *this plan*
- Plan 08 — Polish

---

## Task 1: Class frequency + annotation density + task progress

**Files:** `apps/api/src/vaa_api/stats/{__init__,sql,service,router}.py`; tests `apps/api/tests/stats/test_stats.py`; modify `main.py`.

**Step 1.1 — `sql.py`:**

```python
from sqlalchemy import text


CLASS_FREQUENCY_SQL = text("""
SELECT c.id::text   AS class_id,
       c.idx        AS class_idx,
       c.name       AS class_name,
       c.color      AS class_color,
       COUNT(a.id)  AS count
FROM classes c
LEFT JOIN annotations a
       ON a.class_id = c.id
      AND a.task_id = :task_id
WHERE c.project_id = :project_id
GROUP BY c.id, c.idx, c.name, c.color
ORDER BY c.idx
""")


ANNOTATION_DENSITY_SQL = text("""
SELECT a.frame_id::text AS frame_id, COUNT(*) AS count
FROM annotations a
WHERE a.task_id = :task_id
GROUP BY a.frame_id
""")


TASK_PROGRESS_SQL = text("""
SELECT
    (SELECT COUNT(*) FROM frames f
       JOIN assets s ON s.id = f.asset_id
       WHERE s.task_id = :task_id) AS total_frames,
    (SELECT COUNT(DISTINCT a.frame_id) FROM annotations a
       WHERE a.task_id = :task_id AND a.frame_id IS NOT NULL) AS labeled_frames
""")
```

**Step 1.2 — `service.py`:**

```python
import uuid
from sqlalchemy.orm import Session

from vaa_api.stats.sql import (
    ANNOTATION_DENSITY_SQL, CLASS_FREQUENCY_SQL, TASK_PROGRESS_SQL,
)


class StatsService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def class_frequency(self, *, project_id: uuid.UUID, task_id: uuid.UUID) -> list[dict]:
        rows = self.session.execute(CLASS_FREQUENCY_SQL, {"project_id": project_id, "task_id": task_id}).all()
        return [dict(r._mapping) for r in rows]

    def annotation_density(self, *, task_id: uuid.UUID) -> list[dict]:
        rows = self.session.execute(ANNOTATION_DENSITY_SQL, {"task_id": task_id}).all()
        return [dict(r._mapping) for r in rows]

    def task_progress(self, *, task_id: uuid.UUID) -> dict:
        row = self.session.execute(TASK_PROGRESS_SQL, {"task_id": task_id}).one()
        m = row._mapping
        total = m["total_frames"] or 0
        labeled = m["labeled_frames"] or 0
        return {"total_frames": total, "labeled_frames": labeled, "progress_pct": (labeled / total) if total else 0.0}
```

**Step 1.3 — `router.py`** mounts `/tasks/{task_id}/stats/{class-frequency,density,progress}` using the existing `_require_visible_task` helper.

**Step 1.4 — Tests** seed a project with 2 classes and 5 annotations across 3 frames; assert correct counts and progress percentage.

**Step 1.5 — Commit:** `feat(api): class frequency + density + task progress endpoints`

---

## Task 2: Object size distribution + aspect-ratio histogram

**Files:** modify `stats/{sql,service,router}.py`; tests.

**COCO size buckets:**
- small: area < 32² = 1024 px²
- medium: 1024 ≤ area < 96² = 9216 px²
- large: area ≥ 9216 px²

**Step 2.1 — Bbox case via SQL:**

```python
SIZE_DISTRIBUTION_BBOX_SQL = text("""
SELECT
    SUM(CASE WHEN area_px < 1024 THEN 1 ELSE 0 END) AS small,
    SUM(CASE WHEN area_px BETWEEN 1024 AND 9215 THEN 1 ELSE 0 END) AS medium,
    SUM(CASE WHEN area_px >= 9216 THEN 1 ELSE 0 END) AS large
FROM (
    SELECT (a.geometry->>'w')::float * (a.geometry->>'h')::float AS area_px
    FROM annotations a
    WHERE a.task_id = :task_id AND a.kind = 'bbox'
) t
""")
```

For polygon and mask annotations compute area in Python (shoelace for polygons; `cocomask.area` for RLE masks). Combine into `{small, medium, large}` totals across all kinds.

**Step 2.2 — Aspect ratio histogram (bbox only):**

For each `bbox`, compute `w/h`; bucket into `<0.33, 0.33-0.67, 0.67-1.5, 1.5-3, ≥3`. Pure Python over query results.

**Step 2.3 — Tests** seed 6 boxes spanning the size and aspect-ratio buckets; assert correct counts.

**Step 2.4 — Commit:** `feat(api): object size + aspect-ratio histogram stats`

---

## Task 3: Spatial heatmap

**Files:** `apps/api/src/vaa_api/stats/heatmap.py`; modify `stats/router.py`; tests.

**Step 3.1 — Service:**

```python
from sqlalchemy import text

HEATMAP_BBOX_SQL = text("""
SELECT
    a.geometry->>'x' AS x, a.geometry->>'y' AS y,
    a.geometry->>'w' AS w, a.geometry->>'h' AS h,
    s.width AS img_w, s.height AS img_h
FROM annotations a
JOIN frames f ON f.id = a.frame_id
JOIN assets s ON s.id = f.asset_id
WHERE a.task_id = :task_id AND a.kind = 'bbox' AND s.width IS NOT NULL
""")


def heatmap(session, task_id, bins: int = 32) -> list[int]:
    grid = [0] * (bins * bins)
    for r in session.execute(HEATMAP_BBOX_SQL, {"task_id": task_id}):
        x, y, w, h = float(r.x), float(r.y), float(r.w), float(r.h)
        cx = (x + w / 2) / r.img_w
        cy = (y + h / 2) / r.img_h
        bx = max(0, min(bins - 1, int(cx * bins)))
        by = max(0, min(bins - 1, int(cy * bins)))
        grid[by * bins + bx] += 1
    return grid
```

**Step 3.2 — Endpoint** `GET /tasks/{tid}/stats/heatmap?bins=32` returns `{"bins": 32, "grid": [int, ...]}` (length `bins²`).

**Step 3.3 — Tests** seed 5 boxes with known centers; assert the right cells are non-zero.

**Step 3.4 — Commit:** `feat(api): spatial heatmap aggregation per task`

---

## Task 4: Time-on-task per annotator

**Files:** modify `stats/{sql,service,router}.py`; tests.

**Heuristic:** consecutive annotation `created_at` events on the same task within 5 minutes (300s) of each other count as "active". Larger gaps reset the session.

**Step 4.1 — SQL:**

```python
TIME_ON_TASK_SQL = text("""
SELECT
    a.created_by AS user_id,
    SUM(CASE
        WHEN EXTRACT(EPOCH FROM (a.created_at - LAG(a.created_at) OVER w)) <= 300
            THEN EXTRACT(EPOCH FROM (a.created_at - LAG(a.created_at) OVER w))
        ELSE 0
    END) AS seconds
FROM annotations a
WHERE a.task_id = :task_id AND a.created_by IS NOT NULL
WINDOW w AS (PARTITION BY a.created_by ORDER BY a.created_at)
GROUP BY a.created_by
""")
```

**Step 4.2 — Endpoint:** `GET /tasks/{tid}/stats/time-on-task` joins `users.email`; returns `[{user_id, email, seconds}]`.

**Step 4.3 — Tests** seed annotations 30s, 60s, 7min apart from one user; expect `seconds = 90` (the 7-minute gap is excluded).

**Step 4.4 — Commit:** `feat(api): time-on-task per annotator with 5-minute idle threshold`

---

## Task 5: Web UI — Stats panel on the task page

**Files:** `apps/web/src/api/stats.ts`; `apps/web/src/pages/StatsPanel.tsx`; modify task page; `apps/web/package.json` (add `recharts@2.15.0`).

**Layout:** four cards in a 2×2 grid:
1. **Class frequency** — horizontal bar chart with the class color swatch, count, and percentage.
2. **Task progress** — circular progress + "labeled / total frames".
3. **Size distribution** — donut (small / medium / large).
4. **Spatial heatmap** — 32×32 div grid, rgba red intensity proportional to bucket count, tooltip shows count.

Below: aspect-ratio histogram (5 bars) and time-on-task list (one row per user).

Tests: render with mocked API responses; assert the key labels appear ("total frames: 12" / "Class A: 8 (40%)").

**Commit:** `feat(web): stats panel with class frequency, progress, size distribution, heatmap`

---

## Task 6: Project-level stats summary

**Files:** modify `stats/{router,service}.py`; modify `apps/web/src/pages/ProjectDetailPage.tsx`.

**Endpoint:** `GET /projects/{pid}/stats` returns:

```json
{
  "totals": { "annotations": 0, "assets": 0, "tasks": 0 },
  "by_class": [{ "class_id": "...", "name": "car", "count": 12 }],
  "tasks": [{ "task_id": "...", "name": "T1", "progress_pct": 0.42 }]
}
```

**UI:** small stats strip on the project detail page — total annotations, total assets, top 5 classes, per-task progress mini-bar.

**Commit:** `feat(api,web): project-level analytics summary`

---

## Task 7: Tag

```bash
git tag -a v0.7.0-analytics -m "Plan 07 complete: analytics dashboards"
```

---

## Self-Review

| Spec § | Implemented |
|---|---|
| §13 Class frequency | Task 1 |
| §13 Annotation density | Task 1 |
| §13 Task progress | Task 1 |
| §13 Object size distribution | Task 2 |
| §13 Spatial heatmap | Task 3 |
| §13 Aspect ratio histogram | Task 2 |
| §13 Time-on-task | Task 4 |

Out of scope (deferred): inter-annotator agreement, consensus, honeypots → v2.
