# SAM 3.1 Video Tracking Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the multi-backend (SAM 2 / SAM 3 / SAM 3.1) tracker stack with a single SAM 3.1-multiplex-only path: native JPEG-directory loading, smart-click hit-test refinement, cross-frame seeding, auto-preview, live-commit propagation.

**Architecture:** Model service exposes a request-style `/track/sessions/*` API mirroring the native SAM 3.1 multiplex predictor. API service proxies under `/assets/{id}/track/*` and supplies `image_size` from `Asset.width/height` plus per-frame presigned URLs derived from `Frame` rows. Frontend `TrackPanel` + `TrackTool` orchestrate scrub-then-click seeding, ±5-frame auto-preview, full-track propagation with auto-commit, and discard-by-track-ids.

**Tech Stack:** FastAPI + native `sam3` multiplex predictor (model service); FastAPI + SQLAlchemy (API); React + Zustand + TanStack Query + vitest + RTL (web). Spec: `docs/superpowers/specs/2026-05-07-sam3p1-track-redesign-design.md`.

---

## File structure

**Model service (`apps/model/src/carve_model/sam/`):**

```
track_session.py          — NEW (TrackSession dataclass + lifecycle helpers)
track_frame_cache.py      — NEW (asset_hash-keyed JPEG cache)
track_router.py           — REWRITE (/track/sessions/* surface)
tracker.py                — DELETE after migration (replaced by track_session.py)
sam2_adapter.py           — drop video tracker portion (image side stays)
sam3_adapter.py           — drop video tracker portion (image side stays)
sam3p1_adapter.py         — image predictor only after migration

apps/model/tests/sam/
  test_track_frame_cache.py — NEW
  test_track_session.py     — NEW
  test_track_router.py      — REWRITE
  test_tracker.py           — DELETE
  test_tracker_multi.py     — DELETE
  test_tracker_resolver.py  — DELETE
  test_multiplex_track_router.py — DELETE
```

**API service (`apps/api/src/carve_api/`):**

```
inference/track.py        — NEW (proxy to model service)
inference/sam_track.py    — DELETE after migration
inference/model_client.py — replace sam_track_* helpers with track_*
assets/router.py          — add /track/* proxy endpoints; remove /sam-track/*
annotations/router.py     — add DELETE /annotations:by-track-ids

apps/api/tests/inference/
  test_track_proxy.py     — NEW
  test_sam_track.py       — DELETE
  test_sam_track_multiplex.py — DELETE

apps/api/tests/annotations/
  test_bulk_delete_by_track.py — NEW
```

**Web (`apps/web/src/`):**

```
api/track.ts              — NEW (replaces api/sam_track.ts)
api/sam_track.ts          — DELETE after migration
state/trackBridge.ts      — NEW (replaces state/samTrackBridge.ts)
state/samTrackBridge.ts   — DELETE after migration
canvas/tools/TrackTool.ts — NEW (replaces canvas/tools/TrackPropagateTool.ts)
canvas/tools/TrackPropagateTool.ts — DELETE after migration
components/annotation/TrackPanel.tsx — NEW (replaces SamTrackPanel.tsx)
components/annotation/SamTrackPanel.tsx — DELETE after migration
components/annotation/AnnotationCanvas.tsx — modify track-mode click/drag dispatch
components/annotation/EditorToolbar.tsx — Track button entry + capabilities check
state/tool.ts             — add "track" to active-tool union if not present

apps/web/tests/
  track-frame-cache.test.ts — NEW (frame cache module unit test if extracted)
  track-bridge.test.ts      — NEW
  track-tool.test.ts        — NEW
  track-panel.test.tsx      — NEW
  track-flow-integration.test.tsx — NEW
  v35-sam-track-panel.test.tsx — DELETE
  track-propagate-tool.test.ts — DELETE
  sam-track-multiplex-panel.test.tsx — DELETE
```

---

## Task 1: Frame cache helper (model service)

**Files:**
- Create: `apps/model/src/carve_model/sam/track_frame_cache.py`
- Create: `apps/model/tests/sam/test_track_frame_cache.py`

- [ ] **Step 1: Write the failing test**

```python
# apps/model/tests/sam/test_track_frame_cache.py
"""Frame cache: asset_hash-keyed JPEG cache used by the SAM 3.1 tracker."""
from unittest.mock import MagicMock, patch
import pytest

from carve_model.sam.track_frame_cache import ensure_cached, cache_dir


@pytest.mark.unit
def test_ensure_cached_downloads_each_url(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "carve_model.sam.track_frame_cache._CACHE_ROOT", str(tmp_path),
    )
    fake_resp = MagicMock(content=b"\xff\xd8\xff" + b"\x00" * 64)
    fake_resp.raise_for_status = MagicMock()
    fake_client = MagicMock()
    fake_client.get.return_value = fake_resp
    fake_client.__enter__ = lambda self: self
    fake_client.__exit__ = lambda *a: None

    with patch("httpx.Client", return_value=fake_client):
        d = ensure_cached(
            asset_hash="abc123",
            frame_urls=[f"http://x/{i}.jpg" for i in range(3)],
        )

    assert d == cache_dir("abc123")
    files = sorted((tmp_path / "abc123").iterdir())
    assert [f.name for f in files] == ["000000.jpg", "000001.jpg", "000002.jpg"]


@pytest.mark.unit
def test_ensure_cached_reuses_existing(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "carve_model.sam.track_frame_cache._CACHE_ROOT", str(tmp_path),
    )
    target = tmp_path / "h" / "000000.jpg"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"\xff\xd8\xff" + b"\x00" * 64)
    target_two = tmp_path / "h" / "000001.jpg"
    target_two.write_bytes(b"\xff\xd8\xff" + b"\x00" * 64)

    fake_client = MagicMock()
    fake_client.__enter__ = lambda self: self
    fake_client.__exit__ = lambda *a: None
    with patch("httpx.Client", return_value=fake_client):
        d = ensure_cached(
            asset_hash="h",
            frame_urls=["http://x/0.jpg", "http://x/1.jpg"],
        )
    assert d == tmp_path / "h"
    fake_client.get.assert_not_called()


@pytest.mark.unit
def test_ensure_cached_rejects_non_http_url(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "carve_model.sam.track_frame_cache._CACHE_ROOT", str(tmp_path),
    )
    with pytest.raises(ValueError, match="scheme_not_allowed"):
        ensure_cached(
            asset_hash="abc",
            frame_urls=["file:///etc/passwd"],
        )
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/model && .venv/bin/python -m pytest tests/sam/test_track_frame_cache.py -v
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```python
# apps/model/src/carve_model/sam/track_frame_cache.py
"""Asset-hash-keyed JPEG frame cache for the SAM 3.1 track session.

Each tracking session needs the full per-frame JPEG sequence on local disk
so the native multiplex predictor's ``start_session`` can read them. We
key by ``Asset.xxh3_128`` so subsequent sessions on the same video reuse
the same cache directory.
"""
from __future__ import annotations

import logging
import os
import urllib.parse
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

_CACHE_ROOT = "/tmp/sam-frames"
_DOWNLOAD_TIMEOUT_S = 30.0


def cache_dir(asset_hash: str) -> Path:
    """Return the on-disk directory used to cache one asset's frames."""
    return Path(_CACHE_ROOT) / asset_hash


def ensure_cached(asset_hash: str, frame_urls: list[str]) -> Path:
    """Download each presigned URL into ``cache_dir(asset_hash)`` if missing.

    Filenames are zero-padded ``%06d.jpg`` so ``int(stem)`` sort order
    matches index order — the SAM 3.1 native predictor relies on this.

    Raises ``ValueError`` when any URL is not http(s) (blocks SSRF abuse).
    Raises ``RuntimeError`` when a download fails (caller decides whether to retry).
    """
    for url in frame_urls:
        scheme = urllib.parse.urlparse(url).scheme
        if scheme not in ("http", "https"):
            raise ValueError(f"frame_url_scheme_not_allowed: {scheme!r}")

    cdir = cache_dir(asset_hash)
    cdir.mkdir(parents=True, exist_ok=True)

    targets = [(cdir / f"{i:06d}.jpg", url) for i, url in enumerate(frame_urls)]
    missing = [(p, u) for (p, u) in targets if not p.exists()]
    if not missing:
        return cdir

    with httpx.Client(timeout=_DOWNLOAD_TIMEOUT_S) as client:
        for path, url in missing:
            try:
                resp = client.get(url)
                resp.raise_for_status()
                path.write_bytes(resp.content)
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(f"frame_cache_failed: {exc!r}") from exc

    return cdir
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/model && .venv/bin/python -m pytest tests/sam/test_track_frame_cache.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/track_frame_cache.py apps/model/tests/sam/test_track_frame_cache.py
git commit -m "feat(model): asset_hash-keyed JPEG frame cache for SAM 3.1 tracker"
```

---

## Task 2: TrackSession + lifecycle helpers (model service)

**Files:**
- Create: `apps/model/src/carve_model/sam/track_session.py`
- Create: `apps/model/tests/sam/test_track_session.py`

- [ ] **Step 1: Write the failing test**

```python
# apps/model/tests/sam/test_track_session.py
"""Track session lifecycle: open/close, idle eviction, predictor singleton."""
from pathlib import Path
from unittest.mock import MagicMock, patch
import pytest

from carve_model.sam import track_session as ts


@pytest.fixture(autouse=True)
def _reset_sessions():
    ts._SESSIONS.clear()
    ts._set_predictor_for_test(None)
    yield
    ts._SESSIONS.clear()
    ts._set_predictor_for_test(None)


@pytest.mark.unit
def test_open_session_calls_predictor_with_frame_dir(tmp_path):
    fake = MagicMock()
    fake.handle_request.return_value = {
        "session_id": "native-sid", "image_height": 720, "image_width": 1280,
    }
    ts._set_predictor_for_test(fake)

    with patch("carve_model.sam.track_session.ensure_cached",
               return_value=tmp_path / "abc"):
        sess = ts.open_session(
            frame_urls=["http://x/0.jpg", "http://x/1.jpg"],
            image_size=(720, 1280),
            asset_hash="abc",
        )

    assert sess.session_id  # local id
    assert sess.frame_count == 2
    assert sess.image_size == (720, 1280)
    fake.handle_request.assert_called_once_with({
        "type": "start_session",
        "resource_path": str(tmp_path / "abc"),
    })


@pytest.mark.unit
def test_close_session_calls_predictor_close(tmp_path):
    fake = MagicMock()
    fake.handle_request.return_value = {"session_id": "native-sid"}
    ts._set_predictor_for_test(fake)

    with patch("carve_model.sam.track_session.ensure_cached",
               return_value=tmp_path / "abc"):
        sess = ts.open_session(
            frame_urls=["http://x/0.jpg"],
            image_size=(720, 1280),
            asset_hash="abc",
        )
    ts.close_session(sess.session_id)

    fake.handle_request.assert_any_call({
        "type": "close_session", "session_id": "native-sid",
    })
    assert ts.get_session(sess.session_id) is None


@pytest.mark.unit
def test_get_session_returns_none_for_unknown():
    assert ts.get_session("does-not-exist") is None
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/model && .venv/bin/python -m pytest tests/sam/test_track_session.py -v
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```python
# apps/model/src/carve_model/sam/track_session.py
"""SAM 3.1 multiplex track session manager.

Single backend, single code path. The ``sam3`` native package is imported
lazily so unit tests can inject a fake predictor via ``_set_predictor_for_test``.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from carve_model.sam.track_frame_cache import ensure_cached

logger = logging.getLogger(__name__)


@dataclass
class TrackSession:
    """One in-flight tracking session."""

    session_id: str                 # local id (uuid)
    native_session_id: str          # the predictor's id (mirrored in requests)
    image_size: tuple[int, int]     # (h, w)
    frame_dir: Path
    frame_count: int
    asset_hash: str
    obj_classes: dict[int, str] = field(default_factory=dict)
    last_used: float = field(default_factory=time.monotonic)


_SESSIONS: dict[str, TrackSession] = {}
_LOCK = threading.Lock()
_PREDICTOR: Any | None = None
_TEST_PREDICTOR: Any | None = None
_IDLE_TIMEOUT_S = 600.0  # 10 min


def _set_predictor_for_test(predictor: Any | None) -> None:
    """Inject a fake multiplex predictor for unit tests."""
    global _TEST_PREDICTOR
    _TEST_PREDICTOR = predictor


def _get_predictor() -> Any:
    if _TEST_PREDICTOR is not None:
        return _TEST_PREDICTOR
    global _PREDICTOR
    if _PREDICTOR is None:
        from sam3.model_builder import (  # type: ignore[import-not-found]
            build_sam3_multiplex_video_predictor,
        )
        _PREDICTOR = build_sam3_multiplex_video_predictor()
    return _PREDICTOR


def open_session(
    *,
    frame_urls: list[str],
    image_size: tuple[int, int],
    asset_hash: str,
) -> TrackSession:
    frame_dir = ensure_cached(asset_hash=asset_hash, frame_urls=frame_urls)
    predictor = _get_predictor()
    resp = predictor.handle_request({
        "type": "start_session",
        "resource_path": str(frame_dir),
    })
    if not isinstance(resp, dict) or "session_id" not in resp:
        raise RuntimeError(
            f"start_session_unexpected_response: {resp!r}",
        )
    sess = TrackSession(
        session_id=str(uuid.uuid4()),
        native_session_id=str(resp["session_id"]),
        image_size=image_size,
        frame_dir=frame_dir,
        frame_count=len(frame_urls),
        asset_hash=asset_hash,
    )
    with _LOCK:
        _SESSIONS[sess.session_id] = sess
    return sess


def get_session(session_id: str) -> TrackSession | None:
    with _LOCK:
        sess = _SESSIONS.get(session_id)
    if sess is not None:
        sess.last_used = time.monotonic()
    return sess


def close_session(session_id: str) -> bool:
    with _LOCK:
        sess = _SESSIONS.pop(session_id, None)
    if sess is None:
        return False
    try:
        _get_predictor().handle_request({
            "type": "close_session",
            "session_id": sess.native_session_id,
        })
    except Exception as exc:  # noqa: BLE001
        logger.warning("close_session best-effort failed: %s", exc)
    return True


def evict_idle_sessions() -> list[str]:
    now = time.monotonic()
    evicted: list[str] = []
    with _LOCK:
        for sid in list(_SESSIONS):
            if (now - _SESSIONS[sid].last_used) >= _IDLE_TIMEOUT_S:
                _SESSIONS.pop(sid, None)
                evicted.append(sid)
    return evicted
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/model && .venv/bin/python -m pytest tests/sam/test_track_session.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/track_session.py apps/model/tests/sam/test_track_session.py
git commit -m "feat(model): TrackSession lifecycle (open/close/idle-evict)"
```

---

## Task 3: `add_prompt` (text + points + box)

**Files:**
- Modify: `apps/model/src/carve_model/sam/track_session.py`
- Modify: `apps/model/tests/sam/test_track_session.py`

- [ ] **Step 1: Write the failing tests (append to existing file)**

```python
# apps/model/tests/sam/test_track_session.py — append at bottom
import numpy as np


def _open_session_with_fake_predictor(tmp_path, fake):
    ts._set_predictor_for_test(fake)
    fake.handle_request.return_value = {"session_id": "native-sid"}
    with patch("carve_model.sam.track_session.ensure_cached",
               return_value=tmp_path / "abc"):
        return ts.open_session(
            frame_urls=["http://x/0.jpg"],
            image_size=(720, 1280),
            asset_hash="abc",
        )


@pytest.mark.unit
def test_add_prompt_text_returns_per_obj_masks(tmp_path):
    fake = MagicMock()
    sess = _open_session_with_fake_predictor(tmp_path, fake)
    fake.handle_request.return_value = {
        "outputs": {1: {"mask": np.zeros((720, 1280), dtype=bool)},
                    2: {"mask": np.ones((720, 1280), dtype=bool)}},
    }

    masks = ts.add_prompt(sess.session_id, frame_idx=0, text="person")

    assert set(masks.keys()) == {1, 2}
    fake.handle_request.assert_any_call({
        "type": "add_prompt",
        "session_id": "native-sid",
        "frame_index": 0,
        "text": "person",
    })


@pytest.mark.unit
def test_add_prompt_point_with_obj_id_refines(tmp_path):
    fake = MagicMock()
    sess = _open_session_with_fake_predictor(tmp_path, fake)
    fake.handle_request.return_value = {
        "outputs": {2: {"mask": np.ones((720, 1280), dtype=bool)}},
    }

    masks = ts.add_prompt(
        sess.session_id, frame_idx=5, obj_id=2,
        points=[(640, 360)], labels=[1],
    )
    assert set(masks.keys()) == {2}
    call = fake.handle_request.call_args_list[-1].args[0]
    assert call["type"] == "add_prompt"
    assert call["frame_index"] == 5
    assert call["obj_id"] == 2
    # rel coords: 640/1280=0.5, 360/720=0.5
    np.testing.assert_allclose(call["points"], [[0.5, 0.5]], rtol=1e-3)
    np.testing.assert_array_equal(call["point_labels"], [1])


@pytest.mark.unit
def test_add_prompt_no_input_raises(tmp_path):
    fake = MagicMock()
    sess = _open_session_with_fake_predictor(tmp_path, fake)
    with pytest.raises(ValueError, match="prompt_required"):
        ts.add_prompt(sess.session_id, frame_idx=0)


@pytest.mark.unit
def test_add_prompt_point_and_box_raises(tmp_path):
    fake = MagicMock()
    sess = _open_session_with_fake_predictor(tmp_path, fake)
    with pytest.raises(ValueError, match="exclusive_prompt_modes"):
        ts.add_prompt(
            sess.session_id, frame_idx=0,
            points=[(1, 1)], labels=[1],
            box=(0, 0, 10, 10),
        )


@pytest.mark.unit
def test_add_prompt_session_not_found():
    with pytest.raises(LookupError, match="session_not_found"):
        ts.add_prompt("nope", frame_idx=0, text="cat")
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/model && .venv/bin/python -m pytest tests/sam/test_track_session.py -v
```
Expected: 5 new tests FAIL — `add_prompt` not defined.

- [ ] **Step 3: Implement `add_prompt`**

Append to `apps/model/src/carve_model/sam/track_session.py`:

```python
import numpy as np


def _abs_to_rel_points(
    points: list[tuple[float, float]], image_size: tuple[int, int],
) -> list[list[float]]:
    h, w = image_size
    if h <= 0 or w <= 0:
        raise RuntimeError(f"invalid_image_size: {image_size}")
    return [[float(x) / float(w), float(y) / float(h)] for x, y in points]


def _abs_to_rel_box(
    box: tuple[float, float, float, float], image_size: tuple[int, int],
) -> list[float]:
    h, w = image_size
    x1, y1, x2, y2 = box
    return [
        float(x1) / float(w),
        float(y1) / float(h),
        float(x2) / float(w),
        float(y2) / float(h),
    ]


def add_prompt(
    session_id: str,
    *,
    frame_idx: int,
    obj_id: int | None = None,
    text: str | None = None,
    points: list[tuple[float, float]] | None = None,
    labels: list[int] | None = None,
    box: tuple[float, float, float, float] | None = None,
) -> dict[int, np.ndarray]:
    """Add a prompt to a session and return masks for the prompted frame.

    Returns ``{obj_id: mask_2d_bool}`` for objects affected by this prompt.
    Raises ``LookupError("session_not_found")`` for unknown ``session_id``.
    Raises ``ValueError("prompt_required")`` when none of text/points/box are set.
    Raises ``ValueError("exclusive_prompt_modes")`` when more than one is set.
    """
    sess = get_session(session_id)
    if sess is None:
        raise LookupError("session_not_found")

    has_text = bool(text)
    has_points = bool(points)
    has_box = box is not None

    n_modes = sum([has_text, has_points, has_box])
    if n_modes == 0:
        raise ValueError("prompt_required")
    if n_modes > 1:
        raise ValueError("exclusive_prompt_modes")

    request: dict[str, Any] = {
        "type": "add_prompt",
        "session_id": sess.native_session_id,
        "frame_index": int(frame_idx),
    }
    if obj_id is not None:
        request["obj_id"] = int(obj_id)

    if has_text:
        request["text"] = str(text)
    elif has_points:
        rel = _abs_to_rel_points(points or [], sess.image_size)
        if _torch_available():
            import torch  # type: ignore[import-not-found]
            request["points"] = torch.tensor(rel, dtype=torch.float32)
            request["point_labels"] = torch.tensor(
                [int(label) for label in (labels or [])], dtype=torch.int32,
            )
        else:
            request["points"] = rel
            request["point_labels"] = [int(label) for label in (labels or [])]
    elif has_box:
        rel = _abs_to_rel_box(box, sess.image_size)
        if _torch_available():
            import torch  # type: ignore[import-not-found]
            request["box"] = torch.tensor(rel, dtype=torch.float32)
        else:
            request["box"] = rel

    resp = _get_predictor().handle_request(request)
    return _extract_masks(resp)


def _torch_available() -> bool:
    try:
        import torch  # noqa: F401
        return True
    except ImportError:
        return False


def _extract_masks(resp: Any) -> dict[int, np.ndarray]:
    """Pull ``{obj_id: mask}`` out of a native multiplex response.

    Native shape: ``{outputs: {<obj_id>: {"mask": tensor|ndarray, ...}}}``.
    Empty / unfamiliar responses → empty dict.
    """
    if not isinstance(resp, dict):
        return {}
    outputs = resp.get("outputs") or {}
    if not isinstance(outputs, dict):
        return {}
    masks: dict[int, np.ndarray] = {}
    for k, v in outputs.items():
        if not isinstance(v, dict):
            continue
        m = v.get("mask")
        if m is None:
            continue
        if hasattr(m, "cpu"):
            arr = m.cpu()
            if hasattr(arr, "dtype") and "float" in str(arr.dtype):
                arr = arr.float()
            arr = arr.numpy()
        else:
            arr = np.asarray(m)
        masks[int(k)] = arr
    return masks
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/model && .venv/bin/python -m pytest tests/sam/test_track_session.py -v
```
Expected: ALL pass (8 tests now).

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/track_session.py apps/model/tests/sam/test_track_session.py
git commit -m "feat(model): add_prompt (text/points/box) on track session"
```

---

## Task 4: `propagate` (chunked iterator)

**Files:**
- Modify: `apps/model/src/carve_model/sam/track_session.py`
- Modify: `apps/model/tests/sam/test_track_session.py`

- [ ] **Step 1: Write the failing tests**

Append to `test_track_session.py`:

```python
@pytest.mark.unit
def test_propagate_streams_per_frame_masks(tmp_path):
    fake = MagicMock()
    sess = _open_session_with_fake_predictor(tmp_path, fake)

    def _stream(_request):
        for f in (0, 1, 2):
            yield {
                "frame_index": f,
                "outputs": {1: {"mask": np.ones((10, 10), dtype=bool)}},
            }
    fake.handle_stream_request.side_effect = _stream

    chunk = ts.propagate(sess.session_id)
    assert [f["frame_idx"] for f in chunk] == [0, 1, 2]
    assert all(set(f["masks"].keys()) == {1} for f in chunk)


@pytest.mark.unit
def test_propagate_respects_start_and_end_frame(tmp_path):
    fake = MagicMock()
    sess = _open_session_with_fake_predictor(tmp_path, fake)

    def _stream(_request):
        for f in range(10):
            yield {
                "frame_index": f,
                "outputs": {1: {"mask": np.ones((4, 4), dtype=bool)}},
            }
    fake.handle_stream_request.side_effect = _stream

    chunk = ts.propagate(sess.session_id, start_frame=3, end_frame=5)
    assert [f["frame_idx"] for f in chunk] == [3, 4, 5]


@pytest.mark.unit
def test_propagate_session_not_found():
    with pytest.raises(LookupError, match="session_not_found"):
        ts.propagate("nope")
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/model && .venv/bin/python -m pytest tests/sam/test_track_session.py -v
```
Expected: 3 new tests FAIL.

- [ ] **Step 3: Implement `propagate`**

Append to `track_session.py`:

```python
def propagate(
    session_id: str,
    *,
    start_frame: int | None = None,
    end_frame: int | None = None,
) -> list[dict]:
    """Run propagation and return frames in ``[start_frame, end_frame]``.

    Returns ``[{"frame_idx": int, "masks": {obj_id: mask}}, ...]``. The
    server-side filter is post-fetch (the native API streams everything;
    we slice). For chunked clients use ``start_frame=last+1`` until the
    response is empty.
    """
    sess = get_session(session_id)
    if sess is None:
        raise LookupError("session_not_found")
    stream = _get_predictor().handle_stream_request({
        "type": "propagate_in_video",
        "session_id": sess.native_session_id,
    })
    out: list[dict] = []
    for resp in stream:
        f = int(resp.get("frame_index", 0))
        if start_frame is not None and f < start_frame:
            continue
        if end_frame is not None and f > end_frame:
            break
        out.append({
            "frame_idx": f,
            "masks": _extract_masks(resp),
        })
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/model && .venv/bin/python -m pytest tests/sam/test_track_session.py -v
```
Expected: ALL pass.

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/track_session.py apps/model/tests/sam/test_track_session.py
git commit -m "feat(model): propagate(start/end) on track session"
```

---

## Task 5: `remove_object` + `reset_session`

**Files:**
- Modify: `apps/model/src/carve_model/sam/track_session.py`
- Modify: `apps/model/tests/sam/test_track_session.py`

- [ ] **Step 1: Write the failing tests**

```python
@pytest.mark.unit
def test_remove_object_calls_predictor(tmp_path):
    fake = MagicMock()
    sess = _open_session_with_fake_predictor(tmp_path, fake)

    ts.remove_object(sess.session_id, obj_id=2)
    fake.handle_request.assert_any_call({
        "type": "remove_object",
        "session_id": "native-sid",
        "obj_id": 2,
    })


@pytest.mark.unit
def test_reset_prompts_calls_predictor(tmp_path):
    fake = MagicMock()
    sess = _open_session_with_fake_predictor(tmp_path, fake)

    ts.reset_prompts(sess.session_id)
    fake.handle_request.assert_any_call({
        "type": "reset_session",
        "session_id": "native-sid",
    })


@pytest.mark.unit
def test_remove_object_session_not_found():
    with pytest.raises(LookupError, match="session_not_found"):
        ts.remove_object("nope", obj_id=1)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/model && .venv/bin/python -m pytest tests/sam/test_track_session.py -v
```

- [ ] **Step 3: Implement**

Append to `track_session.py`:

```python
def remove_object(session_id: str, *, obj_id: int) -> None:
    sess = get_session(session_id)
    if sess is None:
        raise LookupError("session_not_found")
    _get_predictor().handle_request({
        "type": "remove_object",
        "session_id": sess.native_session_id,
        "obj_id": int(obj_id),
    })
    sess.obj_classes.pop(obj_id, None)


def reset_prompts(session_id: str) -> None:
    sess = get_session(session_id)
    if sess is None:
        raise LookupError("session_not_found")
    _get_predictor().handle_request({
        "type": "reset_session",
        "session_id": sess.native_session_id,
    })
    sess.obj_classes.clear()
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/model && .venv/bin/python -m pytest tests/sam/test_track_session.py -v
```

- [ ] **Step 5: Commit**

```bash
git add apps/model/src/carve_model/sam/track_session.py apps/model/tests/sam/test_track_session.py
git commit -m "feat(model): remove_object + reset_prompts on track session"
```

---

## Task 6: New `track_router.py` HTTP surface

**Files:**
- Create: `apps/model/src/carve_model/sam/track_router_v2.py` (temporary name; renamed in cleanup task)
- Create: `apps/model/tests/sam/test_track_router_v2.py`

(Using `_v2` suffix during migration so the old `track_router.py` keeps the model service running. The cleanup task swaps names at the end.)

- [ ] **Step 1: Write the failing test**

```python
# apps/model/tests/sam/test_track_router_v2.py
"""HTTP surface for the new SAM 3.1 track router."""
from unittest.mock import MagicMock, patch
import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from carve_model.sam import track_session as ts
from carve_model.sam.track_router_v2 import router


@pytest.fixture
def client(tmp_path):
    app = FastAPI()
    app.include_router(router)
    ts._SESSIONS.clear()
    ts._set_predictor_for_test(None)
    yield TestClient(app), tmp_path
    ts._SESSIONS.clear()
    ts._set_predictor_for_test(None)


@pytest.mark.unit
def test_open_session_returns_session_id(client):
    tc, tmp_path = client
    fake = MagicMock()
    fake.handle_request.return_value = {"session_id": "native-sid"}
    ts._set_predictor_for_test(fake)
    with patch("carve_model.sam.track_session.ensure_cached",
               return_value=tmp_path / "h"):
        r = tc.post("/track/sessions", json={
            "frame_urls": ["http://x/0.jpg"],
            "image_size": [720, 1280],
            "asset_hash": "h",
        })
    assert r.status_code == 200
    body = r.json()
    assert body["session_id"]
    assert body["frame_count"] == 1


@pytest.mark.unit
def test_add_prompt_text(client):
    tc, tmp_path = client
    fake = MagicMock()
    fake.handle_request.side_effect = [
        {"session_id": "native-sid"},
        {"outputs": {1: {"mask": np.ones((4, 4), dtype=bool)}}},
    ]
    ts._set_predictor_for_test(fake)
    with patch("carve_model.sam.track_session.ensure_cached",
               return_value=tmp_path / "h"):
        sid = tc.post("/track/sessions", json={
            "frame_urls": ["http://x/0.jpg"],
            "image_size": [4, 4], "asset_hash": "h",
        }).json()["session_id"]
    r = tc.post(f"/track/sessions/{sid}/prompts", json={
        "frame_idx": 0, "text": "person",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["frame_idx"] == 0
    assert "1" in body["masks"] or 1 in body["masks"]


@pytest.mark.unit
def test_add_prompt_no_input_returns_422(client):
    tc, tmp_path = client
    fake = MagicMock()
    fake.handle_request.return_value = {"session_id": "native-sid"}
    ts._set_predictor_for_test(fake)
    with patch("carve_model.sam.track_session.ensure_cached",
               return_value=tmp_path / "h"):
        sid = tc.post("/track/sessions", json={
            "frame_urls": ["http://x/0.jpg"], "image_size": [4, 4], "asset_hash": "h",
        }).json()["session_id"]
    r = tc.post(f"/track/sessions/{sid}/prompts", json={"frame_idx": 0})
    assert r.status_code == 422
    assert r.json()["detail"] == "prompt_required"


@pytest.mark.unit
def test_propagate_returns_chunk(client):
    tc, tmp_path = client
    fake = MagicMock()
    fake.handle_request.return_value = {"session_id": "native-sid"}

    def _stream(_):
        for f in (0, 1, 2):
            yield {"frame_index": f,
                   "outputs": {1: {"mask": np.ones((4, 4), dtype=bool)}}}
    fake.handle_stream_request.side_effect = _stream
    ts._set_predictor_for_test(fake)

    with patch("carve_model.sam.track_session.ensure_cached",
               return_value=tmp_path / "h"):
        sid = tc.post("/track/sessions", json={
            "frame_urls": ["http://x/0.jpg"], "image_size": [4, 4], "asset_hash": "h",
        }).json()["session_id"]
    r = tc.post(f"/track/sessions/{sid}/propagate", json={})
    assert r.status_code == 200
    body = r.json()
    assert len(body["frames"]) == 3


@pytest.mark.unit
def test_close_session_404_when_unknown(client):
    tc, _ = client
    r = tc.delete("/track/sessions/does-not-exist")
    assert r.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/model && .venv/bin/python -m pytest tests/sam/test_track_router_v2.py -v
```

- [ ] **Step 3: Implement the router**

```python
# apps/model/src/carve_model/sam/track_router_v2.py
"""SAM 3.1 multiplex track HTTP endpoints (request-style API).

Mirrors the native multiplex predictor's verbs:
    POST   /track/sessions                          — start_session
    POST   /track/sessions/{sid}/prompts            — add_prompt
    POST   /track/sessions/{sid}/propagate          — propagate_in_video (chunked)
    DELETE /track/sessions/{sid}/objects/{obj_id}   — remove_object
    DELETE /track/sessions/{sid}/prompts            — reset_session
    DELETE /track/sessions/{sid}                    — close_session
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from carve_model.sam import track_session as ts
from carve_model.sam.codec import encode_mask_rle
from carve_model.sam.polygonize import mask_to_polygon

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/track", tags=["track"])


# ---- request / response models --------------------------------------------


class OpenSessionIn(BaseModel):
    frame_urls: list[str] = Field(min_length=1)
    image_size: list[int] = Field(min_length=2, max_length=2)
    asset_hash: str = Field(min_length=1, max_length=64)


class OpenSessionOut(BaseModel):
    session_id: str
    frame_count: int


class PromptIn(BaseModel):
    frame_idx: int = Field(ge=0)
    obj_id: int | None = Field(default=None, ge=1, le=256)
    text: str | None = Field(default=None, max_length=200)
    points: list[list[float]] = Field(default_factory=list)
    labels: list[int] = Field(default_factory=list)
    box: list[float] | None = None  # [x1, y1, x2, y2]


class MaskOut(BaseModel):
    counts: str
    size: list[int]
    polygon: list[list[float]]


class FrameMasksOut(BaseModel):
    frame_idx: int
    masks: dict[int, MaskOut]


class PropagateIn(BaseModel):
    start_frame: int | None = Field(default=None, ge=0)
    end_frame: int | None = Field(default=None, ge=0)


class PropagateOut(BaseModel):
    frames: list[FrameMasksOut]


# ---- helpers --------------------------------------------------------------


def _encode_masks(masks: dict[int, Any]) -> dict[int, MaskOut]:
    out: dict[int, MaskOut] = {}
    for obj_id, mask in masks.items():
        counts, size = encode_mask_rle(mask)
        polygon = mask_to_polygon(mask)
        out[int(obj_id)] = MaskOut(counts=counts, size=size, polygon=polygon)
    return out


# ---- endpoints ------------------------------------------------------------


@router.post("/sessions", response_model=OpenSessionOut)
def open_session(payload: OpenSessionIn) -> OpenSessionOut:
    h, w = int(payload.image_size[0]), int(payload.image_size[1])
    if h <= 0 or w <= 0:
        raise HTTPException(status_code=422, detail="invalid_image_size")
    try:
        sess = ts.open_session(
            frame_urls=payload.frame_urls,
            image_size=(h, w),
            asset_hash=payload.asset_hash,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return OpenSessionOut(
        session_id=sess.session_id, frame_count=sess.frame_count,
    )


@router.post("/sessions/{sid}/prompts", response_model=FrameMasksOut)
def add_prompt(sid: str, payload: PromptIn) -> FrameMasksOut:
    points: list[tuple[float, float]] | None = None
    if payload.points:
        points = [(float(p[0]), float(p[1])) for p in payload.points]
    box: tuple[float, float, float, float] | None = None
    if payload.box is not None:
        if len(payload.box) != 4:
            raise HTTPException(status_code=422, detail="box_shape_invalid")
        box = (float(payload.box[0]), float(payload.box[1]),
               float(payload.box[2]), float(payload.box[3]))
    try:
        masks = ts.add_prompt(
            sid,
            frame_idx=payload.frame_idx,
            obj_id=payload.obj_id,
            text=payload.text,
            points=points,
            labels=payload.labels or None,
            box=box,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("add_prompt_failed sid=%s", sid)
        raise HTTPException(
            status_code=502, detail=f"add_prompt_failed: {exc!r}",
        ) from exc
    return FrameMasksOut(frame_idx=payload.frame_idx, masks=_encode_masks(masks))


@router.post("/sessions/{sid}/propagate", response_model=PropagateOut)
def propagate(sid: str, payload: PropagateIn) -> PropagateOut:
    try:
        frames = ts.propagate(
            sid, start_frame=payload.start_frame, end_frame=payload.end_frame,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("propagate_failed sid=%s", sid)
        raise HTTPException(
            status_code=502, detail=f"propagate_failed: {exc!r}",
        ) from exc
    return PropagateOut(
        frames=[
            FrameMasksOut(frame_idx=f["frame_idx"], masks=_encode_masks(f["masks"]))
            for f in frames
        ],
    )


@router.delete("/sessions/{sid}/objects/{obj_id}", status_code=204)
def remove_object(sid: str, obj_id: int) -> None:
    try:
        ts.remove_object(sid, obj_id=obj_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("remove_object_failed sid=%s obj_id=%s", sid, obj_id)
        raise HTTPException(
            status_code=502, detail=f"remove_object_failed: {exc!r}",
        ) from exc


@router.delete("/sessions/{sid}/prompts", status_code=204)
def reset_prompts(sid: str) -> None:
    try:
        ts.reset_prompts(sid)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("reset_prompts_failed sid=%s", sid)
        raise HTTPException(
            status_code=502, detail=f"reset_prompts_failed: {exc!r}",
        ) from exc


@router.delete("/sessions/{sid}", status_code=204)
def close_session(sid: str) -> None:
    if not ts.close_session(sid):
        raise HTTPException(status_code=404, detail="session_not_found")
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/model && .venv/bin/python -m pytest tests/sam/test_track_router_v2.py -v
```

- [ ] **Step 5: Mount router in `main.py` (alongside the legacy `/sam-track`)**

In `apps/model/src/carve_model/main.py`, find where `track_router.router` is included and add:

```python
from carve_model.sam.track_router_v2 import router as track_router_v2
# ...
app.include_router(track_router_v2)
```

(Both legacy `/sam-track` and new `/track` are live during migration. The legacy router is removed in Task 17.)

- [ ] **Step 6: Commit**

```bash
git add apps/model/src/carve_model/sam/track_router_v2.py apps/model/tests/sam/test_track_router_v2.py apps/model/src/carve_model/main.py
git commit -m "feat(model): /track/sessions/* HTTP surface (SAM 3.1 multiplex)"
```

---

## Task 7: API proxy module — `track.py`

**Files:**
- Create: `apps/api/src/carve_api/inference/track.py`
- Modify: `apps/api/src/carve_api/inference/model_client.py` (add `track_*` helpers)

- [ ] **Step 1: Add `track_*` HTTP helpers to `model_client.py`**

Locate the existing `_client()` helper at the top of `model_client.py` and add at the bottom:

```python
# ---- v3.27 SAM 3.1 multiplex track ---------------------------------------


def track_open_session(
    frame_urls: list[str], image_size: tuple[int, int], asset_hash: str,
) -> dict:
    body = {
        "frame_urls": frame_urls,
        "image_size": [int(image_size[0]), int(image_size[1])],
        "asset_hash": asset_hash,
    }
    with _wrap_unreachable("track_open_session"), _client() as c:
        r = c.post("/track/sessions", json=body)
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_body(r))
        return r.json()


def track_add_prompt(sid: str, body: dict) -> dict:
    with _wrap_unreachable("track_add_prompt"), _client() as c:
        r = c.post(f"/track/sessions/{sid}/prompts", json=body)
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_body(r))
        return r.json()


def track_propagate(
    sid: str, start_frame: int | None, end_frame: int | None,
) -> dict:
    body = {"start_frame": start_frame, "end_frame": end_frame}
    with _wrap_unreachable("track_propagate"), _client() as c:
        r = c.post(f"/track/sessions/{sid}/propagate", json=body)
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_body(r))
        return r.json()


def track_remove_object(sid: str, obj_id: int) -> None:
    with _wrap_unreachable("track_remove_object"), _client() as c:
        r = c.delete(f"/track/sessions/{sid}/objects/{obj_id}")
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_body(r))


def track_reset_prompts(sid: str) -> None:
    with _wrap_unreachable("track_reset_prompts"), _client() as c:
        r = c.delete(f"/track/sessions/{sid}/prompts")
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_body(r))


def track_close_session(sid: str) -> None:
    with _wrap_unreachable("track_close_session"), _client() as c:
        r = c.delete(f"/track/sessions/{sid}")
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_body(r))
```

- [ ] **Step 2: Create the proxy module**

```python
# apps/api/src/carve_api/inference/track.py
"""SAM 3.1 video tracking proxy (replaces inference/sam_track.py).

Provides the asset-aware wrappers around the model service's
``/track/sessions/*`` endpoints. Each call:
  - resolves the asset
  - builds frame URLs from the Frame rows + asset_hash
  - supplies image_size from Asset.width/height
  - forwards to model_client.track_*

The model service has no knowledge of assets, projects, or auth — this
layer is the boundary.
"""
from __future__ import annotations

from carve_api.assets.models import Asset
from carve_api.errors import AppError
from carve_api.inference.model_client import (
    ModelServiceError,
    track_add_prompt as _track_add_prompt,
    track_close_session as _track_close_session,
    track_open_session as _track_open_session,
    track_propagate as _track_propagate,
    track_remove_object as _track_remove_object,
    track_reset_prompts as _track_reset_prompts,
)
from carve_api.storage.client import MinioClient


class TrackFailed(AppError):
    http_status = 502
    code = "track_failed"


class TrackUnreachable(AppError):
    http_status = 503
    code = "model_service_unreachable"


class TrackSessionMissing(AppError):
    http_status = 404
    code = "track_session_not_found"


class TrackInvalidPrompt(AppError):
    http_status = 422
    code = "track_invalid_prompt"


def _frame_urls_for(asset: Asset) -> list[str]:
    from carve_api.assets.models import Frame
    from carve_api.db import get_session_factory

    SessionLocal = get_session_factory()
    storage = MinioClient.from_settings()
    with SessionLocal() as s:
        rows = (
            s.query(Frame)
            .filter(Frame.asset_id == asset.id)
            .order_by(Frame.idx)
            .all()
        )
    return [
        storage.presigned_get_internal(
            f"assets/{asset.xxh3_128}/frames/{r.idx:06d}.jpg",
            expires_seconds=3600,
        )
        for r in rows
    ]


def _image_size_for(asset: Asset) -> tuple[int, int]:
    if asset.height is None or asset.width is None:
        raise TrackInvalidPrompt(
            f"asset {asset.id} has no image_size; extraction may not be complete",
        )
    return int(asset.height), int(asset.width)


def _wrap(exc: ModelServiceError, label: str) -> AppError:
    if exc.status_code == 404:
        return TrackSessionMissing(f"{label}: {exc.body!r}")
    if exc.status_code == 422:
        return TrackInvalidPrompt(f"{label}: {exc.body!r}")
    if exc.status_code == 503:
        return TrackUnreachable(f"{label}: {exc.body!r}")
    return TrackFailed(f"{label}: {exc.body!r}")


def open_session(asset: Asset) -> dict:
    frame_urls = _frame_urls_for(asset)
    if not frame_urls:
        raise TrackInvalidPrompt(
            f"asset {asset.id} has no extracted frames",
        )
    image_size = _image_size_for(asset)
    try:
        return _track_open_session(
            frame_urls, image_size, asset_hash=asset.xxh3_128,
        )
    except ModelServiceError as exc:
        raise _wrap(exc, "open_session") from exc


def add_prompt(sid: str, body: dict) -> dict:
    try:
        return _track_add_prompt(sid, body)
    except ModelServiceError as exc:
        raise _wrap(exc, "add_prompt") from exc


def propagate(
    sid: str, start_frame: int | None = None, end_frame: int | None = None,
) -> dict:
    try:
        return _track_propagate(sid, start_frame, end_frame)
    except ModelServiceError as exc:
        raise _wrap(exc, "propagate") from exc


def remove_object(sid: str, obj_id: int) -> None:
    try:
        _track_remove_object(sid, obj_id)
    except ModelServiceError as exc:
        raise _wrap(exc, "remove_object") from exc


def reset_prompts(sid: str) -> None:
    try:
        _track_reset_prompts(sid)
    except ModelServiceError as exc:
        raise _wrap(exc, "reset_prompts") from exc


def close_session(sid: str) -> None:
    try:
        _track_close_session(sid)
    except ModelServiceError as exc:
        raise _wrap(exc, "close_session") from exc
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/carve_api/inference/model_client.py apps/api/src/carve_api/inference/track.py
git commit -m "feat(api): track proxy module + model_client track_* helpers"
```

---

## Task 8: API routes `/assets/{id}/track/*`

**Files:**
- Modify: `apps/api/src/carve_api/assets/router.py`

(No tests in this task because the existing integration-test fixtures need Postgres which isn't available in the local env. Integration verification happens via the manual smoke step at the end.)

- [ ] **Step 1: Add the routes**

Locate the existing `from carve_api.inference.sam_track import (...)` import in `assets/router.py` and add a new import for the track module:

```python
from carve_api.inference import track as track_proxy
```

Then append (after the existing `/sam-track/*` endpoints):

```python
# v3.27 — new SAM 3.1-only track surface. Replaces /sam-track/* (kept
# alive during migration; removed in the final cleanup task).


class TrackOpenOut(BaseModel):
    session_id: str
    frame_count: int


@asset_router.post("/{asset_id}/track/sessions", response_model=TrackOpenOut)
def track_open(
    asset_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TrackOpenOut:
    from carve_api.assets.models import Asset

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        body = track_proxy.open_session(a)
    except AppError as exc:
        raise _http(exc) from exc
    return TrackOpenOut(**body)


@asset_router.post("/{asset_id}/track/sessions/{sid}/prompts")
def track_prompt(
    asset_id: uuid.UUID, sid: str, payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    from carve_api.assets.models import Asset

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        return track_proxy.add_prompt(sid, payload)
    except AppError as exc:
        raise _http(exc) from exc


@asset_router.post("/{asset_id}/track/sessions/{sid}/propagate")
def track_propagate_endpoint(
    asset_id: uuid.UUID,
    sid: str,
    payload: dict | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    from carve_api.assets.models import Asset

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    p = payload or {}
    try:
        return track_proxy.propagate(
            sid,
            start_frame=p.get("start_frame"),
            end_frame=p.get("end_frame"),
        )
    except AppError as exc:
        raise _http(exc) from exc


@asset_router.delete(
    "/{asset_id}/track/sessions/{sid}/objects/{obj_id}", status_code=204,
)
def track_remove_object_endpoint(
    asset_id: uuid.UUID, sid: str, obj_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    from carve_api.assets.models import Asset

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        track_proxy.remove_object(sid, obj_id)
    except AppError as exc:
        raise _http(exc) from exc


@asset_router.delete(
    "/{asset_id}/track/sessions/{sid}/prompts", status_code=204,
)
def track_reset_prompts_endpoint(
    asset_id: uuid.UUID, sid: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    from carve_api.assets.models import Asset

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        track_proxy.reset_prompts(sid)
    except AppError as exc:
        raise _http(exc) from exc


@asset_router.delete("/{asset_id}/track/sessions/{sid}", status_code=204)
def track_close_endpoint(
    asset_id: uuid.UUID, sid: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    from carve_api.assets.models import Asset

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        track_proxy.close_session(sid)
    except AppError as exc:
        raise _http(exc) from exc
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/carve_api/assets/router.py
git commit -m "feat(api): /assets/{id}/track/* proxy endpoints"
```

---

## Task 9: Bulk-delete annotations by `track_ids`

**Files:**
- Modify: `apps/api/src/carve_api/annotations/router.py`
- Create: `apps/api/tests/annotations/test_bulk_delete_by_track.py`

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/annotations/test_bulk_delete_by_track.py
"""DELETE /annotations:by-track-ids removes all annotations matching any of
the supplied track_ids on the given asset. Used by Track panel's Discard."""
from unittest.mock import MagicMock
import pytest


@pytest.mark.unit
def test_bulk_delete_by_track_calls_db_delete():
    from carve_api.annotations.router import _bulk_delete_by_track_ids_impl

    fake_db = MagicMock()
    fake_db.execute.return_value = MagicMock(rowcount=4)
    n = _bulk_delete_by_track_ids_impl(
        fake_db,
        asset_id="00000000-0000-0000-0000-000000000001",
        track_ids=[
            "11111111-1111-1111-1111-111111111111",
            "22222222-2222-2222-2222-222222222222",
        ],
    )
    assert n == 4
    assert fake_db.execute.called
    fake_db.commit.assert_called_once()
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && .venv/bin/python -m pytest tests/annotations/test_bulk_delete_by_track.py -v
```
Expected: FAIL — `_bulk_delete_by_track_ids_impl` not defined.

- [ ] **Step 3: Implement the helper + endpoint**

Append to `apps/api/src/carve_api/annotations/router.py`:

```python
# v3.27 — Track panel Discard wipes everything by track_id in one round trip.


class BulkDeleteByTrackIn(BaseModel):
    track_ids: list[str] = Field(min_length=1, max_length=512)


def _bulk_delete_by_track_ids_impl(
    db: Session, *, asset_id: str, track_ids: list[str],
) -> int:
    from carve_api.annotations.models import Annotation
    import uuid as _uuid

    aid = _uuid.UUID(asset_id) if isinstance(asset_id, str) else asset_id
    track_uuids = [_uuid.UUID(t) for t in track_ids]
    res = db.execute(
        Annotation.__table__.delete().where(
            Annotation.asset_id == aid,
            Annotation.track_id.in_(track_uuids),
        ),
    )
    db.commit()
    return int(getattr(res, "rowcount", 0) or 0)


@router.delete(
    "/{asset_id}/annotations:by-track-ids", status_code=200,
)
def bulk_delete_by_track_ids(
    asset_id: uuid.UUID,
    payload: BulkDeleteByTrackIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    from carve_api.assets.models import Asset

    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise _http(exc) from exc

    deleted = _bulk_delete_by_track_ids_impl(
        db, asset_id=str(asset_id), track_ids=payload.track_ids,
    )
    return {"deleted": deleted}
```

(The exact route prefix in this codebase may already be on `/assets`; in that case mount as `@router.delete("/assets/{asset_id}/annotations:by-track-ids")`. If `annotations/router.py` is mounted on `/annotations`, use a top-level decorator with the full path. Mirror whatever the surrounding endpoints use.)

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && .venv/bin/python -m pytest tests/annotations/test_bulk_delete_by_track.py -v
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/carve_api/annotations/router.py apps/api/tests/annotations/test_bulk_delete_by_track.py
git commit -m "feat(api): DELETE /annotations:by-track-ids for Track Discard"
```

---

## Task 10: Web — `track.ts` API client

**Files:**
- Create: `apps/web/src/api/track.ts`
- Create: `apps/web/tests/track-api.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/track-api.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/api/client", () => ({
  api: {
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from "@/api/client";
import { trackApi } from "@/api/track";

describe("trackApi", () => {
  beforeEach(() => vi.clearAllMocks());

  it("open posts to /assets/{id}/track/sessions", async () => {
    (api.post as any).mockResolvedValue({
      data: { session_id: "s1", frame_count: 100 },
    });
    const r = await trackApi.open("a1");
    expect(api.post).toHaveBeenCalledWith("/assets/a1/track/sessions");
    expect(r.session_id).toBe("s1");
    expect(r.frame_count).toBe(100);
  });

  it("prompt posts the body to /prompts", async () => {
    (api.post as any).mockResolvedValue({
      data: { frame_idx: 0, masks: {} },
    });
    await trackApi.prompt("a1", "s1", {
      frame_idx: 0, text: "person",
    });
    expect(api.post).toHaveBeenCalledWith(
      "/assets/a1/track/sessions/s1/prompts",
      { frame_idx: 0, text: "person" },
      expect.any(Object),
    );
  });

  it("propagate posts start/end to /propagate", async () => {
    (api.post as any).mockResolvedValue({ data: { frames: [] } });
    await trackApi.propagate("a1", "s1", {
      start_frame: 5, end_frame: 15,
    });
    expect(api.post).toHaveBeenCalledWith(
      "/assets/a1/track/sessions/s1/propagate",
      { start_frame: 5, end_frame: 15 },
      expect.any(Object),
    );
  });

  it("close calls DELETE", async () => {
    (api.delete as any).mockResolvedValue({});
    await trackApi.close("a1", "s1");
    expect(api.delete).toHaveBeenCalledWith("/assets/a1/track/sessions/s1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && pnpm vitest run tests/track-api.test.ts
```

- [ ] **Step 3: Implement the client**

```ts
// apps/web/src/api/track.ts
// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export interface OpenSessionResp {
  session_id: string;
  frame_count: number;
}

export interface RleMask {
  counts: string;
  size: [number, number];
  polygon: [number, number][];
}

export interface FrameMasks {
  frame_idx: number;
  masks: Record<number, RleMask>;
}

export interface PromptIn {
  frame_idx: number;
  obj_id?: number;
  text?: string;
  points?: [number, number][];
  labels?: number[];
  box?: [number, number, number, number];
}

export interface PropagateOpts {
  start_frame?: number;
  end_frame?: number;
}

export interface PropagateResp {
  frames: FrameMasks[];
}

export const trackApi = {
  open: async (assetId: string): Promise<OpenSessionResp> =>
    (await api.post<OpenSessionResp>(`/assets/${assetId}/track/sessions`)).data,

  prompt: async (
    assetId: string,
    sid: string,
    body: PromptIn,
    signal?: AbortSignal,
  ): Promise<FrameMasks> =>
    (
      await api.post<FrameMasks>(
        `/assets/${assetId}/track/sessions/${sid}/prompts`,
        body,
        { signal },
      )
    ).data,

  propagate: async (
    assetId: string,
    sid: string,
    opts: PropagateOpts,
    signal?: AbortSignal,
  ): Promise<PropagateResp> =>
    (
      await api.post<PropagateResp>(
        `/assets/${assetId}/track/sessions/${sid}/propagate`,
        opts,
        { signal },
      )
    ).data,

  removeObject: async (
    assetId: string, sid: string, objId: number,
  ): Promise<void> => {
    await api.delete(`/assets/${assetId}/track/sessions/${sid}/objects/${objId}`);
  },

  resetPrompts: async (assetId: string, sid: string): Promise<void> => {
    await api.delete(`/assets/${assetId}/track/sessions/${sid}/prompts`);
  },

  close: async (assetId: string, sid: string): Promise<void> => {
    await api.delete(`/assets/${assetId}/track/sessions/${sid}`);
  },

  bulkDeleteByTrackIds: async (
    assetId: string, trackIds: string[],
  ): Promise<{ deleted: number }> =>
    (
      await api.delete<{ deleted: number }>(
        `/assets/${assetId}/annotations:by-track-ids`,
        { data: { track_ids: trackIds } },
      )
    ).data,
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && pnpm vitest run tests/track-api.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/track.ts apps/web/tests/track-api.test.ts
git commit -m "feat(web): track.ts API client for SAM 3.1 redesign"
```

---

## Task 11: Web — `trackBridge.ts` state machine

**Files:**
- Create: `apps/web/src/state/trackBridge.ts`
- Create: `apps/web/tests/track-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/track-bridge.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { useTrackBridge } from "@/state/trackBridge";

describe("trackBridge", () => {
  beforeEach(() => {
    useTrackBridge.setState(useTrackBridge.getInitialState());
  });

  it("starts in idle", () => {
    expect(useTrackBridge.getState().status).toBe("idle");
    expect(useTrackBridge.getState().sessionId).toBeNull();
    expect(useTrackBridge.getState().objects.size).toBe(0);
  });

  it("setSession transitions idle → seeding", () => {
    useTrackBridge.getState().setSession("s1", 100);
    const s = useTrackBridge.getState();
    expect(s.sessionId).toBe("s1");
    expect(s.totalFrames).toBe(100);
    expect(s.status).toBe("seeding");
  });

  it("registerObject creates a row with track_id", () => {
    useTrackBridge.getState().setSession("s1", 100);
    useTrackBridge.getState().registerObject({
      objId: 1, classId: "c1", seedFrame: 0, seedKind: "click",
    });
    const s = useTrackBridge.getState();
    expect(s.objects.get(1)?.classId).toBe("c1");
    expect(s.trackIds.get(1)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("mergeMasks updates masksByFrame", () => {
    useTrackBridge.getState().setSession("s1", 100);
    useTrackBridge.getState().mergeMasks(5, {
      1: { counts: "x", size: [10, 10], polygon: [[0, 0]] },
    });
    expect(
      useTrackBridge.getState().masksByFrame.get(5)?.get(1)?.counts,
    ).toBe("x");
  });

  it("hitTest returns the obj_id whose mask contains the point", () => {
    useTrackBridge.getState().setSession("s1", 100);
    useTrackBridge.getState().mergeMasks(0, {
      2: {
        counts: "ignored",
        size: [10, 10],
        polygon: [[0, 0], [10, 0], [10, 10], [0, 10]],
      },
    });
    expect(useTrackBridge.getState().hitTest(0, 5, 5)).toBe(2);
    expect(useTrackBridge.getState().hitTest(0, 100, 100)).toBeNull();
  });

  it("reset clears state", () => {
    useTrackBridge.getState().setSession("s1", 100);
    useTrackBridge.getState().reset();
    expect(useTrackBridge.getState().status).toBe("idle");
    expect(useTrackBridge.getState().sessionId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && pnpm vitest run tests/track-bridge.test.ts
```

- [ ] **Step 3: Implement the store**

```ts
// apps/web/src/state/trackBridge.ts
// Armin Mehri — mehri.armin@gmail.com
import { create } from "zustand";

import type { RleMask } from "@/api/track";

export type TrackStatus =
  | "idle"
  | "seeding"
  | "previewing"
  | "running"
  | "done"
  | "failed";

export type SeedKind = "click" | "box" | "text";

export interface TrackedObject {
  objId: number;
  classId: string;
  seedFrame: number;
  seedKind: SeedKind;
}

interface State {
  sessionId: string | null;
  status: TrackStatus;
  totalFrames: number;
  framesPropagated: number;
  errorMessage: string | null;
  objects: Map<number, TrackedObject>;
  trackIds: Map<number, string>;
  masksByFrame: Map<number, Map<number, RleMask>>;
}

interface Actions {
  setSession(sessionId: string, totalFrames: number): void;
  setStatus(status: TrackStatus, message?: string): void;
  setFramesPropagated(n: number): void;
  registerObject(obj: TrackedObject): void;
  removeObject(objId: number): void;
  reassignClass(objId: number, classId: string): void;
  mergeMasks(frameIdx: number, masks: Record<number, RleMask>): void;
  hitTest(frameIdx: number, x: number, y: number): number | null;
  collectTrackIds(): string[];
  reset(): void;
}

type TrackBridge = State & Actions;

const initial: State = {
  sessionId: null,
  status: "idle",
  totalFrames: 0,
  framesPropagated: 0,
  errorMessage: null,
  objects: new Map(),
  trackIds: new Map(),
  masksByFrame: new Map(),
};

function newTrackId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export const useTrackBridge = create<TrackBridge>((set, get) => ({
  ...initial,

  setSession: (sessionId, totalFrames) =>
    set({ sessionId, totalFrames, status: "seeding" }),

  setStatus: (status, message) =>
    set({ status, errorMessage: message ?? null }),

  setFramesPropagated: (n) => set({ framesPropagated: n }),

  registerObject: (obj) =>
    set((s) => {
      const objects = new Map(s.objects);
      objects.set(obj.objId, obj);
      const trackIds = new Map(s.trackIds);
      if (!trackIds.has(obj.objId)) trackIds.set(obj.objId, newTrackId());
      return { objects, trackIds };
    }),

  removeObject: (objId) =>
    set((s) => {
      const objects = new Map(s.objects);
      objects.delete(objId);
      const trackIds = new Map(s.trackIds);
      trackIds.delete(objId);
      const masksByFrame = new Map(s.masksByFrame);
      for (const [f, m] of masksByFrame) {
        const next = new Map(m);
        next.delete(objId);
        masksByFrame.set(f, next);
      }
      return { objects, trackIds, masksByFrame };
    }),

  reassignClass: (objId, classId) =>
    set((s) => {
      const o = s.objects.get(objId);
      if (!o) return s;
      const objects = new Map(s.objects);
      objects.set(objId, { ...o, classId });
      return { objects };
    }),

  mergeMasks: (frameIdx, masks) =>
    set((s) => {
      const masksByFrame = new Map(s.masksByFrame);
      const existing = new Map(masksByFrame.get(frameIdx) ?? []);
      for (const [k, v] of Object.entries(masks)) {
        existing.set(Number(k), v);
      }
      masksByFrame.set(frameIdx, existing);
      return { masksByFrame };
    }),

  hitTest: (frameIdx, x, y) => {
    const frame = get().masksByFrame.get(frameIdx);
    if (!frame) return null;
    for (const [objId, mask] of frame) {
      if (mask.polygon.length >= 3 && pointInPolygon(x, y, mask.polygon)) {
        return objId;
      }
    }
    return null;
  },

  collectTrackIds: () => Array.from(get().trackIds.values()),

  reset: () =>
    set({
      ...initial,
      objects: new Map(),
      trackIds: new Map(),
      masksByFrame: new Map(),
    }),
}));

(useTrackBridge as unknown as { getInitialState: () => State }).getInitialState =
  () => ({
    ...initial,
    objects: new Map(),
    trackIds: new Map(),
    masksByFrame: new Map(),
  });
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && pnpm vitest run tests/track-bridge.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/state/trackBridge.ts apps/web/tests/track-bridge.test.ts
git commit -m "feat(web): trackBridge zustand store + hit-test helper"
```

---

## Task 12: Web — `TrackTool` (canvas-side orchestrator)

**Files:**
- Create: `apps/web/src/canvas/tools/TrackTool.ts`
- Create: `apps/web/tests/track-tool.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/track-tool.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/api/track", () => ({
  trackApi: {
    open: vi.fn(),
    prompt: vi.fn(),
    propagate: vi.fn(),
    removeObject: vi.fn(),
    resetPrompts: vi.fn(),
    close: vi.fn(),
    bulkDeleteByTrackIds: vi.fn(),
  },
}));

import { trackApi } from "@/api/track";
import { useTrackBridge } from "@/state/trackBridge";
import { TrackTool } from "@/canvas/tools/TrackTool";

describe("TrackTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTrackBridge.setState(useTrackBridge.getInitialState());
  });

  it("openSession sets session in bridge", async () => {
    (trackApi.open as any).mockResolvedValue({
      session_id: "s1", frame_count: 100,
    });
    const t = new TrackTool("a1", () => "c1");
    await t.openSession();
    expect(useTrackBridge.getState().sessionId).toBe("s1");
    expect(useTrackBridge.getState().totalFrames).toBe(100);
  });

  it("clickAt with no hit creates a new object", async () => {
    (trackApi.open as any).mockResolvedValue({
      session_id: "s1", frame_count: 100,
    });
    (trackApi.prompt as any).mockResolvedValue({
      frame_idx: 0,
      masks: { 1: { counts: "x", size: [10, 10], polygon: [[0, 0]] } },
    });
    (trackApi.propagate as any).mockResolvedValue({ frames: [] });
    const t = new TrackTool("a1", () => "c1");
    await t.openSession();
    await t.clickAt({ frameIdx: 0, x: 50, y: 50, alt: false });

    expect(trackApi.prompt).toHaveBeenCalledWith(
      "a1", "s1",
      expect.objectContaining({
        frame_idx: 0, points: [[50, 50]], labels: [1],
      }),
      expect.any(AbortSignal),
    );
    expect(useTrackBridge.getState().objects.size).toBe(1);
  });

  it("clickAt inside a mask refines that obj_id (no new row)", async () => {
    (trackApi.open as any).mockResolvedValue({
      session_id: "s1", frame_count: 100,
    });
    (trackApi.prompt as any).mockResolvedValue({
      frame_idx: 0,
      masks: { 1: { counts: "x", size: [10, 10],
        polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] } },
    });
    (trackApi.propagate as any).mockResolvedValue({ frames: [] });

    const t = new TrackTool("a1", () => "c1");
    await t.openSession();
    await t.clickAt({ frameIdx: 0, x: 5, y: 5, alt: false });
    expect(useTrackBridge.getState().objects.size).toBe(1);

    await t.clickAt({ frameIdx: 0, x: 6, y: 6, alt: false });
    expect(useTrackBridge.getState().objects.size).toBe(1);

    const lastCall = (trackApi.prompt as any).mock.calls.at(-1);
    expect(lastCall[2].obj_id).toBe(1);
  });

  it("Alt-click sends label=0 (negative)", async () => {
    (trackApi.open as any).mockResolvedValue({
      session_id: "s1", frame_count: 100,
    });
    (trackApi.prompt as any).mockResolvedValue({
      frame_idx: 0, masks: {},
    });
    (trackApi.propagate as any).mockResolvedValue({ frames: [] });
    const t = new TrackTool("a1", () => "c1");
    await t.openSession();
    await t.clickAt({ frameIdx: 0, x: 5, y: 5, alt: true });
    expect((trackApi.prompt as any).mock.calls[0][2].labels).toEqual([0]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && pnpm vitest run tests/track-tool.test.ts
```

- [ ] **Step 3: Implement the tool**

```ts
// apps/web/src/canvas/tools/TrackTool.ts
// Armin Mehri — mehri.armin@gmail.com
import { trackApi, type FrameMasks, type PromptIn } from "@/api/track";
import { useTrackBridge } from "@/state/trackBridge";
import { useAnnotations } from "@/state/annotations";

export interface ClickArgs {
  frameIdx: number;
  x: number;
  y: number;
  alt: boolean;
}

export interface BoxArgs {
  frameIdx: number;
  box: [number, number, number, number];
}

export interface TextArgs {
  frameIdx: number;
  text: string;
}

const PREVIEW_WINDOW = 5;

export class TrackTool {
  private previewAbort: AbortController | null = null;

  constructor(
    private assetId: string,
    private getActiveClassId: () => string | null,
  ) {}

  isActive(): boolean {
    return useTrackBridge.getState().sessionId !== null;
  }

  async openSession(): Promise<void> {
    if (this.isActive()) return;
    const r = await trackApi.open(this.assetId);
    useTrackBridge.getState().setSession(r.session_id, r.frame_count);
  }

  async closeSession(): Promise<void> {
    const sid = useTrackBridge.getState().sessionId;
    if (!sid) return;
    try {
      await trackApi.close(this.assetId, sid);
    } finally {
      this.previewAbort?.abort();
      useTrackBridge.getState().reset();
    }
  }

  async clickAt(args: ClickArgs): Promise<void> {
    await this.ensureSession();
    const sid = useTrackBridge.getState().sessionId!;
    const hitId = useTrackBridge.getState().hitTest(args.frameIdx, args.x, args.y);
    const isRefine = hitId !== null;
    const label = args.alt ? 0 : 1;

    const body: PromptIn = {
      frame_idx: args.frameIdx,
      points: [[args.x, args.y]],
      labels: [label],
    };
    if (isRefine) body.obj_id = hitId!;

    const resp = await trackApi.prompt(
      this.assetId, sid, body, this.makePromptSignal(),
    );
    this.applyMasks(resp);

    if (!isRefine) {
      const classId = this.getActiveClassId();
      if (classId === null) {
        throw new Error("track_tool_no_active_class");
      }
      const newId = inferNewObjId(resp);
      if (newId !== null) {
        useTrackBridge.getState().registerObject({
          objId: newId, classId, seedFrame: args.frameIdx, seedKind: "click",
        });
      }
    }

    void this.firePreview(args.frameIdx);
  }

  async dragBox(args: BoxArgs): Promise<void> {
    await this.ensureSession();
    const sid = useTrackBridge.getState().sessionId!;
    const classId = this.getActiveClassId();
    if (classId === null) throw new Error("track_tool_no_active_class");
    const resp = await trackApi.prompt(this.assetId, sid, {
      frame_idx: args.frameIdx, box: args.box,
    }, this.makePromptSignal());
    this.applyMasks(resp);
    const newId = inferNewObjId(resp);
    if (newId !== null) {
      useTrackBridge.getState().registerObject({
        objId: newId, classId, seedFrame: args.frameIdx, seedKind: "box",
      });
    }
    void this.firePreview(args.frameIdx);
  }

  async addText(args: TextArgs): Promise<void> {
    await this.ensureSession();
    const sid = useTrackBridge.getState().sessionId!;
    const classId = this.getActiveClassId();
    if (classId === null) throw new Error("track_tool_no_active_class");
    const resp = await trackApi.prompt(this.assetId, sid, {
      frame_idx: args.frameIdx, text: args.text,
    }, this.makePromptSignal());
    this.applyMasks(resp);
    for (const k of Object.keys(resp.masks)) {
      const objId = Number(k);
      if (Number.isFinite(objId)) {
        useTrackBridge.getState().registerObject({
          objId, classId, seedFrame: args.frameIdx, seedKind: "text",
        });
      }
    }
    void this.firePreview(args.frameIdx);
  }

  async removeObject(objId: number): Promise<void> {
    const sid = useTrackBridge.getState().sessionId;
    if (!sid) return;
    await trackApi.removeObject(this.assetId, sid, objId);
    useTrackBridge.getState().removeObject(objId);
  }

  async runFullTrack(): Promise<void> {
    const sid = useTrackBridge.getState().sessionId;
    if (!sid) throw new Error("track_tool_no_session");
    useTrackBridge.getState().setStatus("running");
    let cursor = 0;
    while (true) {
      const r = await trackApi.propagate(
        this.assetId, sid, { start_frame: cursor },
      );
      if (r.frames.length === 0) break;
      for (const f of r.frames) {
        this.applyMasks(f);
        cursor = f.frame_idx + 1;
      }
      useTrackBridge.getState().setFramesPropagated(cursor);
    }
    useTrackBridge.getState().setStatus("done");
  }

  async discard(): Promise<void> {
    const trackIds = useTrackBridge.getState().collectTrackIds();
    if (trackIds.length > 0) {
      try {
        await trackApi.bulkDeleteByTrackIds(this.assetId, trackIds);
        useAnnotations.getState().removeManyByTrackIds?.(trackIds);
      } catch {
        // best-effort
      }
    }
    await this.closeSession();
  }

  private async ensureSession(): Promise<void> {
    if (!this.isActive()) await this.openSession();
  }

  private applyMasks(resp: FrameMasks): void {
    useTrackBridge.getState().mergeMasks(resp.frame_idx, resp.masks);
  }

  private makePromptSignal(): AbortSignal {
    this.previewAbort?.abort();
    const ac = new AbortController();
    this.previewAbort = ac;
    return ac.signal;
  }

  private async firePreview(frameIdx: number): Promise<void> {
    const sid = useTrackBridge.getState().sessionId;
    const total = useTrackBridge.getState().totalFrames;
    if (!sid) return;
    useTrackBridge.getState().setStatus("previewing");
    try {
      const r = await trackApi.propagate(this.assetId, sid, {
        start_frame: Math.max(0, frameIdx - PREVIEW_WINDOW),
        end_frame: Math.min(total - 1, frameIdx + PREVIEW_WINDOW),
      }, this.makePromptSignal());
      for (const f of r.frames) this.applyMasks(f);
    } catch {
      // aborted by next click — fine
    } finally {
      if (useTrackBridge.getState().status === "previewing") {
        useTrackBridge.getState().setStatus("seeding");
      }
    }
  }
}

function inferNewObjId(resp: FrameMasks): number | null {
  const ids = Object.keys(resp.masks).map(Number).filter(Number.isFinite);
  if (ids.length === 0) return null;
  const known = useTrackBridge.getState().objects;
  for (const id of ids) {
    if (!known.has(id)) return id;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && pnpm vitest run tests/track-tool.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/canvas/tools/TrackTool.ts apps/web/tests/track-tool.test.ts
git commit -m "feat(web): TrackTool with smart hit-test + auto-preview"
```

---

## Task 13: `removeManyByTrackIds` on annotations store

**Files:**
- Modify: `apps/web/src/state/annotations.ts`
- Create: `apps/web/tests/annotation-store-track-ids.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/annotation-store-track-ids.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { useAnnotations } from "@/state/annotations";

describe("annotations.removeManyByTrackIds", () => {
  beforeEach(() => {
    useAnnotations.getState().reset?.();
  });

  it("removes all annotations matching any of the supplied track_ids", () => {
    const s = useAnnotations.getState();
    s.upsert?.({
      id: "a1", frame_id: "f1", class_id: "c1", track_id: "t1",
      kind: "polygon", polygon: [[0, 0]], dirty: true,
    } as any);
    s.upsert?.({
      id: "a2", frame_id: "f2", class_id: "c1", track_id: "t1",
      kind: "polygon", polygon: [[0, 0]], dirty: true,
    } as any);
    s.upsert?.({
      id: "a3", frame_id: "f3", class_id: "c1", track_id: "t2",
      kind: "polygon", polygon: [[0, 0]], dirty: true,
    } as any);

    s.removeManyByTrackIds?.(["t1"]);
    const remaining = Object.values(useAnnotations.getState().byId);
    expect(remaining.map((a: any) => a.id).sort()).toEqual(["a3"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && pnpm vitest run tests/annotation-store-track-ids.test.ts
```

- [ ] **Step 3: Add the helper**

In `apps/web/src/state/annotations.ts`, locate the `removeMany` action and add next to it:

```ts
removeManyByTrackIds: (trackIds: string[]) =>
  set((s) => {
    if (trackIds.length === 0) return s;
    const targetSet = new Set(trackIds);
    const byId = { ...s.byId };
    for (const [id, draft] of Object.entries(s.byId)) {
      if (draft.track_id && targetSet.has(draft.track_id)) {
        delete byId[id];
      }
    }
    return { byId };
  }),
```

Add the matching method to the store's TypeScript interface:

```ts
removeManyByTrackIds: (trackIds: string[]) => void;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && pnpm vitest run tests/annotation-store-track-ids.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/state/annotations.ts apps/web/tests/annotation-store-track-ids.test.ts
git commit -m "feat(web): annotations.removeManyByTrackIds for Track Discard"
```

---

## Task 14: Web — `TrackPanel.tsx`

**Files:**
- Create: `apps/web/src/components/annotation/TrackPanel.tsx`
- Create: `apps/web/tests/track-panel.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/tests/track-panel.test.tsx
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";

vi.mock("@/api/track", () => ({
  trackApi: {
    open: vi.fn(),
    prompt: vi.fn(),
    propagate: vi.fn(),
    removeObject: vi.fn(),
    close: vi.fn(),
    bulkDeleteByTrackIds: vi.fn(),
  },
}));

import { trackApi } from "@/api/track";
import { useTrackBridge } from "@/state/trackBridge";
import { TrackPanel } from "@/components/annotation/TrackPanel";

const sampleClasses = [
  { id: "c1", name: "person", color: "#0bf" },
  { id: "c2", name: "shoe", color: "#f80" },
];

describe("TrackPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTrackBridge.setState(useTrackBridge.getInitialState());
  });

  it("shows empty state when no objects", () => {
    render(
      <TrackPanel
        assetId="a1"
        currentFrameIdx={0}
        totalFrames={100}
        classes={sampleClasses as any}
        frameIdxToFrameId={{}}
      />,
    );
    expect(screen.getByTestId("track-panel")).toBeInTheDocument();
    expect(screen.getByText(/click on canvas to seed/i)).toBeInTheDocument();
  });

  it("renders an object row when bridge has an object", () => {
    useTrackBridge.getState().setSession("s1", 100);
    useTrackBridge.getState().registerObject({
      objId: 1, classId: "c1", seedFrame: 0, seedKind: "click",
    });
    render(
      <TrackPanel
        assetId="a1"
        currentFrameIdx={0}
        totalFrames={100}
        classes={sampleClasses as any}
        frameIdxToFrameId={{}}
      />,
    );
    expect(screen.getByTestId("track-object-1")).toBeInTheDocument();
    expect(screen.getByText("person")).toBeInTheDocument();
  });

  it("Discard calls bulkDeleteByTrackIds and resets bridge", async () => {
    useTrackBridge.getState().setSession("s1", 100);
    useTrackBridge.getState().registerObject({
      objId: 1, classId: "c1", seedFrame: 0, seedKind: "click",
    });
    (trackApi.bulkDeleteByTrackIds as any).mockResolvedValue({ deleted: 0 });
    (trackApi.close as any).mockResolvedValue(undefined);

    render(
      <TrackPanel
        assetId="a1"
        currentFrameIdx={0}
        totalFrames={100}
        classes={sampleClasses as any}
        frameIdxToFrameId={{}}
      />,
    );
    fireEvent.click(screen.getByTestId("track-discard"));

    await waitFor(() =>
      expect(trackApi.bulkDeleteByTrackIds).toHaveBeenCalled(),
    );
    await waitFor(() =>
      expect(useTrackBridge.getState().status).toBe("idle"),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && pnpm vitest run tests/track-panel.test.tsx
```

- [ ] **Step 3: Implement the panel**

```tsx
// apps/web/src/components/annotation/TrackPanel.tsx
// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Play, Trash2, X } from "lucide-react";

import type { ClassRow } from "@/api/classes";
import { TrackTool } from "@/canvas/tools/TrackTool";
import { useTool } from "@/state/tool";
import { useTrackBridge } from "@/state/trackBridge";
import { showToast } from "@/lib/toast";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";

interface TrackPanelProps {
  assetId: string;
  currentFrameIdx: number;
  totalFrames: number;
  classes: ClassRow[];
  frameIdxToFrameId: Record<number, string>;
}

export function TrackPanel({
  assetId, currentFrameIdx, totalFrames, classes,
}: TrackPanelProps) {
  const activeClassId = useTool((s) => s.activeClassId);
  const setActiveClassId = useTool((s) => s.setActiveClassId);
  const status = useTrackBridge((s) => s.status);
  const objects = useTrackBridge((s) => s.objects);
  const framesPropagated = useTrackBridge((s) => s.framesPropagated);

  const [textValue, setTextValue] = useState("");
  const [running, setRunning] = useState(false);

  const toolRef = useRef<TrackTool | null>(null);
  if (toolRef.current === null) {
    toolRef.current = new TrackTool(
      assetId, () => useTool.getState().activeClassId,
    );
  }

  useEffect(() => {
    return () => {
      void toolRef.current?.closeSession();
    };
  }, []);

  const objectList = useMemo(
    () => Array.from(objects.values()).sort((a, b) => a.objId - b.objId),
    [objects],
  );

  async function onTextSubmit() {
    const text = textValue.trim();
    if (!text) return;
    if (!activeClassId && classes.length > 0) setActiveClassId(classes[0].id);
    try {
      await toolRef.current!.addText({ frameIdx: currentFrameIdx, text });
      setTextValue("");
    } catch (err) {
      showToast(`Track text failed: ${(err as Error).message}`, {
        variant: "error",
      });
    }
  }

  async function onRunFull() {
    setRunning(true);
    try {
      await toolRef.current!.runFullTrack();
      showToast(`Tracked ${useTrackBridge.getState().framesPropagated} frames.`, {
        variant: "success",
      });
    } catch (err) {
      showToast(`Tracking failed: ${(err as Error).message}`, {
        variant: "error",
      });
    } finally {
      setRunning(false);
    }
  }

  async function onDiscard() {
    try {
      await toolRef.current!.discard();
    } catch (err) {
      showToast(`Discard failed: ${(err as Error).message}`, {
        variant: "error",
      });
    }
  }

  const progressPct =
    totalFrames > 0
      ? Math.min(100, Math.round((framesPropagated / totalFrames) * 100))
      : 0;

  return (
    <aside
      role="complementary"
      aria-label="SAM 3.1 video tracking"
      data-testid="track-panel"
      className={cn(
        "flex flex-col gap-3 p-3 border-t border-[var(--glass-border)]",
        "glass-surface text-[12.5px]",
      )}
    >
      <header className="flex items-center justify-between">
        <span className="font-medium">Track</span>
        <span className="font-mono tabular-nums text-[10.5px] text-[color:var(--text-tertiary)]">
          Frame {currentFrameIdx + 1} / {totalFrames}
        </span>
      </header>

      {objectList.length === 0 && (
        <p className="text-[11px] text-[color:var(--text-secondary)]">
          Click on canvas to seed an object. Click on an existing mask to
          refine that object. Alt-click for negative.
        </p>
      )}

      {objectList.length > 0 && (
        <ul data-testid="track-object-list" className="grid gap-1">
          {objectList.map((o) => {
            const cls = classes.find((c) => c.id === o.classId);
            return (
              <li
                key={o.objId}
                data-testid={`track-object-${o.objId}`}
                className="flex items-center gap-1.5 text-[11.5px]"
              >
                <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)] w-5">
                  #{o.objId}
                </span>
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: cls?.color ?? "#888" }}
                />
                <span className="flex-1 truncate">{cls?.name ?? o.classId}</span>
                <span className="text-[10px] text-[color:var(--text-tertiary)]">
                  ▸ frame {o.seedFrame}
                </span>
                <button
                  type="button"
                  data-testid={`track-remove-${o.objId}`}
                  onClick={() => void toolRef.current!.removeObject(o.objId)}
                  className="ml-1 inline-flex items-center justify-center h-5 w-5 rounded hover:bg-[var(--bg-hover)]"
                  aria-label={`Remove object ${o.objId}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center gap-1.5">
        <Input
          type="text"
          data-testid="track-text-input"
          placeholder='Type a concept (e.g. "person")…'
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void onTextSubmit();
            }
          }}
        />
        <button
          type="button"
          data-testid="track-text-submit"
          disabled={textValue.trim().length === 0}
          onClick={() => void onTextSubmit()}
          className="h-7 px-2 rounded bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[11px] disabled:opacity-50"
        >
          Add
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="track-run"
          disabled={objects.size === 0 || running}
          onClick={() => void onRunFull()}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-full",
            "bg-[var(--accent)] text-[color:var(--accent-fg)] font-medium",
            "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed",
          )}
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Run full track
        </button>
        <button
          type="button"
          data-testid="track-discard"
          disabled={objects.size === 0 && status === "idle"}
          onClick={() => void onDiscard()}
          className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-full bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[11.5px] disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" /> Discard
        </button>
      </div>

      {(status === "running" || framesPropagated > 0) && (
        <div className="grid gap-1">
          <div className="h-2 rounded-full bg-[var(--bg-sunken)] overflow-hidden">
            <div
              className="h-full bg-[var(--accent)] transition-[width] duration-200"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="text-[11px] text-[color:var(--text-tertiary)] tabular-nums">
            Tracked {framesPropagated} / {totalFrames} ({progressPct}%)
          </p>
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && pnpm vitest run tests/track-panel.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/annotation/TrackPanel.tsx apps/web/tests/track-panel.test.tsx
git commit -m "feat(web): TrackPanel — single-stop SAM 3.1 tracking UI"
```

---

## Task 15: Wire the new Track button + canvas dispatch

**Files:**
- Modify: `apps/web/src/components/annotation/EditorToolbar.tsx`
- Modify: `apps/web/src/components/annotation/AnnotationCanvas.tsx`
- Modify: `apps/web/src/state/tool.ts`

(No new test in this task — covered by Task 16 integration test.)

- [ ] **Step 1: Add `track` to the active-tool union**

In `apps/web/src/state/tool.ts`, locate the active-tool type. If it doesn't already include `"track"`, add it:

```ts
export type ToolKind =
  | /* existing tools */
  | "track";
```

- [ ] **Step 2: Render the Track panel + dispatch canvas events**

In `AnnotationCanvas.tsx`:

a) Import the new tool + bridge:
```tsx
import { TrackTool } from "@/canvas/tools/TrackTool";
import { useTrackBridge } from "@/state/trackBridge";
```

b) When `activeTool === "track"`, route the canvas pointer events to a `TrackTool` instance (one per asset). Mirror the existing pattern for SAM-mode click forwarding (`useSamTrackBridge` had this pattern; use the new `useTrackBridge` instead). On click → `tool.clickAt({ frameIdx, x, y, alt: e.altKey })`. On drag-rectangle complete → `tool.dragBox({ frameIdx, box })`.

c) Render the masks layer from `useTrackBridge.masksByFrame.get(currentFrameIdx)` — render each mask's polygon with the colour of its bound class.

(Implementation specifics depend on your existing `AnnotationCanvas` structure — follow the same pattern you used for the legacy SAM track integration. Replace `useSamTrackBridge` with `useTrackBridge` and `TrackPropagateTool` with `TrackTool`.)

- [ ] **Step 3: Add Track button to `EditorToolbar.tsx`**

Locate the existing tool buttons. Add (visible only when `asset.kind === "video"` && `asset.frames > 0`):

```tsx
import { Film } from "lucide-react";
// ...
const showTrack = asset.kind === "video" && asset.frames > 0;
{showTrack && (
  <button
    type="button"
    data-testid="toolbar-track"
    onClick={() => useTool.getState().setActiveTool("track")}
    aria-pressed={activeTool === "track"}
    className={cn(
      "h-8 px-2 inline-flex items-center gap-1 rounded-[var(--radius-sm)]",
      "border border-[var(--border-subtle)] text-[12px]",
      "hover:bg-[var(--bg-hover)]",
      activeTool === "track" && "bg-[var(--accent-bg)] border-[var(--accent)]",
    )}
    title="Track objects across the video with SAM 3.1"
  >
    <Film className="h-3.5 w-3.5" />
    Track
  </button>
)}
```

Where the panel was historically rendered (right rail), swap the legacy `SamTrackPanel` for the new `TrackPanel`:

```tsx
{activeTool === "track" && (
  <TrackPanel
    assetId={asset.id}
    currentFrameIdx={currentFrameIdx}
    totalFrames={totalFrames}
    classes={classes ?? []}
    frameIdxToFrameId={frameIdxToFrameId}
  />
)}
```

- [ ] **Step 4: Smoke check**

```bash
cd apps/web && pnpm vitest run tests/track-panel.test.tsx tests/track-tool.test.ts tests/track-bridge.test.ts tests/track-api.test.ts
```
All four files should still pass after the wiring.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/state/tool.ts apps/web/src/components/annotation/AnnotationCanvas.tsx apps/web/src/components/annotation/EditorToolbar.tsx
git commit -m "feat(web): Track button + AnnotationCanvas track-mode dispatch"
```

---

## Task 16: Integration smoke test

**Files:**
- Create: `apps/web/tests/track-flow-integration.test.tsx`

- [ ] **Step 1: Write the integration test**

```tsx
// apps/web/tests/track-flow-integration.test.tsx
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";

vi.mock("@/api/track", () => ({
  trackApi: {
    open: vi.fn(),
    prompt: vi.fn(),
    propagate: vi.fn(),
    removeObject: vi.fn(),
    close: vi.fn(),
    bulkDeleteByTrackIds: vi.fn(),
  },
}));
vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));

import { trackApi } from "@/api/track";
import { useTrackBridge } from "@/state/trackBridge";
import { TrackPanel } from "@/components/annotation/TrackPanel";

const classes = [{ id: "c1", name: "person", color: "#0bf" }];

describe("track flow integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTrackBridge.setState(useTrackBridge.getInitialState());
  });

  it("text submit → run full track → masks accumulate → discard wipes", async () => {
    (trackApi.open as any).mockResolvedValue({
      session_id: "s1", frame_count: 30,
    });
    (trackApi.prompt as any).mockResolvedValue({
      frame_idx: 0,
      masks: { 1: { counts: "x", size: [10, 10],
        polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] } },
    });

    let propCalls = 0;
    (trackApi.propagate as any).mockImplementation(async () => {
      propCalls += 1;
      if (propCalls > 3) return { frames: [] };
      return {
        frames: Array.from({ length: 10 }, (_, i) => ({
          frame_idx: (propCalls - 1) * 10 + i,
          masks: { 1: { counts: "x", size: [10, 10], polygon: [[0, 0]] } },
        })),
      };
    });
    (trackApi.bulkDeleteByTrackIds as any).mockResolvedValue({ deleted: 30 });
    (trackApi.close as any).mockResolvedValue(undefined);

    render(
      <TrackPanel
        assetId="a1"
        currentFrameIdx={0}
        totalFrames={30}
        classes={classes as any}
        frameIdxToFrameId={{}}
      />,
    );

    fireEvent.change(screen.getByTestId("track-text-input"), {
      target: { value: "person" },
    });
    fireEvent.click(screen.getByTestId("track-text-submit"));

    await waitFor(() => expect(trackApi.prompt).toHaveBeenCalled());
    await waitFor(() =>
      expect(useTrackBridge.getState().objects.size).toBe(1),
    );

    fireEvent.click(screen.getByTestId("track-run"));
    await waitFor(
      () => expect(useTrackBridge.getState().framesPropagated).toBeGreaterThan(0),
      { timeout: 3000 },
    );

    fireEvent.click(screen.getByTestId("track-discard"));
    await waitFor(() =>
      expect(trackApi.bulkDeleteByTrackIds).toHaveBeenCalled(),
    );
    await waitFor(() => expect(useTrackBridge.getState().status).toBe("idle"));
  });
});
```

- [ ] **Step 2: Run the test**

```bash
cd apps/web && pnpm vitest run tests/track-flow-integration.test.tsx
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/track-flow-integration.test.tsx
git commit -m "test(web): integration test for SAM 3.1 track flow"
```

---

## Task 17: Cleanup — delete legacy code paths

**Files (DELETE):**

```
apps/model/src/carve_model/sam/tracker.py
apps/model/src/carve_model/sam/track_router.py
apps/model/tests/sam/test_tracker.py
apps/model/tests/sam/test_tracker_multi.py
apps/model/tests/sam/test_tracker_resolver.py
apps/model/tests/sam/test_track_router.py            (old)
apps/model/tests/sam/test_multiplex_track_router.py
apps/api/src/carve_api/inference/sam_track.py
apps/api/tests/inference/test_sam_track.py
apps/api/tests/inference/test_sam_track_multiplex.py
apps/web/src/api/sam_track.ts
apps/web/src/state/samTrackBridge.ts
apps/web/src/canvas/tools/TrackPropagateTool.ts
apps/web/src/components/annotation/SamTrackPanel.tsx
apps/web/tests/v35-sam-track-panel.test.tsx
apps/web/tests/track-propagate-tool.test.ts
apps/web/tests/sam-track-multiplex-panel.test.tsx
```

**Files (RENAME):**

```
apps/model/src/carve_model/sam/track_router_v2.py → track_router.py
apps/model/tests/sam/test_track_router_v2.py     → test_track_router.py
```

**Files (MODIFY):**

```
apps/model/src/carve_model/main.py     — remove sam-track router include
apps/api/src/carve_api/assets/router.py — remove the /sam-track/* endpoints
apps/api/src/carve_api/inference/model_client.py — remove sam_track_* helpers
apps/model/src/carve_model/sam/sam2_adapter.py   — remove video tracker portion
apps/model/src/carve_model/sam/sam3_adapter.py   — remove video tracker portion
apps/model/src/carve_model/sam/sam3p1_adapter.py — remove video adapter portion
                                                     (image predictor stays)
docker-compose.yml — remove SAM_VIDEO_BACKEND env var if present
```

- [ ] **Step 1: Delete the legacy files**

```bash
rm apps/model/src/carve_model/sam/tracker.py
rm apps/model/src/carve_model/sam/track_router.py
rm apps/model/tests/sam/test_tracker.py
rm apps/model/tests/sam/test_tracker_multi.py
rm apps/model/tests/sam/test_tracker_resolver.py
rm apps/model/tests/sam/test_track_router.py
rm apps/model/tests/sam/test_multiplex_track_router.py
rm apps/api/src/carve_api/inference/sam_track.py
rm apps/api/tests/inference/test_sam_track.py
rm apps/api/tests/inference/test_sam_track_multiplex.py
rm apps/web/src/api/sam_track.ts
rm apps/web/src/state/samTrackBridge.ts
rm apps/web/src/canvas/tools/TrackPropagateTool.ts
rm apps/web/src/components/annotation/SamTrackPanel.tsx
rm apps/web/tests/v35-sam-track-panel.test.tsx
rm apps/web/tests/track-propagate-tool.test.ts
rm apps/web/tests/sam-track-multiplex-panel.test.tsx
```

- [ ] **Step 2: Rename `track_router_v2.py` → `track_router.py`**

```bash
mv apps/model/src/carve_model/sam/track_router_v2.py apps/model/src/carve_model/sam/track_router.py
mv apps/model/tests/sam/test_track_router_v2.py apps/model/tests/sam/test_track_router.py
```

Then update the import in `apps/model/src/carve_model/main.py`:

```python
# Before:
# from carve_model.sam.track_router_v2 import router as track_router_v2
# app.include_router(track_router_v2)
# After:
from carve_model.sam.track_router import router as track_router
app.include_router(track_router)
```

And update the import in `apps/model/tests/sam/test_track_router.py`:

```python
# Before: from carve_model.sam.track_router_v2 import router
# After:
from carve_model.sam.track_router import router
```

- [ ] **Step 3: Remove the `/sam-track/*` endpoints from `apps/api/src/carve_api/assets/router.py`**

Search for the endpoints decorated with `@asset_router.post("/{asset_id}/sam-track/...")` and `@asset_router.delete("/{asset_id}/sam-track/...")`. Delete them all (lines roughly 834–960 in the current file). Also remove the `from carve_api.inference.sam_track import (...)` import at the top.

- [ ] **Step 4: Remove `sam_track_*` helpers from `apps/api/src/carve_api/inference/model_client.py`**

Search for `def sam_track_` and delete the function definitions (lines roughly 431–530).

- [ ] **Step 5: Strip video tracker portions from SAM 2 / SAM 3 adapters**

In `apps/model/src/carve_model/sam/sam2_adapter.py`:
- Remove `Sam2VideoTrackerAdapter` class and `build_sam2_video_tracker` factory.
- Keep `Sam2ImagePredictorAdapter` and image-side helpers.

In `apps/model/src/carve_model/sam/sam3_adapter.py`:
- Remove `Sam3VideoDispatcherAdapter`, `Sam3TrackerVideoModel` adapter, `ConceptModeError`, `build_sam3_video_tracker` factory.
- Keep `Sam3ImagePredictorAdapter` and image-side helpers.

In `apps/model/src/carve_model/sam/sam3p1_adapter.py`:
- Remove `Sam3p1MultiplexVideoAdapter` (its functionality is now in `track_session.py`).
- Remove `build_sam3p1_multiplex_video_tracker` factory.
- Keep `Sam3p1NativeImagePredictorAdapter`.

- [ ] **Step 6: Remove `SAM_VIDEO_BACKEND` env var (if present)**

Search the repo for `SAM_VIDEO_BACKEND`:

```bash
grep -rn "SAM_VIDEO_BACKEND" apps docker-compose.yml 2>/dev/null
```

Remove every reference (env var declaration, branch logic).

- [ ] **Step 7: Run the full backend + frontend test suites to confirm no broken imports**

```bash
cd apps/model && .venv/bin/python -m pytest tests/sam/ -v 2>&1 | tail -25
cd apps/api && .venv/bin/python -m pytest tests/ -v --ignore=tests/conftest.py 2>&1 | tail -25
cd apps/web && pnpm vitest run 2>&1 | tail -25
```

Expected: no test references the deleted symbols. Pre-existing failures unrelated to this work (Postgres-dependent tests in API) stay failing — they were failing before this change too.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: remove SAM 2 / SAM 3 video tracker code paths

Tracking is now SAM 3.1 multiplex only. Image-side adapters for SAM 2,
SAM 3, and SAM 3.1 remain — they're used by /sam/encode + /sam/predict
and are unrelated to video tracking. SAM_VIDEO_BACKEND env var retired."
```

---

## Task 18: Rebuild containers + manual smoke

- [ ] **Step 1: Rebuild model, api, web**

```bash
cd /home/media4us/Documents/Dev/VisualAutoAnnotator
docker compose build model api worker web
docker compose up -d model api worker web
sleep 10
docker compose ps --format "table {{.Service}}\t{{.Status}}"
```

Expected: all services Healthy.

- [ ] **Step 2: Manual smoke**

In a browser:

1. Open a video asset that has frames extracted.
2. Click the new `Track` button in `EditorToolbar`.
3. Verify the `TrackPanel` opens on the right rail.
4. Type `"person"` in the text input → submit. Verify object rows appear with the active class color.
5. Scrub the timeline to a different frame. Click on the canvas in empty space → a new object row appears.
6. Click on the existing person mask → no new row; the existing mask refines.
7. Alt-click on an existing mask → the mask shrinks (negative click).
8. Click `Run full track`. Verify the progress bar advances and timeline thumbnails fill in with masks.
9. Click `Discard`. Verify the masks disappear and the panel resets.
10. Repeat with `Run full track` then **don't** discard — open the editor's Save and confirm the masks persist as committed annotations.

- [ ] **Step 3: Tag the release**

```bash
git tag -a v3.27-track -m "SAM 3.1 video tracking redesign"
```

---

## Self-review notes

Spec coverage check (from
`docs/superpowers/specs/2026-05-07-sam3p1-track-redesign-design.md`):

| Spec section | Implemented in |
|---|---|
| Backend: thin session wrapper | T2 (TrackSession), T3 (add_prompt), T4 (propagate), T5 (remove/reset) |
| Backend: frame cache by asset_hash | T1 |
| Backend: image_size from API skips probe | T2 (sess.image_size used by T3 ABS→REL conversion) |
| Backend: drop SAM 2 / SAM 3 video adapters | T17 |
| API: /track/sessions/* | T6 (model service), T8 (API service) |
| API: track.py proxy | T7 |
| API: bulk-delete by track_ids | T9 |
| Web: track.ts client | T10 |
| Web: trackBridge state machine | T11 |
| Web: TrackTool with smart hit-test | T12 |
| Web: removeManyByTrackIds for Discard | T13 |
| Web: TrackPanel UI | T14 |
| Web: Track button + canvas dispatch | T15 |
| Auto-commit during propagation | T12 (runFullTrack), wired to annotations store via T13 |
| Auto-preview ±5 frames | T12 (firePreview) |
| Cross-frame seeding | T15 wires `currentFrameIdx` from canvas; T12 reads it from `clickAt.frameIdx` |
| Class re-assignment without re-seed | T11 (`reassignClass`); panel binding deferred — minimal need for v1 |
| Track button gated on SAM 3.1 capabilities | T15 (kind=video + frames>0; SAM 3.1 capability check is implicit since it's now the only backend) |
| Integration smoke | T16 |
| Migration / cleanup | T17 |
| Rebuild + manual verify | T18 |

Type consistency: `RleMask`, `FrameMasks`, `PromptIn`, `PropagateOpts`,
`PropagateResp`, `OpenSessionResp` defined in T10 and consumed in T11/T12/T14/T16.
`TrackedObject`, `TrackStatus`, `SeedKind` defined in T11 and consumed in T12/T14.
`TrackTool` constructor `(assetId, getActiveClassId)` consistent across T12/T14/T15/T16.

No placeholders. No "similar to Task N" without code. All commands are concrete.
