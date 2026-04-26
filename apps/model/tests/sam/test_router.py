import base64
import io
from typing import Any

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from vaa_model.main import create_app
from vaa_model.sam import predictor as predictor_mod
from vaa_model.sam import router as router_mod


def _png_b64(w: int = 32, h: int = 24) -> str:
    img = Image.new("RGB", (w, h), color=(10, 20, 30))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


class _FakePredictor:
    """Records set_image calls and returns canned masks."""

    def __init__(self, mask: np.ndarray, score: float = 0.91):
        self.set_image_calls: list[tuple[int, int, int]] = []
        self.predict_calls: list[dict] = []
        self._mask = mask
        self._score = score

    def set_image(self, image: Any) -> None:
        self.set_image_calls.append(tuple(image.shape))

    def predict(self, point_coords, point_labels, multimask_output=True):
        self.predict_calls.append({
            "points": np.asarray(point_coords).tolist(),
            "labels": np.asarray(point_labels).tolist(),
        })
        # Three candidate masks — the highest score should win
        masks = np.stack([
            np.zeros_like(self._mask),
            np.zeros_like(self._mask),
            self._mask,
        ])
        scores = np.array([0.1, 0.2, self._score])
        return masks, scores, None


def _client_with_stub(mask: np.ndarray, score: float = 0.91) -> tuple[TestClient, _FakePredictor]:
    stub = _FakePredictor(mask, score)
    predictor_mod.set_test_predictor(stub)
    router_mod._reset_for_test()
    return TestClient(create_app()), stub


def teardown_function(_):  # pytest module-level teardown
    predictor_mod.set_test_predictor(None)
    router_mod._reset_for_test()


def test_capabilities_includes_sam() -> None:
    predictor_mod.set_test_predictor(_FakePredictor(np.zeros((4, 4), dtype=np.uint8)))
    try:
        client = TestClient(create_app())
        body = client.get("/capabilities").json()
        assert "sam" in body["models"]
    finally:
        predictor_mod.set_test_predictor(None)


def test_encode_returns_image_hash_and_shape() -> None:
    client, stub = _client_with_stub(np.zeros((4, 4), dtype=np.uint8))
    r = client.post("/sam/encode", json={"image_b64": _png_b64(64, 48)})
    assert r.status_code == 200
    body = r.json()
    assert len(body["image_hash"]) == 32  # xxh3-128 hex
    assert body["shape"] == [48, 64]  # PIL gives (h, w)
    assert len(stub.set_image_calls) == 1


def test_encode_returns_null_embedding_when_predictor_has_no_features() -> None:
    """The test fake doesn't expose ``_features``; the response should still
    succeed but with ``embedding_b64: None`` so callers fall back to
    server-side decode."""
    client, _ = _client_with_stub(np.zeros((4, 4), dtype=np.uint8))
    r = client.post("/sam/encode", json={"image_b64": _png_b64()})
    assert r.status_code == 200
    body = r.json()
    assert "embedding_b64" in body
    assert body["embedding_b64"] is None


def test_encode_returns_embedding_when_predictor_exposes_features() -> None:
    """When the predictor exposes ``_features['image_embed']``, encode should
    return a base64-encoded copy of the float16 bytes for the browser-side
    ONNX decoder."""
    import base64 as _b64

    canned_bytes = b"\x01\x02\x03\x04\x05\x06\x07\x08"

    class _FakeTensor:
        def detach(self) -> "_FakeTensor":
            return self

        def to(self, *_args, **_kwargs) -> "_FakeTensor":
            return self

        def numpy(self):
            class _Arr:
                def tobytes(self_inner) -> bytes:
                    return canned_bytes

            return _Arr()

    class _PredictorWithFeatures(_FakePredictor):
        def __init__(self) -> None:
            super().__init__(np.zeros((2, 2), dtype=np.uint8))
            self._features = {"image_embed": _FakeTensor()}

    stub = _PredictorWithFeatures()
    predictor_mod.set_test_predictor(stub)
    router_mod._reset_for_test()
    client = TestClient(create_app())
    r = client.post("/sam/encode", json={"image_b64": _png_b64()})
    assert r.status_code == 200
    body = r.json()
    assert body["embedding_b64"] is not None
    assert _b64.b64decode(body["embedding_b64"]) == canned_bytes


def test_decode_returns_rle_for_best_mask() -> None:
    mask = np.array([[1, 1], [1, 0]], dtype=np.uint8)
    client, stub = _client_with_stub(mask, score=0.77)
    enc = client.post("/sam/encode", json={"image_b64": _png_b64()}).json()
    r = client.post("/sam/decode", json={
        "image_hash": enc["image_hash"],
        "points": [[10, 10], [20, 20]],
        "labels": [1, 0],
    })
    assert r.status_code == 200
    body = r.json()
    assert body["score"] == 0.77
    # The mask is 2x2; size matches; counts is non-empty
    assert body["size"] == [2, 2]
    assert isinstance(body["counts"], str) and body["counts"]
    # Predictor was called with the correct points + labels
    assert stub.predict_calls[0]["points"] == [[10, 10], [20, 20]]
    assert stub.predict_calls[0]["labels"] == [1, 0]


def test_decode_without_encode_returns_409() -> None:
    client, _ = _client_with_stub(np.zeros((4, 4), dtype=np.uint8))
    r = client.post("/sam/decode", json={
        "image_hash": "deadbeef" * 4,
        "points": [[1, 2]],
        "labels": [1],
    })
    assert r.status_code == 409
    assert "embedding_not_loaded" in r.json()["detail"]


def test_decode_stale_hash_returns_409() -> None:
    client, _ = _client_with_stub(np.zeros((4, 4), dtype=np.uint8))
    enc = client.post("/sam/encode", json={"image_b64": _png_b64()}).json()
    bogus = "0" * 32
    assert bogus != enc["image_hash"]
    r = client.post("/sam/decode", json={
        "image_hash": bogus,
        "points": [[1, 2]],
        "labels": [1],
    })
    assert r.status_code == 409


def test_decode_mismatched_lengths_returns_422() -> None:
    client, _ = _client_with_stub(np.zeros((4, 4), dtype=np.uint8))
    enc = client.post("/sam/encode", json={"image_b64": _png_b64()}).json()
    r = client.post("/sam/decode", json={
        "image_hash": enc["image_hash"],
        "points": [[1, 2], [3, 4]],
        "labels": [1],
    })
    assert r.status_code == 422


def test_encode_bad_image_b64_returns_400() -> None:
    predictor_mod.set_test_predictor(_FakePredictor(np.zeros((4, 4), dtype=np.uint8)))
    try:
        client = TestClient(create_app())
        r = client.post("/sam/encode", json={"image_b64": "***NOT-BASE64!!!"})
        assert r.status_code == 400
    finally:
        predictor_mod.set_test_predictor(None)
