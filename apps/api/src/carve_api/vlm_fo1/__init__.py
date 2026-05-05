"""Per-user VLM-FO1 precision-filter preference endpoints.

Public surface (mounted at ``/me/vlm-fo1``):

  - ``GET /me/vlm-fo1`` — return ``{enabled: bool}`` for the calling user.
  - ``PUT /me/vlm-fo1`` — set ``{enabled: bool}`` for the calling user.

Default value (``users.vlm_fo1_enabled = false``) matches the spec's
feature-OFF posture. The editor calls GET on mount and PUT when the
user toggles the setting in the preferences panel.
"""

from carve_api.vlm_fo1.router import router

__all__ = ["router"]
