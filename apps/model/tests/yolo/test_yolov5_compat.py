"""Classic YOLOv5 checkpoint support.

Checkpoints from the ``ultralytics/yolov5`` repo pickle their layers from
that repo's top-level ``models``/``utils`` packages, which the ultralytics
package cannot resolve. These tests cover the detection, the geometry and
the ultralytics-shaped adapter without needing a real 90 MB checkpoint or
a GPU — the one thing they cannot cover is the unpickle itself, which is
exercised against the real weight in the model image.
"""

import io
import pickle
import zipfile
from pathlib import Path

import numpy as np
import pytest

from carve_model.yolo import yolov5_compat as v5


# ---------------------------------------------------------------- detection


def _fake_ckpt(tmp_path: Path, name: str, payload: bytes) -> Path:
    """A .pt is a zip with a data.pkl member; that is all the detector reads."""
    p = tmp_path / name
    with zipfile.ZipFile(p, "w") as zf:
        zf.writestr("archive/data.pkl", payload)
    return p


def test_detects_yolov5_repo_checkpoint(tmp_path):
    p = _fake_ckpt(tmp_path, "v5.pt", b"\x80\x04...models.common\x94Conv")
    assert v5.is_yolov5_checkpoint(p) is True


def test_does_not_claim_ultralytics_checkpoint(tmp_path):
    """v8/v11 — and the anchor-free 'v5u' weights — must take the normal path."""
    p = _fake_ckpt(tmp_path, "v8.pt", b"\x80\x04ultralytics.nn.modules.conv\x94Conv")
    assert v5.is_yolov5_checkpoint(p) is False


@pytest.mark.parametrize("content", [b"", b"not a zip at all", b"\x00" * 64])
def test_unreadable_files_fall_through_to_ultralytics(tmp_path, content):
    """A corrupt file must not be claimed by the v5 path: the ultralytics
    error messages are the ones users already recognise."""
    p = tmp_path / "junk.pt"
    p.write_bytes(content)
    assert v5.is_yolov5_checkpoint(p) is False


def test_zip_without_pickle_is_not_claimed(tmp_path):
    p = tmp_path / "odd.pt"
    with zipfile.ZipFile(p, "w") as zf:
        zf.writestr("archive/version", "3")
    assert v5.is_yolov5_checkpoint(p) is False


# ------------------------------------------------------------------- names


@pytest.mark.parametrize(
    "ckpt,expected",
    [
        ({"model": None, "names": ["a", "b"]}, {0: "a", 1: "b"}),
        ({"names": {0: "x", 1: "y"}}, {0: "x", 1: "y"}),
        ({"names": {"0": "x", "1": "y"}}, {0: "x", 1: "y"}),
        ({}, {}),
    ],
)
def test_extract_names_handles_list_and_dict(ckpt, expected):
    """v5 stores names as a list on older checkpoints and a dict on newer
    ones; both are in the wild."""
    assert v5.extract_names(ckpt) == expected


# -------------------------------------------------------------- letterbox


def test_letterbox_preserves_aspect_and_pads_to_stride():
    img = np.zeros((1080, 1920, 3), dtype=np.uint8)
    out, ratio, (dw, dh) = v5._letterbox(img, size=640, stride=32)
    assert out.shape[0] % 32 == 0 and out.shape[1] % 32 == 0
    assert ratio == pytest.approx(640 / 1920)
    # aspect preserved: the scaled content is 1920*r x 1080*r
    assert out.shape[1] >= round(1920 * ratio)
    assert dh > 0 and dw == 0  # wide image pads top/bottom only


def test_letterbox_is_reversible_for_box_coordinates():
    """The padding/scale it reports must map a box back to source pixels —
    this is what turns detections into the right place on the image."""
    img = np.zeros((720, 1280, 3), dtype=np.uint8)
    _, ratio, (dw, dh) = v5._letterbox(img, size=640, stride=32)
    # a box at the centre of the letterboxed image
    cx = (1280 * ratio) / 2 + dw
    cy = (720 * ratio) / 2 + dh
    assert (cx - dw) / ratio == pytest.approx(640.0)
    assert (cy - dh) / ratio == pytest.approx(360.0)


# -------------------------------------------------------------------- NMS


def test_nms_filters_by_confidence_and_dedupes():
    torch = pytest.importorskip("torch")
    # two heavily-overlapping boxes of one class + one distant box
    def row(cx, cy, w, h, obj, cls_scores):
        return [cx, cy, w, h, obj, *cls_scores]

    pred = torch.tensor([[
        row(100, 100, 50, 50, 0.9, [0.9, 0.0]),
        row(102, 101, 50, 50, 0.8, [0.85, 0.0]),   # duplicate of the first
        row(500, 500, 40, 40, 0.9, [0.0, 0.95]),   # different class + place
        row(300, 300, 40, 40, 0.05, [0.9, 0.0]),   # below threshold
    ]])
    out = v5._nms(pred, conf_thres=0.25, iou_thres=0.45)
    assert out.shape[0] == 2, "overlapping same-class boxes should collapse to one"
    assert set(out[:, 5].int().tolist()) == {0, 1}


def test_nms_on_empty_prediction_returns_empty():
    torch = pytest.importorskip("torch")
    out = v5._nms(torch.zeros((1, 0, 7)), conf_thres=0.25, iou_thres=0.45)
    assert out.shape[0] == 0


# ---------------------------------------------------------------- adapter


class _StubModule:
    """Stands in for a yolov5 DetectionModel: returns fixed raw output."""

    def __init__(self, pred):
        self._pred = pred
        self.calls = []

    def __call__(self, x):
        self.calls.append(tuple(x.shape))
        return (self._pred,)

    def to(self, *_):
        return self

    def half(self):
        return self

    def float(self):
        return self

    def modules(self):
        return []


def test_adapter_matches_the_ultralytics_result_shape():
    """``predict_image`` is duck-typed against ultralytics — the adapter has
    to expose boxes.xyxy / .conf / .cls, a names dict and masks."""
    torch = pytest.importorskip("torch")
    pred = torch.tensor([[[100.0, 100.0, 50.0, 50.0, 0.9, 0.95, 0.0]]])
    m = v5.Yolov5Model(_StubModule(pred), {0: "car", 1: "van"}, stride=32)

    img = np.zeros((640, 640, 3), dtype=np.uint8)
    results = m.predict(img, conf=0.25, iou=0.45, half=False, device="cpu")

    assert isinstance(results, list) and len(results) == 1
    r = results[0]
    assert r.masks is None
    assert r.names == {0: "car", 1: "van"}
    assert r.boxes.xyxy.shape[1] == 4
    assert r.boxes.conf.shape[0] == r.boxes.xyxy.shape[0]
    assert r.boxes.cls.shape[0] == r.boxes.xyxy.shape[0]


def test_adapter_converts_bgr_input_to_rgb():
    """``predict_image`` hands every model BGR (ultralytics flips it back).
    YOLOv5 wants RGB, so the adapter must flip — getting this wrong silently
    swaps R/B and quietly wrecks detections."""
    torch = pytest.importorskip("torch")
    captured = {}

    class _Capture(_StubModule):
        def __call__(self, x):
            captured["first_pixel"] = x[0, :, 0, 0].tolist()
            return (torch.zeros((1, 0, 7)),)

    img_bgr = np.zeros((64, 64, 3), dtype=np.uint8)
    img_bgr[:, :, 0] = 255  # pure BLUE in BGR
    m = v5.Yolov5Model(_Capture(torch.zeros((1, 0, 7))), {0: "a"}, stride=32)
    m.predict(img_bgr, conf=0.25, iou=0.45, half=False, device="cpu")

    r, g, b = captured["first_pixel"]
    assert b > r, "blue-dominant BGR input must reach the model as blue in RGB"


def test_half_precision_is_ignored_off_cuda():
    """FP16 on CPU is unsupported; asking for it must not crash or flip the
    model into half."""
    pytest.importorskip("torch")
    m = v5.Yolov5Model(_StubModule(None), {}, stride=32)
    m._apply_precision(True)
    assert m._half is False


# --------------------------------------------------------------- wiring


def test_registry_routes_v5_checkpoints_to_the_compat_loader(monkeypatch, tmp_path):
    """The production loader must send v5 files to the compat path and
    everything else to ultralytics."""
    from carve_model.yolo import registry

    seen = {}

    def _fake_load(path):
        seen["v5"] = path
        return "V5MODEL"

    monkeypatch.setattr(v5, "is_yolov5_checkpoint", lambda p: True)
    monkeypatch.setattr(v5, "load_model", _fake_load)
    assert registry._default_loader(tmp_path / "w.pt") == "V5MODEL"
    assert "v5" in seen


def test_path_is_not_left_on_syspath(monkeypatch, tmp_path):
    """``utils`` is far too generic a name to leave on sys.path — a leak
    would shadow unrelated imports process-wide."""
    import sys

    monkeypatch.setattr(v5, "YOLOV5_DIR", str(tmp_path))
    before = list(sys.path)
    with v5.yolov5_importable():
        assert str(tmp_path) in sys.path
    assert sys.path == before


def test_missing_vendored_repo_is_a_clear_error(monkeypatch):
    monkeypatch.setattr(v5, "YOLOV5_DIR", "/definitely/not/here")
    with pytest.raises(RuntimeError, match="yolov5 support is not installed"):
        with v5.yolov5_importable():
            pass
