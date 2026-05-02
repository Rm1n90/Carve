# Armin Mehri — mehri.armin@gmail.com
"""Plan-13 Phase 7 Task 3 -- audit log package.

Exposes:
  * ``service.record(...)`` -- best-effort recorder (never raises into
    business logic).
  * ``actions.*``           -- canonical action string constants.
  * ``router.router``       -- FastAPI router mounted by ``main.py``.
"""

from carve_api.audit import actions, service  # noqa: F401
