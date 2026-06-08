"""Stage 1 — server-side ONNX vision-encoder for client-side SAM decode.

Tests the encoder module (preprocess, tensor serialisation, the encoder
registry, payload assembly) and the extended ``/sam/encode`` response that
ships the 3 float16 embeddings + ``encoder_id`` + ``input_size`` + ``norm``.

The decoder stays in the browser (Stage 2); the server ``/sam/decode`` path
is untouched and remains the universal fallback. The numeric pipeline mirrors
``apps/model/scripts/sam_tracker_parity_check.py`` (the Stage-0 golden parity
reference) by construction: resize -> /255 -> (x-mean)/std -> NCHW float32.
"""

import base64
import io
import threading
from typing import Any

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from carve_model.main import create_app
from carve_model.sam import onnx_encoder as onnx_mod
from carve_model.sam import predictor as predictor_mod
from carve_model.sam import router as router_mod
from carve_model.sam.onnx_encoder import (
    ENCODER_SPECS,
    EncoderSpec,
    build_encode_payload,
    encoder_id_for,
    preprocess,
    reset_test_encoder,
    serialize_tensor,
    set_test_encoder,
)


# --------------------------------------------------------------------------
# helpers / fakes
# --------------------------------------------------------------------------
def _png_b64(w: int = 32, h: int = 24) -> str:
    img = Image.new("RGB", (w, h), color=(10, 20, 30))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


class _FakePredictor:
    """Records set_image calls and returns canned masks (mirrors test_router)."""

    def __init__(self, mask: np.ndarray, score: float = 0.91):
        self.set_image_calls: list[tuple[int, ...]] = []
        self._mask = mask
        self._score = score

    def set_image(self, image: Any) -> None:
        self.set_image_calls.append(tuple(image.shape))

    def predict(self, point_coords, point_labels, multimask_output=True, box=None, mask_input=None):
        masks = np.stack([np.zeros_like(self._mask), np.zeros_like(self._mask), self._mask])
        scores = np.array([0.1, 0.2, self._score])
        return masks, scores, None


class _FakeEncoder:
    """Returns three canned named embeddings, recording how often it ran."""

    def __init__(self) -> None:
        self.calls = 0
        self.last_image_shape: tuple[int, ...] | None = None

    def encode(self, img_rgb: np.ndarray) -> dict[str, np.ndarray]:
        self.calls += 1
        self.last_image_shape = tuple(img_rgb.shape)
        return {
            "image_embeddings.0": np.zeros((1, 32, 4, 4), np.float32),
            "image_embeddings.1": np.ones((1, 64, 2, 2), np.float32),
            "image_embeddings.2": np.full((1, 256, 1, 1), 0.5, np.float32),
        }


class _BoomEncoder:
    def encode(self, img_rgb: np.ndarray) -> dict[str, np.ndarray]:
        raise RuntimeError("encoder exploded")


def teardown_function(_):  # pytest module-level teardown
    predictor_mod.set_test_predictor(None)
    router_mod._reset_for_test()
    reset_test_encoder()


# --------------------------------------------------------------------------
# preprocess — matches the Stage-0 parity script exactly
# --------------------------------------------------------------------------
def test_preprocess_produces_nchw_normalized_tensor() -> None:
    # Arrange — a 1x1 pure-red image, symmetric 0.5 normalisation (SAM 3).
    img = np.zeros((1, 1, 3), np.uint8)
    img[..., 0] = 255
    spec = EncoderSpec(
        encoder_id="t", repo="", encoder_file="", input_size=2,
        mean=(0.5, 0.5, 0.5), std=(0.5, 0.5, 0.5),
    )

    # Act
    pix = preprocess(img, spec)

    # Assert — NCHW float32, red -> +1, green/blue -> -1.
    assert pix.shape == (1, 3, 2, 2)
    assert pix.dtype == np.float32
    assert np.allclose(pix[0, 0], 1.0)
    assert np.allclose(pix[0, 1], -1.0)
    assert np.allclose(pix[0, 2], -1.0)


def test_preprocess_applies_per_channel_imagenet_norm() -> None:
    # Arrange — uniform gray, ImageNet per-channel mean/std (SAM 2.1).
    img = np.full((1, 1, 3), 128, np.uint8)
    spec = EncoderSpec(
        encoder_id="t", repo="", encoder_file="", input_size=1,
        mean=(0.485, 0.456, 0.406), std=(0.229, 0.224, 0.225),
    )

    # Act
    pix = preprocess(img, spec)

    # Assert — each channel normalised by its own mean/std.
    v = 128 / 255.0
    assert np.allclose(pix[0, 0, 0, 0], (v - 0.485) / 0.229, atol=1e-5)
    assert np.allclose(pix[0, 1, 0, 0], (v - 0.456) / 0.224, atol=1e-5)
    assert np.allclose(pix[0, 2, 0, 0], (v - 0.406) / 0.225, atol=1e-5)


# --------------------------------------------------------------------------
# tensor serialisation — float16 b64 + shape, lossless round-trip
# --------------------------------------------------------------------------
def test_serialize_tensor_roundtrips_as_float16() -> None:
    arr = np.arange(24, dtype=np.float32).reshape(1, 2, 3, 4)

    t = serialize_tensor(arr)

    assert t["dtype"] == "float16"
    assert t["shape"] == [1, 2, 3, 4]
    raw = base64.b64decode(t["b64"])
    back = np.frombuffer(raw, dtype=np.float16).reshape(1, 2, 3, 4)
    assert np.array_equal(back, arr.astype(np.float16))


# --------------------------------------------------------------------------
# encoder registry + id resolution (Stage-0 verified constants)
# --------------------------------------------------------------------------
def test_encoder_specs_match_stage0_verified_constants() -> None:
    s3 = ENCODER_SPECS["sam3.1"]
    assert s3.input_size == 1008
    assert s3.mean == (0.5, 0.5, 0.5)
    assert s3.std == (0.5, 0.5, 0.5)
    assert "sam3-tracker" in s3.repo

    s2 = ENCODER_SPECS["sam2.1-large"]
    assert s2.input_size == 1024
    assert s2.mean == (0.485, 0.456, 0.406)
    assert s2.std == (0.229, 0.224, 0.225)
    assert "sam2.1-hiera-large" in s2.repo


def test_encoder_id_for_maps_only_proven_variants() -> None:
    assert encoder_id_for("sam3.1") == "sam3.1"
    assert encoder_id_for("sam2.1-large") == "sam2.1-large"
    # Variants without a proven ONNX bundle -> no client decode.
    assert encoder_id_for("sam2.1-tiny") is None
    assert encoder_id_for("sam2.1-small") is None
    assert encoder_id_for("sam2.1-base-plus") is None


# --------------------------------------------------------------------------
# build_encode_payload — registry metadata + encoder tensors
# --------------------------------------------------------------------------
def test_build_payload_none_when_no_encoder_available(monkeypatch) -> None:
    monkeypatch.delenv("SAM_CLIENT_ENCODE", raising=False)
    reset_test_encoder()
    assert build_encode_payload(np.zeros((4, 4, 3), np.uint8), "sam3.1") is None


def test_build_payload_none_for_unsupported_variant() -> None:
    set_test_encoder(_FakeEncoder())  # encoder available, but variant unsupported
    assert build_encode_payload(np.zeros((4, 4, 3), np.uint8), "sam2.1-tiny") is None


def test_build_payload_serializes_named_embeddings_with_spec_metadata() -> None:
    fake = _FakeEncoder()
    set_test_encoder(fake)

    payload = build_encode_payload(np.zeros((8, 8, 3), np.uint8), "sam3.1")

    assert payload is not None
    assert payload.encoder_id == "sam3.1"
    assert payload.input_size == 1008  # from the registry, not the encoder
    assert payload.mean == [0.5, 0.5, 0.5]
    assert payload.std == [0.5, 0.5, 0.5]
    assert set(payload.tensors) == {
        "image_embeddings.0", "image_embeddings.1", "image_embeddings.2",
    }
    assert payload.tensors["image_embeddings.0"]["shape"] == [1, 32, 4, 4]
    assert payload.tensors["image_embeddings.0"]["dtype"] == "float16"
    assert fake.calls == 1


def test_build_payload_none_when_encode_raises() -> None:
    set_test_encoder(_BoomEncoder())
    assert build_encode_payload(np.zeros((4, 4, 3), np.uint8), "sam3.1") is None


def test_build_payload_evicts_cached_session_on_encode_error(monkeypatch) -> None:
    # A resident ONNX session that starts failing (e.g. CUDA context error)
    # must be dropped from the cache so the next request re-loads it instead
    # of silently failing forever.
    monkeypatch.setenv("SAM_CLIENT_ENCODE", "1")
    reset_test_encoder()  # exercise the real cache path, not the injected seam
    onnx_mod._SESSIONS["sam3.1"] = _BoomEncoder()
    try:
        assert build_encode_payload(np.zeros((4, 4, 3), np.uint8), "sam3.1") is None
        assert "sam3.1" not in onnx_mod._SESSIONS
    finally:
        onnx_mod._SESSIONS.clear()


# --------------------------------------------------------------------------
# /sam/encode endpoint — extended response, /sam/decode untouched
# --------------------------------------------------------------------------
def test_encode_endpoint_includes_client_tensors(monkeypatch) -> None:
    monkeypatch.setenv("SAM_MODEL", "sam3.1")
    predictor_mod.set_test_predictor(_FakePredictor(np.zeros((4, 4), np.uint8)))
    set_test_encoder(_FakeEncoder())
    router_mod._reset_for_test()
    client = TestClient(create_app())

    r = client.post("/sam/encode", json={"image_b64": _png_b64(40, 30)})

    assert r.status_code == 200
    body = r.json()
    assert body["encoder_id"] == "sam3.1"
    assert body["input_size"] == 1008
    assert body["norm"] == {"mean": [0.5, 0.5, 0.5], "std": [0.5, 0.5, 0.5]}
    assert set(body["tensors"]) == {
        "image_embeddings.0", "image_embeddings.1", "image_embeddings.2",
    }
    t0 = body["tensors"]["image_embeddings.0"]
    assert t0["dtype"] == "float16"
    assert t0["shape"] == [1, 32, 4, 4]
    assert isinstance(t0["b64"], str) and t0["b64"]


def test_encode_endpoint_tensors_null_without_encoder(monkeypatch) -> None:
    monkeypatch.delenv("SAM_CLIENT_ENCODE", raising=False)
    predictor_mod.set_test_predictor(_FakePredictor(np.zeros((4, 4), np.uint8)))
    reset_test_encoder()
    router_mod._reset_for_test()
    client = TestClient(create_app())

    r = client.post("/sam/encode", json={"image_b64": _png_b64()})

    assert r.status_code == 200
    body = r.json()
    # Back-compat: structured fields absent -> browser falls back to server decode.
    assert body["tensors"] is None
    assert body["encoder_id"] is None
    assert body["input_size"] is None
    assert body["norm"] is None
    # Existing contract preserved.
    assert len(body["image_hash"]) == 32
    assert body["shape"] == [24, 32]


# --------------------------------------------------------------------------
# Two concurrent SAM 3.1 users, different images — the core scenario this
# whole project exists to fix. Stage 1 must hand each user the correct
# per-image embeddings with no cross-contamination, and never error/deadlock
# while loading SAM or encoding under concurrency.
# --------------------------------------------------------------------------
def _solid_png_b64(r: int, w: int = 48, h: int = 32) -> str:
    """A solid-colour PNG whose first-pixel red channel is ``r`` (a signature)."""
    img = Image.new("RGB", (w, h), color=(r, r // 2, r // 3))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


class _ImageSigEncoder:
    """Stateless, image-dependent fake: embeds the first pixel's red value into
    every tensor so a test can prove a user got *their own* image's encode and
    not the other user's (cross-contamination detector). Thread-safe — no
    shared mutable state, mirroring the real ONNX session contract."""

    def encode(self, img_rgb: np.ndarray) -> dict[str, np.ndarray]:
        sig = float(img_rgb[0, 0, 0])  # red channel of the top-left pixel
        return {
            "image_embeddings.0": np.full((1, 32, 4, 4), sig, np.float32),
            "image_embeddings.1": np.full((1, 64, 2, 2), sig, np.float32),
            "image_embeddings.2": np.full((1, 256, 1, 1), sig, np.float32),
        }


def test_two_users_concurrent_encode_different_images_no_contamination(monkeypatch) -> None:
    monkeypatch.setenv("SAM_MODEL", "sam3.1")
    predictor_mod.set_test_predictor(_FakePredictor(np.zeros((4, 4), np.uint8)))
    set_test_encoder(_ImageSigEncoder())
    router_mod._reset_for_test()

    # Two users, two distinct images (distinct first-pixel red signatures).
    img_a, sig_a = _solid_png_b64(11), 11.0
    img_b, sig_b = _solid_png_b64(222), 222.0

    errors: list[tuple[str, str]] = []
    hashes: dict[str, str] = {}
    start = threading.Barrier(2)

    def worker(name: str, img_b64: str, expected_sig: float) -> None:
        # Each user has their own client against the SAME shared app /
        # manager / admission gate (realistic two-user server).
        client = TestClient(create_app())
        try:
            start.wait(timeout=10)
            last_hash = None
            for _ in range(8):  # hammer to surface interleaving / clobber
                r = client.post("/sam/encode", json={"image_b64": img_b64})
                if r.status_code != 200:
                    errors.append((name, f"status {r.status_code}: {r.text}"))
                    return
                body = r.json()
                if body["encoder_id"] != "sam3.1":
                    errors.append((name, f"encoder_id={body['encoder_id']!r}"))
                    return
                raw = base64.b64decode(body["tensors"]["image_embeddings.0"]["b64"])
                val = float(np.frombuffer(raw, np.float16)[0])
                if val != expected_sig:  # got the OTHER user's encode
                    errors.append((name, f"tensor sig {val} != {expected_sig}"))
                    return
                last_hash = body["image_hash"]
            hashes[name] = last_hash  # type: ignore[assignment]
        except Exception as exc:  # noqa: BLE001
            errors.append((name, repr(exc)))

    ta = threading.Thread(target=worker, args=("A", img_a, sig_a))
    tb = threading.Thread(target=worker, args=("B", img_b, sig_b))
    ta.start(); tb.start()
    ta.join(timeout=30); tb.join(timeout=30)

    assert not ta.is_alive() and not tb.is_alive(), "encode deadlocked"
    assert not errors, errors
    # Each user got their own image's hash — no shared/swapped embedding.
    assert set(hashes) == {"A", "B"}
    assert hashes["A"] != hashes["B"]
