import uuid

from sqlalchemy.orm import Session

from carve_api.stats.sql import (
    ANNOTATION_DENSITY_SQL,
    BBOX_GEOMETRIES_SQL,
    CLASS_FREQUENCY_SQL,
    GEOMETRY_BY_KIND_SQL,
    PROJECT_BY_CLASS_SQL,
    PROJECT_TASK_PROGRESS_SQL,
    PROJECT_TOTALS_SQL,
    SIZE_DISTRIBUTION_BBOX_SQL,
    TASK_PROGRESS_SQL,
    TIME_ON_TASK_SQL,
)


# COCO size thresholds in pixels^2
_SMALL_MAX = 1024  # 32^2; area < 1024 is "small"
_MEDIUM_MAX = 9216  # 96^2; 1024 <= area < 9216 is "medium"; >= 9216 is "large"


def _bucket_area(area_px: float) -> str:
    if area_px < _SMALL_MAX:
        return "small"
    if area_px < _MEDIUM_MAX:
        return "medium"
    return "large"


def _polygon_area(points: list[list[float]]) -> float:
    """Shoelace area; returns 0.0 for degenerate polygons (< 3 points)."""
    if not points or len(points) < 3:
        return 0.0
    total = 0.0
    n = len(points)
    for i in range(n):
        x1, y1 = points[i][0], points[i][1]
        x2, y2 = points[(i + 1) % n][0], points[(i + 1) % n][1]
        total += x1 * y2 - x2 * y1
    return 0.5 * abs(total)


def _mask_foreground_pixels(counts: str) -> int:
    """Sum foreground runs in the comma-separated RLE counts string.

    Per Plan 04 codec (`apps/model/src/carve_model/sam/codec.py`), runs alternate
    starting with background (0). So odd-indexed runs are foreground (1).
    """
    if not counts:
        return 0
    runs = counts.split(",")
    fg = 0
    for i in range(1, len(runs), 2):
        try:
            fg += int(runs[i])
        except ValueError:
            continue
    return fg


# Aspect-ratio bucket boundaries (in dict insertion order for stable JSON keys).
def _aspect_bucket(ratio: float) -> str:
    if ratio < 0.33:
        return "<0.33"
    if ratio < 0.67:
        return "0.33-0.67"
    if ratio < 1.5:
        return "0.67-1.5"
    if ratio < 3.0:
        return "1.5-3"
    return ">=3"


class StatsService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def class_frequency(self, *, project_id: uuid.UUID, task_id: uuid.UUID) -> list[dict]:
        rows = self.session.execute(
            CLASS_FREQUENCY_SQL, {"project_id": project_id, "task_id": task_id}
        ).all()
        return [dict(r._mapping) for r in rows]

    def annotation_density(self, *, task_id: uuid.UUID) -> list[dict]:
        rows = self.session.execute(
            ANNOTATION_DENSITY_SQL, {"task_id": task_id}
        ).all()
        return [dict(r._mapping) for r in rows]

    def task_progress(self, *, task_id: uuid.UUID) -> dict:
        row = self.session.execute(TASK_PROGRESS_SQL, {"task_id": task_id}).one()
        m = row._mapping
        total = m["total_frames"] or 0
        labeled = m["labeled_frames"] or 0
        return {
            "total_frames": total,
            "labeled_frames": labeled,
            "progress_pct": (labeled / total) if total else 0.0,
        }

    def size_distribution(self, *, task_id: uuid.UUID) -> dict:
        """Combined small/medium/large counts across bbox, polygon, mask kinds."""
        buckets = {"small": 0, "medium": 0, "large": 0}

        # Bbox path: SQL aggregate.
        bbox_row = self.session.execute(
            SIZE_DISTRIBUTION_BBOX_SQL, {"task_id": task_id}
        ).one()
        m = bbox_row._mapping
        buckets["small"] += int(m["small"] or 0)
        buckets["medium"] += int(m["medium"] or 0)
        buckets["large"] += int(m["large"] or 0)

        # Polygon path: shoelace area in Python.
        poly_rows = self.session.execute(
            GEOMETRY_BY_KIND_SQL, {"task_id": task_id, "kind": "polygon"}
        ).all()
        for r in poly_rows:
            geom = r._mapping["geometry"] or {}
            points = geom.get("points") or []
            area = _polygon_area(points)
            if area <= 0:
                continue  # skip degenerate polygons
            buckets[_bucket_area(area)] += 1

        # Mask path: foreground pixel count from RLE counts.
        mask_rows = self.session.execute(
            GEOMETRY_BY_KIND_SQL, {"task_id": task_id, "kind": "mask"}
        ).all()
        for r in mask_rows:
            geom = r._mapping["geometry"] or {}
            counts = geom.get("counts") or ""
            fg = _mask_foreground_pixels(counts)
            if fg <= 0:
                continue
            buckets[_bucket_area(fg)] += 1

        return buckets

    def aspect_ratio_histogram(self, *, task_id: uuid.UUID) -> dict:
        """w/h histogram for bbox annotations only.

        Bbox keys are `<0.33`, `0.33-0.67`, `0.67-1.5`, `1.5-3`, `>=3` —
        insertion order preserved (Python 3.7+).
        """
        buckets: dict[str, int] = {
            "<0.33": 0,
            "0.33-0.67": 0,
            "0.67-1.5": 0,
            "1.5-3": 0,
            ">=3": 0,
        }
        rows = self.session.execute(BBOX_GEOMETRIES_SQL, {"task_id": task_id}).all()
        for r in rows:
            geom = r._mapping["geometry"] or {}
            try:
                w = float(geom.get("w", 0))
                h = float(geom.get("h", 0))
            except (TypeError, ValueError):
                continue
            if h <= 0 or w <= 0:
                continue  # skip degenerate bboxes
            ratio = w / h
            buckets[_aspect_bucket(ratio)] += 1
        return buckets

    def project_summary(self, *, project_id: uuid.UUID) -> dict:
        """Project-level analytics rollup: totals, top-5 classes, per-task progress.

        - `totals` counts tasks, assets, annotations scoped to this project.
        - `by_class` returns up to 5 classes ordered by annotation count DESC,
          falling back to class.idx ASC for stable ties.
        - `tasks` returns one row per task with a `progress_pct` in [0.0, 1.0].
        """
        totals_row = self.session.execute(
            PROJECT_TOTALS_SQL, {"project_id": project_id}
        ).one()
        tm = totals_row._mapping
        totals = {
            "tasks": int(tm["tasks"] or 0),
            "assets": int(tm["assets"] or 0),
            "annotations": int(tm["annotations"] or 0),
        }

        class_rows = self.session.execute(
            PROJECT_BY_CLASS_SQL, {"project_id": project_id}
        ).all()
        by_class = [
            {
                "class_id": str(r._mapping["class_id"]),
                "name": r._mapping["name"],
                "count": int(r._mapping["count"] or 0),
            }
            for r in class_rows
        ]

        task_rows = self.session.execute(
            PROJECT_TASK_PROGRESS_SQL, {"project_id": project_id}
        ).all()
        tasks = [
            {
                "task_id": str(r._mapping["task_id"]),
                "name": r._mapping["name"],
                "progress_pct": round(float(r._mapping["progress_pct"] or 0.0), 6),
            }
            for r in task_rows
        ]

        return {"totals": totals, "by_class": by_class, "tasks": tasks}

    def time_on_task(self, *, task_id: uuid.UUID) -> list[dict]:
        """Per-annotator active seconds with a 5-minute idle threshold.

        SUM may return NULL for users with a single annotation (no LAG
        predecessor); coerce to 0.0. `seconds` is `Decimal` from
        Postgres `EXTRACT(EPOCH ...)`, so cast to `float` for JSON
        serialization.
        """
        rows = self.session.execute(TIME_ON_TASK_SQL, {"task_id": task_id}).all()
        return [
            {
                "user_id": str(r._mapping["user_id"]),
                "email": r._mapping["email"],
                "seconds": float(r._mapping["seconds"] or 0.0),
            }
            for r in rows
        ]
