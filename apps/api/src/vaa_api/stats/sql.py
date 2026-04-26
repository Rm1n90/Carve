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
