"""Per-model device preferences (v3.25.1 — with disk persistence).

A thread-safe store for the user's chosen device per model kind
("sam", "yolo", "yoloe"). Empty / ``None`` means "auto" — the
resolver picks the best device available at request time.

Persistence:
  * On any ``set_pref`` we atomically write a JSON snapshot to the
    file at ``CARVE_DEVICE_PREFS_PATH`` (default
    ``/app/state/device_prefs.json``). The path's parent directory is
    created on demand.
  * On first ``get_pref`` / ``all_prefs`` / ``set_pref`` we lazily
    read the file back so preferences survive container restarts.
  * I/O failures are best-effort: a write that can't complete (e.g.
    read-only mount) logs a warning and the in-memory snapshot is
    still authoritative. The next predict call still works.

Tests can override the path via the env var (set before first
access) or call ``_reset_for_tests(path=...)``.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Literal

log = logging.getLogger(__name__)

ModelKind = Literal["sam", "yolo", "yoloe"]
_VALID: tuple[str, ...] = ("sam", "yolo", "yoloe")
_SCHEMA_VERSION = 1
_DEFAULT_PATH = "/app/state/device_prefs.json"


def _resolve_path() -> Path:
    return Path(os.environ.get("CARVE_DEVICE_PREFS_PATH", _DEFAULT_PATH))


_lock = threading.Lock()
# None means "auto" — resolver picks best device at request time.
_prefs: dict[str, str | None] = {k: None for k in _VALID}
_loaded = False


def _load_locked() -> None:
    """Read the JSON snapshot into ``_prefs``. Must be called with ``_lock``."""
    global _loaded
    _loaded = True
    path = _resolve_path()
    if not path.is_file():
        return
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw) if raw.strip() else {}
    except (OSError, ValueError) as exc:
        log.warning(
            "device_prefs: failed to read %s (%s); starting with auto for all",
            path,
            exc,
        )
        return
    if not isinstance(data, dict):
        log.warning("device_prefs: %s is not a JSON object; ignoring", path)
        return
    for k in _VALID:
        v = data.get(k)
        if v is None:
            _prefs[k] = None
        elif isinstance(v, str):
            s = v.strip().lower()
            _prefs[k] = None if s in ("", "auto") else s
        else:
            log.warning("device_prefs: %s.%s has wrong type %s; treating as auto", path, k, type(v).__name__)
            _prefs[k] = None
    log.info("device_prefs: loaded from %s -> %s", path, _prefs)


def _ensure_loaded() -> None:
    if _loaded:
        return
    with _lock:
        if not _loaded:
            _load_locked()


def _save_locked() -> None:
    """Atomic write of the in-memory snapshot. Must be called with ``_lock``.

    Best-effort: any IO error is logged at WARNING and swallowed —
    the in-memory state is still authoritative.
    """
    path = _resolve_path()
    payload = {"_v": _SCHEMA_VERSION, **_prefs}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Write to a sibling temp file then atomically rename so a crash
        # mid-write can't corrupt the existing file.
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=str(path.parent),
            prefix=".device_prefs.",
            suffix=".tmp",
            delete=False,
        ) as fh:
            json.dump(payload, fh)
            tmp_name = fh.name
        os.replace(tmp_name, str(path))
    except OSError as exc:
        log.warning("device_prefs: write to %s failed (%s); keeping in-memory only", path, exc)


def get_pref(kind: str) -> str | None:
    """Return the user's stored preference for ``kind`` (or None for auto)."""
    if kind not in _VALID:
        raise ValueError(f"unknown model kind: {kind!r}")
    _ensure_loaded()
    with _lock:
        return _prefs[kind]


def set_pref(kind: str, device: str | None) -> None:
    """Persist a preference. ``None`` or ``"auto"`` clears it (auto mode).

    The string is normalised to lower-case and stripped. We do NOT
    validate the device id here — that's the caller's responsibility
    (call ``devices.resolve_device`` after setting to surface a clear
    error before the predict path runs with a bad pref).
    """
    if kind not in _VALID:
        raise ValueError(f"unknown model kind: {kind!r}")
    _ensure_loaded()
    if device is None:
        normalised: str | None = None
    else:
        s = device.strip().lower()
        normalised = None if s in ("", "auto") else s
    with _lock:
        _prefs[kind] = normalised
        _save_locked()
    log.info("device_pref kind=%s -> %s", kind, normalised or "auto")


def all_prefs() -> dict[str, str | None]:
    """Snapshot of every preference. Read-only."""
    _ensure_loaded()
    with _lock:
        return dict(_prefs)


def reset_all() -> None:
    """Test helper — wipe every preference back to auto (and persist)."""
    global _loaded
    with _lock:
        for k in _VALID:
            _prefs[k] = None
        _loaded = True
        _save_locked()


def _reset_for_tests(path: str | None = None) -> None:
    """Hard-reset module state to defaults. Intended for pytest fixtures only.

    If ``path`` is given, points the persistence layer at that file via
    ``CARVE_DEVICE_PREFS_PATH`` env var. Doesn't write anything until
    the next ``set_pref``.
    """
    global _loaded
    if path is not None:
        os.environ["CARVE_DEVICE_PREFS_PATH"] = path
    with _lock:
        for k in _VALID:
            _prefs[k] = None
        _loaded = False
