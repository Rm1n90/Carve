"""Backward-compat shim for ``carve_model.gpu``.

The real device-detection logic now lives in ``carve_model.devices``
(v3.25) — that module probes CUDA + MPS + CPU, reports per-device
memory, and resolves a user preference into a validated device id.

We re-export the legacy three names so older import sites keep
working while the codebase migrates. New code should import from
``carve_model.devices`` directly to access ``probe_devices``,
``resolve_device``, ``DeviceInfo``, etc.
"""

from carve_model.devices import (
    get_device,  # noqa: F401 — re-exported for backward compat
    has_cuda,  # noqa: F401
    vram_free_mb,  # noqa: F401
)

