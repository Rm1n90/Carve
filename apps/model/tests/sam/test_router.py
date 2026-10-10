import base64
import io
from typing import Any

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from carve_model.main import create_app
from carve_model.sam import predictor as predictor_mod
from carve_model.sam import router as router_mod


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

    def predict(
        self, point_coords, point_labels, multimask_output=True, box=None,
        mask_input=None,
    ):
        # v3.8 Phase 2 -- record ``box`` so router tests can assert it
        # gets forwarded from /sam/decode without coupling the stub to
        # any particular tensor backend.
        # v3.22 -- ``mask_input`` is the SAM 2 iterative-refinement
        # signal (previous low-res logits). The fake records whether
        # one was passed so chain tests can assert it.
        pts_arr = np.asarray(point_coords)
        lbls_arr = np.asarray(point_labels)
        self.predict_calls.append({
            "points": pts_arr.tolist() if pts_arr.size else [],
            "labels": lbls_arr.tolist() if lbls_arr.size else [],
            "box": list(box) if box is not None else None,
            "had_mask_input": mask_input is not None,
            "multimask": multimask_output,
        })
        # Three candidate masks — the highest score should win
        masks = np.stack([
            np.zeros_like(self._mask),
            np.zeros_like(self._mask),
            self._mask,
        ])
        scores = np.array([0.1, 0.2, self._score])
        if not multimask_output:
            # Like SAM: a single mask when one is asked for.
            return masks[2:3], scores[2:3], None
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


# --- v3.8 Phase 2 — BBox mode: /sam/decode now accepts an optional box ----


def test_decode_box_only_forwards_box_to_predictor() -> None:
    """Box-only decode: no points, an xyxy box -> predictor receives box."""
    client, stub = _client_with_stub(
        np.array([[1, 1], [1, 0]], dtype=np.uint8), score=0.5
    )
    enc = client.post("/sam/encode", json={"image_b64": _png_b64()}).json()
    r = client.post("/sam/decode", json={
        "image_hash": enc["image_hash"],
        "points": [],
        "labels": [],
        "box": [10.0, 20.0, 50.0, 80.0],
    })
    assert r.status_code == 200
    assert stub.predict_calls[0]["points"] == []
    assert stub.predict_calls[0]["labels"] == []
    assert stub.predict_calls[0]["box"] == [10.0, 20.0, 50.0, 80.0]
    # A box is not ambiguous: one mask, not the best of three (which
    # regularly picked the biggest candidate, spilling past the box).
    assert stub.predict_calls[0]["multimask"] is False


def test_decode_single_click_still_asks_for_three_candidates() -> None:
    client, stub = _client_with_stub(np.array([[1, 1], [1, 0]], dtype=np.uint8), score=0.5)
    enc = client.post("/sam/encode", json={"image_b64": _png_b64()}).json()
    client.post("/sam/decode", json={"image_hash": enc["image_hash"], "points": [[5, 5]], "labels": [1]})
    assert stub.predict_calls[0]["multimask"] is True


def test_boxes_to_polygons_runs_every_box_in_one_call() -> None:
    mask = np.zeros((24, 32), dtype=np.uint8)
    mask[4:20, 6:26] = 1
    client, stub = _client_with_stub(mask, score=0.8)
    r = client.post("/sam/boxes-to-polygons", json={
        "image_b64": _png_b64(),
        "boxes": [[6, 4, 26, 20], [0, 0, 8, 8]],
        "zoom": False,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["results"]) == 2 and body["encodes"] == 1
    assert all(c["multimask"] is False for c in stub.predict_calls)
    first = body["results"][0]
    xs = [p[0] for p in first["polygon"]]; ys = [p[1] for p in first["polygon"]]
    assert min(xs) >= 4 and max(xs) <= 28 and min(ys) >= 2 and max(ys) <= 22
    # The image is left encoded under the hash /sam/encode gives it.
    enc = client.post("/sam/encode", json={"image_b64": _png_b64()}).json()
    assert enc["image_hash"] == body["image_hash"]


def test_boxes_to_polygons_returns_ground_as_a_mask() -> None:
    mask = np.zeros((24, 32), dtype=np.uint8)
    mask[2:6, 2:6] = 1
    client, _ = _client_with_stub(mask, score=0.8)
    r = client.post("/sam/boxes-to-polygons", json={
        "image_b64": _png_b64(), "boxes": [[2, 2, 6, 6], [0, 12, 32, 24]],
        "modes": ["object", "ground"], "zoom": False,
    })
    assert r.status_code == 200, r.text
    ground = r.json()["results"][1]
    assert ground["polygon"] == [] and ground["mask"]["size"] == [24, 32]
    runs = [int(v) for v in ground["mask"]["counts"].split(",")]
    assert sum(runs) == 24 * 32
    bad = client.post("/sam/boxes-to-polygons", json={"image_b64": _png_b64(), "boxes": [[0, 0, 4, 4]], "modes": ["ground", "crowd"]})
    assert bad.status_code == 422


def test_boxes_to_polygons_rejects_a_bad_box() -> None:
    client, _ = _client_with_stub(np.ones((24, 32), dtype=np.uint8))
    r = client.post("/sam/boxes-to-polygons", json={"image_b64": _png_b64(), "boxes": [[10, 10, 5, 20]]})
    assert r.status_code == 422


def test_decode_box_with_points_forwards_both() -> None:
    """BBox-then-refine: box plus refinement clicks both reach the predictor."""
    client, stub = _client_with_stub(
        np.array([[1, 1], [1, 0]], dtype=np.uint8), score=0.5
    )
    enc = client.post("/sam/encode", json={"image_b64": _png_b64()}).json()
    r = client.post("/sam/decode", json={
        "image_hash": enc["image_hash"],
        "points": [[15, 30], [40, 60]],
        "labels": [1, 0],
        "box": [10.0, 20.0, 50.0, 80.0],
    })
    assert r.status_code == 200
    assert stub.predict_calls[0]["points"] == [[15, 30], [40, 60]]
    assert stub.predict_calls[0]["labels"] == [1, 0]
    assert stub.predict_calls[0]["box"] == [10.0, 20.0, 50.0, 80.0]


def test_decode_without_points_or_box_returns_422() -> None:
    client, _ = _client_with_stub(np.zeros((4, 4), dtype=np.uint8))
    enc = client.post("/sam/encode", json={"image_b64": _png_b64()}).json()
    r = client.post("/sam/decode", json={
        "image_hash": enc["image_hash"],
        "points": [],
        "labels": [],
    })
    assert r.status_code == 422
    assert "at least one of points or box" in r.json()["detail"]


def test_decode_box_wrong_length_returns_422() -> None:
    client, _ = _client_with_stub(np.zeros((4, 4), dtype=np.uint8))
    enc = client.post("/sam/encode", json={"image_b64": _png_b64()}).json()
    r = client.post("/sam/decode", json={
        "image_hash": enc["image_hash"],
        "points": [],
        "labels": [],
        "box": [10.0, 20.0, 50.0],  # only 3 floats
    })
    assert r.status_code == 422
    assert "x1, y1, x2, y2" in r.json()["detail"]


def test_encode_bad_image_b64_returns_400() -> None:
    predictor_mod.set_test_predictor(_FakePredictor(np.zeros((4, 4), dtype=np.uint8)))
    try:
        client = TestClient(create_app())
        r = client.post("/sam/encode", json={"image_b64": "***NOT-BASE64!!!"})
        assert r.status_code == 400
    finally:
        predictor_mod.set_test_predictor(None)
