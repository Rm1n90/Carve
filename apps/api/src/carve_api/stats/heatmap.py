# Armin Mehri — mehri.armin@gmail.com
"""Spatial heatmap aggregation: bucket bbox centers into a binned grid.

The grid is row-major: ``grid[by * bins + bx]`` where ``(bx, by)`` is the
cell index in ``[0, bins)`` for normalized center coordinates ``(cx, cy)``.

Only annotations of kind ``bbox`` joined to assets with non-null dimensions
contribute. Polygons, masks, and tags are intentionally excluded; assets
missing ``width``/``height`` cannot be normalized and are filtered out.
"""
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
    """Return a length ``bins**2`` row-major grid of bbox-center counts."""
    grid = [0] * (bins * bins)
    for r in session.execute(HEATMAP_BBOX_SQL, {"task_id": task_id}):
        x, y, w, h = float(r.x), float(r.y), float(r.w), float(r.h)
        cx = (x + w / 2) / r.img_w
        cy = (y + h / 2) / r.img_h
        bx = max(0, min(bins - 1, int(cx * bins)))
        by = max(0, min(bins - 1, int(cy * bins)))
        grid[by * bins + bx] += 1
    return grid
