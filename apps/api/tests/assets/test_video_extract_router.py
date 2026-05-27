# Armin Mehri — mehri.armin@gmail.com
"""Smoke tests for the three video-extract HTTP endpoints.

Service-layer logic is exhaustively covered by
``test_video_extract_service.py``. These tests confirm the routes are
mounted with the expected verbs and import cleanly. Auth + happy-path
flows are covered by manual E2E (Task 13) — running them here would
require a Postgres test DB which isn't provisioned in the host venv.
"""
from __future__ import annotations

from carve_api.main import create_app


def test_routes_are_mounted() -> None:
    """The three routes exist on the FastAPI app and use the expected verbs."""
    app = create_app()
    paths = {
        (r.path, ",".join(sorted(r.methods)))  # type: ignore[attr-defined]
        for r in app.routes
        if hasattr(r, "methods")
    }
    expected = {
        ("/projects/{project_id}/tasks/{task_id}/video-extract/batch", "POST"),
        (
            "/projects/{project_id}/tasks/{task_id}/video-extract/batch/{batch_id}",
            "GET",
        ),
        (
            "/projects/{project_id}/tasks/{task_id}/video-extract/batch/{batch_id}/cancel",
            "POST",
        ),
    }
    for path, method in expected:
        assert any(
            p == path and method in m for (p, m) in paths
        ), f"missing {method} {path}"
