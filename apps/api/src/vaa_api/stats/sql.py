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


GEOMETRY_BY_KIND_SQL = text("""
SELECT a.geometry AS geometry
FROM annotations a
WHERE a.task_id = :task_id AND a.kind = :kind
""")


BBOX_GEOMETRIES_SQL = text("""
SELECT a.geometry AS geometry
FROM annotations a
WHERE a.task_id = :task_id AND a.kind = 'bbox'
""")


# Project-level totals: tasks/assets/annotations counts for a single project.
PROJECT_TOTALS_SQL = text("""
SELECT
  (SELECT COUNT(*) FROM tasks t WHERE t.project_id = :project_id) AS tasks,
  (SELECT COUNT(*) FROM assets s
     JOIN tasks t ON t.id = s.task_id
     WHERE t.project_id = :project_id) AS assets,
  (SELECT COUNT(*) FROM annotations a
     JOIN tasks t ON t.id = a.task_id
     WHERE t.project_id = :project_id) AS annotations
""")


# Top-5 classes by annotation count for a project.
# LEFT JOIN keeps zero-count classes eligible when the project has < 5 annotated classes.
PROJECT_BY_CLASS_SQL = text("""
SELECT c.id::text AS class_id, c.name AS name, COUNT(a.id) AS count
FROM classes c
LEFT JOIN annotations a ON a.class_id = c.id
WHERE c.project_id = :project_id
GROUP BY c.id, c.name, c.idx
ORDER BY count DESC, c.idx ASC
LIMIT 5
""")


# Per-task progress: labeled_frames / total_frames, NULL-safe via NULLIF + COALESCE.
PROJECT_TASK_PROGRESS_SQL = text("""
SELECT
  t.id::text AS task_id,
  t.name     AS name,
  COALESCE(
    (SELECT COUNT(DISTINCT a.frame_id) FROM annotations a
       WHERE a.task_id = t.id AND a.frame_id IS NOT NULL)::float
    / NULLIF(
      (SELECT COUNT(*) FROM frames f
         JOIN assets s ON s.id = f.asset_id
         WHERE s.task_id = t.id), 0)::float
  , 0.0) AS progress_pct
FROM tasks t
WHERE t.project_id = :project_id
ORDER BY t.created_at ASC
""")


# Time-on-task: SUM(per-user gaps <= 300s) using LAG() window function.
# Annotations with NULL created_by are excluded (anonymous edits don't count).
# A user's first annotation has no LAG predecessor -> CASE branch is NULL,
# which SUM ignores; if a user has only one annotation, SUM is NULL and the
# service layer coerces it to 0.0.
TIME_ON_TASK_SQL = text("""
SELECT user_id, email, SUM(gap_seconds) AS seconds
FROM (
    SELECT
        a.created_by AS user_id,
        u.email      AS email,
        CASE
            WHEN EXTRACT(EPOCH FROM (a.created_at - LAG(a.created_at) OVER w)) <= 300
                THEN EXTRACT(EPOCH FROM (a.created_at - LAG(a.created_at) OVER w))
            ELSE 0
        END AS gap_seconds
    FROM annotations a
    JOIN users u ON u.id = a.created_by
    WHERE a.task_id = :task_id AND a.created_by IS NOT NULL
    WINDOW w AS (PARTITION BY a.created_by ORDER BY a.created_at)
) gaps
GROUP BY user_id, email
""")
