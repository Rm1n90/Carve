"""Tests for the v3.5 Phase A1 SamSession desync fix.

Before v3.5, the predictor was a module global ``_PREDICTOR`` and the
"most recently encoded image" hash + shape lived in ``router.py`` as
separate module globals (``_LOADED_HASH``, ``_LOADED_SHAPE``). Lifecycle
operations (idle eviction, force-evict, variant switch) replaced
``_PREDICTOR`` but never cleared the router's hash → ``/sam/decode``
passed the hash gate while calling a fresh predictor whose
``set_image`` had never been called, raising
``RuntimeError: set_image must be called before predict`` (HTTP 500).

These tests pin the new contract:

1. ``force_evict_predictor`` clears ``loaded_hash`` along with the
   predictor.
2. ``load_predictor(variant)`` resets the session (predictor + hash)
   together when the variant changes.
3. End-to-end: encode → evict → decode-with-stale-hash returns 409
   (``embedding_not_loaded``), NEVER 500.
"""

from __future__ import annotations

import base64
import io
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from carve_model.main import create_app
from carve_model.sam import predictor as p_mod
from carve_model.sam import router as r_mod


def _png_b64(w: int = 32, h: int = 24) -> str:
    img = Image.new("RGB", (w, h), color=(10, 20, 30))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


class _FakePredictor:
    """Minimal SamPredictor stand-in with a single canned mask."""

    def __init__(self) -> None:
        self.set_image_calls: list[tuple[int, ...]] = []

    def set_image(self, image: Any) -> None:
        self.set_image_calls.append(tuple(image.shape))

    def predict(self, point_coords, point_labels, multimask_output=True):
        mask = np.zeros((4, 4), dtype=np.uint8)
        return np.stack([mask, mask, mask]), np.array([0.1, 0.2, 0.3]), None


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    p_mod.set_test_predictor(None)
    p_mod._set_test_session(None)
    monkeypatch.delenv("SAM_MODEL", raising=False)
    monkeypatch.delenv("SAM_VARIANT", raising=False)
    yield
    p_mod.set_test_predictor(None)
    p_mod._set_test_session(None)


# --- A1.1 force_evict clears loaded_hash ------------------------------------


def test_force_evict_clears_loaded_hash() -> None:
    """force_evict_predictor() drops both predictor AND loaded_hash atomically."""
    p_mod._set_test_session(object())
    p_mod.set_loaded_image("deadbeef" * 4, [10, 20])

    session = p_mod.get_session()
    assert session is not None
    assert session.loaded_hash == "deadbeef" * 4
    assert session.loaded_shape == [10, 20]

    assert p_mod.force_evict_predictor() is True

    assert p_mod.get_session() is None  # session is gone
    assert p_mod._PREDICTOR is None  # type: ignore[attr-defined]


def test_evict_if_idle_clears_loaded_hash(monkeypatch) -> None:
    """The idle sweep also clears loaded_hash atomically with the predictor."""
    import time

    monkeypatch.setenv("SAM_IDLE_TIMEOUT_S", "1")
    # Backdate last_used_at so the timeout fires.
    p_mod._set_test_session(object(), last_used_at=time.monotonic() - 10)
    p_mod.set_loaded_image("c0ffee" * 5 + "ab", [4, 4])

    assert p_mod.evict_predictor_if_idle() is True
    assert p_mod.get_session() is None


# --- A1.2 load_predictor resets the session ---------------------------------


def test_load_predictor_resets_session(monkeypatch) -> None:
    """Switching variants drops the existing session entirely.

    The hot-swap path must clear the loaded image hash so a /sam/decode
    after the switch returns 409 (re-encode required), not 500.
    """
    # Simulate "currently on sam2.1-tiny with image X loaded".
    monkeypatch.setenv("SAM_MODEL", "sam2.1-tiny")
    p_mod._set_test_session(object())
    p_mod.set_loaded_image("aa" * 16, [8, 8])

    # Stub the heavy default factory so the eager rebuild doesn't try
    # to download a 2 GB checkpoint in CI.
    rebuilt = object()
    monkeypatch.setattr(p_mod, "_default_factory", lambda: rebuilt)

    p_mod.load_predictor("sam2.1-small")

    session = p_mod.get_session()
    assert session is not None
    # New predictor is in place — the test fake from before is gone.
    assert session.predictor is rebuilt
    # loaded_hash must NOT carry over across the switch.
    assert session.loaded_hash is None
    assert session.loaded_shape == []


def test_load_predictor_noop_keeps_session(monkeypatch) -> None:
    """Switching to the same variant with a session already loaded is a no-op.

    The session — including loaded_hash — must remain intact.
    """
    monkeypatch.setenv("SAM_MODEL", "sam2.1-tiny")
    sentinel_predictor = object()
    p_mod._set_test_session(sentinel_predictor)
    p_mod.set_loaded_image("ff" * 16, [12, 12])

    # Default factory should NOT run when the no-op short-circuits.
    monkeypatch.setattr(
        p_mod,
        "_default_factory",
        lambda: pytest.fail("default factory should not be called on no-op switch"),
    )

    p_mod.load_predictor("sam2.1-tiny")

    session = p_mod.get_session()
    assert session is not None
    assert session.predictor is sentinel_predictor
    assert session.loaded_hash == "ff" * 16


# --- A1.3 end-to-end: encode + evict + decode_with_stale_hash → 409 ---------


def test_encode_then_evict_then_decode_returns_409_not_500() -> None:
    """The desync regression test.

    1. Inject a fake predictor.
    2. POST /sam/encode → grabs an image_hash.
    3. Call force_evict_predictor() to drop the session.
    4. Re-inject the same fake (so /sam/decode finds *some* predictor).
    5. POST /sam/decode with the OLD image_hash.

    Pre-fix this returned 500 because the router's _LOADED_HASH still
    matched and the predictor had no loaded image. Post-fix the session
    is None after evict, so the hash gate trips and we get 409.
    """
    fake = _FakePredictor()
    p_mod.set_test_predictor(fake)
    r_mod._reset_for_test()
    client = TestClient(create_app())

    # 1. Encode — populates the session's loaded_hash.
    enc = client.post("/sam/encode", json={"image_b64": _png_b64()})
    assert enc.status_code == 200
    image_hash = enc.json()["image_hash"]

    # 2. Evict — drops the session (predictor + loaded_hash together).
    assert p_mod.force_evict_predictor() is True

    # 3. Re-inject the same fake so /sam/decode has a predictor to call,
    #    BUT the session's loaded_hash is gone. Pre-A1, _LOADED_HASH
    #    survived this and decode would ask the fake to predict without
    #    set_image having been called → 500.
    p_mod.set_test_predictor(fake)

    # 4. Decode with the stale hash → must be 409, NEVER 500.
    dec = client.post(
        "/sam/decode",
        json={"image_hash": image_hash, "points": [[1, 2]], "labels": [1]},
    )
    assert dec.status_code == 409, dec.text
    assert "embedding_not_loaded" in dec.json()["detail"]


def test_encode_then_switch_then_decode_returns_409_not_500(monkeypatch) -> None:
    """Variant switch is the other path that previously desynced.

    Encode → switch → decode-with-old-hash must yield 409.
    """
    fake = _FakePredictor()
    p_mod.set_test_predictor(fake)
    r_mod._reset_for_test()
    client = TestClient(create_app())

    # 1. Encode under the current variant.
    enc = client.post("/sam/encode", json={"image_b64": _png_b64()})
    assert enc.status_code == 200
    image_hash = enc.json()["image_hash"]

    # 2. Switch — at the test-predictor level this only resets the
    #    session and updates SAM_MODEL. The fake stays installed because
    #    it's wired through ``_TEST_PREDICTOR``.
    monkeypatch.setenv("SAM_MODEL", "sam2.1-tiny")
    p_mod.load_predictor("sam2.1-small")

    # 3. Decode with the stale image_hash from before the switch.
    dec = client.post(
        "/sam/decode",
        json={"image_hash": image_hash, "points": [[1, 2]], "labels": [1]},
    )
    assert dec.status_code == 409, dec.text
