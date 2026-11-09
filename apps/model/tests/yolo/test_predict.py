"""Test predict_image with a fake YOLO-like model.

We don't import Ultralytics. Instead we construct a stub Results object that
quacks like the real thing.
"""
import io

import numpy as np
from PIL import Image

from carve_model.yolo.predict import predict_image


class _FakeBoxes:
    def __init__(self, xyxy, conf, cls):
        self.xyxy = np.array(xyxy)
        self.conf = np.array(conf)
        self.cls = np.array(cls)


class _FakeMasks:
    def __init__(self, xy):
        self.xy = xy


class _FakeResults:
    def __init__(self, boxes=None, masks=None, names=None):
        self.boxes = boxes
        self.masks = masks
        self.names = names or {}


class _FakeModel:
    def __init__(self, results: _FakeResults):
        self._results = results
        self.last_call: dict = {}

    def predict(self, img, conf=0.25, iou=0.7, half=True, verbose=False):
        self.last_call = {
            "shape": img.shape,
            "conf": conf,
            "iou": iou,
            "half": half,
        }
        return [self._results]


def _png_bytes(w: int = 64, h: int = 48) -> bytes:
    img = Image.new("RGB", (w, h), color=(10, 20, 30))
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def test_predict_feeds_bgr_to_ultralytics() -> None:
    """Ultralytics treats ndarray inputs as BGR (BasePredictor.preprocess runs
    ``im[..., ::-1]`` BGR->RGB). predict_image must hand it BGR so the model
    perceives the true RGB image. Passing RGB swaps R/B and corrupts
    detections — the cause of wrong/missing classes vs a cv2/file-path script.
    """
    captured: dict = {}

    class _CapModel:
        def predict(self, img, **kw):
            captured["px"] = np.array(img)[0, 0].tolist()
            return [_FakeResults(names={})]

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (255, 0, 0)).save(buf, format="PNG")  # pure red (RGB)
    predict_image(_CapModel(), buf.getvalue())
    # Pure red in RGB must reach the model as BGR (0, 0, 255).
    assert captured["px"] == [0, 0, 255], captured["px"]


def test_predict_returns_detections_and_polygons() -> None:
    boxes = _FakeBoxes(
        xyxy=[[10, 12, 30, 32], [40, 42, 60, 62]],
        conf=[0.9, 0.8],
        cls=[0, 1],
    )
    masks = _FakeMasks(xy=[
        np.array([[10, 10], [20, 10], [20, 20], [10, 20]]),
        np.array([[40, 40], [50, 40], [50, 50], [40, 50]]),
    ])
    results = _FakeResults(boxes=boxes, masks=masks, names={0: "car", 1: "bike"})
    model = _FakeModel(results)
    out = predict_image(model, _png_bytes(), conf=0.3, iou=0.6)
    assert len(out["detections"]) == 2
    assert out["detections"][0]["class_name"] == "car"
    assert out["detections"][0]["bbox"] == {"x": 10.0, "y": 12.0, "w": 20.0, "h": 20.0}
    assert out["detections"][0]["confidence"] == 0.9
    assert len(out["polygons"]) == 2
    assert out["polygons"][1]["class_name"] == "bike"
    assert model.last_call["conf"] == 0.3 and model.last_call["iou"] == 0.6
    # v3.7.5 — half defaults to True so callers get FP16 on CUDA without
    # opting in. Ultralytics auto-falls-back to FP32 on CPU.
    assert model.last_call["half"] is True


def test_predict_threads_half_through() -> None:
    """v3.7.5 — explicit ``half=False`` must reach the underlying model."""
    boxes = _FakeBoxes(xyxy=[[1, 2, 3, 4]], conf=[0.5], cls=[0])
    results = _FakeResults(boxes=boxes, masks=None, names={0: "x"})
    model = _FakeModel(results)
    predict_image(model, _png_bytes(), half=False)
    assert model.last_call["half"] is False


def test_predict_no_masks_returns_empty_polygons() -> None:
    boxes = _FakeBoxes(xyxy=[[1, 2, 3, 4]], conf=[0.5], cls=[0])
    results = _FakeResults(boxes=boxes, masks=None, names={0: "x"})
    out = predict_image(_FakeModel(results), _png_bytes())
    assert len(out["detections"]) == 1
    assert out["polygons"] == []


def test_predict_no_boxes_returns_empty() -> None:
    results = _FakeResults(boxes=None, masks=None, names={})
    out = predict_image(_FakeModel(results), _png_bytes())
    assert out == {"detections": [], "polygons": [], "masks": []}


def test_predict_handles_torch_tensor_like_attrs() -> None:
    """Real Ultralytics returns torch tensors; our _to_numpy must call .cpu().numpy()."""

    class _Tensor:
        def __init__(self, data):
            self._data = np.array(data)

        def cpu(self):
            return self  # already on CPU in the stub

        def numpy(self):
            return self._data

    boxes = type("B", (), {})()
    boxes.xyxy = _Tensor([[1, 2, 3, 4]])
    boxes.conf = _Tensor([0.7])
    boxes.cls = _Tensor([0])
    results = _FakeResults(boxes=boxes, names={0: "thing"})
    out = predict_image(_FakeModel(results), _png_bytes())
    assert out["detections"][0]["class_name"] == "thing"
    assert out["detections"][0]["confidence"] == 0.7


class _FakeDataMasks:
    """Masks as Ultralytics gives them: ``data`` at the letterboxed input size."""

    def __init__(self, data):
        self.data = np.array(data, dtype=np.float32)


def _decode(counts: str, size: list[int]) -> np.ndarray:
    h, w = size
    runs = [int(r) for r in counts.split(",")]
    flat = np.zeros(h * w, np.uint8)
    pos = 0
    for j, r in enumerate(runs):
        if j % 2:
            flat[pos:pos + r] = 1
        pos += r
    return flat.reshape(w, h).T


def _seg(masks: list[np.ndarray], w: int = 64, h: int = 48) -> dict:
    n = len(masks)
    boxes = _FakeBoxes(xyxy=[[0, 0, w, h]] * n, conf=[0.9] * n, cls=[0] * n)
    results = _FakeResults(boxes=boxes, masks=_FakeDataMasks(masks), names={0: "board"})
    return predict_image(_FakeModel(results), _png_bytes(w, h))


def test_one_piece_mask_is_a_polygon_tagged_with_its_detection() -> None:
    m = np.zeros((48, 64))
    m[10:20, 30:50] = 1
    out = _seg([m])
    assert out["masks"] == []
    (poly,) = out["polygons"]
    assert poly["det"] == 0 and poly["class_name"] == "board"
    pts = np.array(poly["points"])
    assert pts[:, 0].min() == 30 and pts[:, 0].max() == 49
    assert pts[:, 1].min() == 10 and pts[:, 1].max() == 19


def test_polygon_undoes_the_letterbox() -> None:
    """A 64x48 image runs as a 64x64 input with 8 rows of padding on top."""
    m = np.zeros((64, 64))
    m[18:28, 30:50] = 1
    (poly,) = _seg([m])["polygons"]
    pts = np.array(poly["points"])
    assert pts[:, 1].min() == 10 and pts[:, 1].max() == 19


def test_two_pieces_become_one_pixel_mask_without_bridges() -> None:
    m = np.zeros((48, 64))
    m[5:15, 5:20] = 1
    m[30:45, 40:60] = 1
    out = _seg([m])
    assert out["polygons"] == []
    (mask,) = out["masks"]
    assert mask["det"] == 0 and mask["size"] == [48, 64]
    got = _decode(mask["counts"], mask["size"])
    assert (got == m).all()


def test_specks_dropped_and_tiny_holes_filled() -> None:
    m = np.zeros((48, 64))
    m[5:45, 5:45] = 1
    m[20, 20] = 0          # a one-pixel hole: noise
    m[2, 60] = 1           # a one-pixel speck far away
    out = _seg([m])
    assert out["masks"] == []
    pts = np.array(out["polygons"][0]["points"])
    assert pts[:, 0].max() == 44


def test_a_real_hole_keeps_the_pixel_mask() -> None:
    m = np.zeros((48, 64))
    m[5:45, 5:60] = 1
    m[15:35, 20:40] = 0    # a player standing on the pitch
    (mask,) = _seg([m])["masks"]
    assert (_decode(mask["counts"], mask["size"]) == m).all()

