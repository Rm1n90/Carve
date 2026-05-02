# Armin Mehri — mehri.armin@gmail.com
"""Plan-13 Phase 7 Task 6 -- dataset versioning package.

Exposes:
  * ``models.DatasetVersion`` -- ORM mapping for the table.
  * ``service.DatasetService`` -- register / list / get helpers.
  * ``differ.diff_versions``   -- compare two versions' YOLO bundles.
  * ``router.router``          -- FastAPI router (mounted by ``main.py``).
"""

from carve_api.datasets import models, service  # noqa: F401
