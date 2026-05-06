"""Unit tests for ``carve_model.yoloe.predict``.

We use lightweight stub objects in place of an Ultralytics ``YOLOE``
instance so the suite runs on a dev box with no .pt file or torch
installed. The shaping logic is the contract the api service relies
on; if these break, downstream class-mapping breaks.
"""

from __future__ import annotations

import io
from typing import Any

import numpy as np
import pytest
from PIL import Image

from carve_model.yoloe import predict as predict_mod


def _png_bytes(w: int = 16, h: int = 16) -> bytes:
    img = Image.new("RGB", (w, h), color=(127, 200, 50))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class _FakeBoxes:
    def __init__(
        self,
        xyxy: list[list[float]],
        conf: list[float],
        cls: list[int],
    ) -> None:
        self.xyxy = np.asarray(xyxy)
        self.conf = np.asarray(conf)
        self.cls = np.asarray(cls)


class _FakeMasks:
    def __init__(self, xy: list[list[list[float]]]) -> None:
        self.xy = [np.asarray(p) for p in xy]


class _FakeResults:
    def __init__(
        self,
        *,
        boxes: _FakeBoxes,
        masks: _FakeMasks | None,
        names: dict[int, str] | list[str],
    ) -> None:
        self.boxes = boxes
        self.masks = masks
        self.names = names


class _FakeYoloeText:
    """Stub that mimics the text-prompt subset of the YOLOE API."""

    def __init__(self, results: _FakeResults) -> None:
        self._results = results
        self.last_classes: list[str] | None = None
        self.last_kwargs: dict[str, Any] | None = None

    def set_classes(self, classes: list[str]) -> None:
        self.last_classes = list(classes)

    def predict(self, _img: Any, **kwargs: Any) -> list[_FakeResults]:
        self.last_kwargs = kwargs
        return [self._results]


class _FakeYoloePF:
    """Stub for prompt-free / generic predict."""

    def __init__(self, results: _FakeResults) -> None:
        self._results = results
        self.last_kwargs: dict[str, Any] | None = None

    def predict(self, _img: Any, **kwargs: Any) -> list[_FakeResults]:
        self.last_kwargs = kwargs
        return [self._results]


def _build_results(*, with_masks: bool) -> _FakeResults:
    boxes = _FakeBoxes(
        xyxy=[[10.0, 20.0, 30.0, 60.0]],
        conf=[0.91],
        cls=[0],
    )
    masks = (
        _FakeMasks(xy=[[[10.0, 20.0], [30.0, 20.0], [30.0, 60.0]]])
        if with_masks
        else None
    )
    return _FakeResults(boxes=boxes, masks=masks, names={0: "person"})


# ---------- predict_text ----------


def test_predict_text_shapes_detections_and_polygons() -> None:
    results = _build_results(with_masks=True)
    fake = _FakeYoloeText(results)
    out = predict_mod.predict_text(
        fake, _png_bytes(), ["person", "  bus  "], conf=0.3, iou=0.5,
    )

    # set_classes received the trimmed list
    assert fake.last_classes == ["person", "bus"]
    # predict received conf/iou
    assert fake.last_kwargs is not None
    assert fake.last_kwargs["conf"] == 0.3
    assert fake.last_kwargs["iou"] == 0.5

    assert out["detections"] == [
        {
            "class_name": "person",
            "confidence": pytest.approx(0.91),
            "bbox": {"x": 10.0, "y": 20.0, "w": 20.0, "h": 40.0},
        }
    ]
    assert out["polygons"] == [
        {
            "class_name": "person",
            "confidence": pytest.approx(0.91),
            "points": [[10.0, 20.0], [30.0, 20.0], [30.0, 60.0]],
        }
    ]


def test_predict_text_rejects_empty_classes() -> None:
    fake = _FakeYoloeText(_build_results(with_masks=False))
    with pytest.raises(ValueError, match="classes_empty"):
        predict_mod.predict_text(fake, _png_bytes(), ["", "   "])


def test_predict_text_no_masks_returns_empty_polygons() -> None:
    fake = _FakeYoloeText(_build_results(with_masks=False))
    out = predict_mod.predict_text(fake, _png_bytes(), ["person"])
    assert out["polygons"] == []
    assert len(out["detections"]) == 1


# ---------- predict_prompt_free ----------


def test_predict_prompt_free_passes_max_det() -> None:
    fake = _FakeYoloePF(_build_results(with_masks=True))
    predict_mod.predict_prompt_free(fake, _png_bytes(), max_detections=42)
    assert fake.last_kwargs is not None
    assert fake.last_kwargs["max_det"] == 42


def test_predict_prompt_free_omits_max_det_when_none() -> None:
    fake = _FakeYoloePF(_build_results(with_masks=True))
    predict_mod.predict_prompt_free(fake, _png_bytes())
    assert fake.last_kwargs is not None
    assert "max_det" not in fake.last_kwargs


# ---------- predict_visual ----------


def test_predict_visual_validates_lengths() -> None:
    fake = _FakeYoloePF(_build_results(with_masks=True))
    # No bboxes -> empty
    with pytest.raises(ValueError, match="bboxes_empty"):
        predict_mod.predict_visual(
            fake, _png_bytes(), _png_bytes(),
            bboxes=[], cls_indices=[], class_names=[],
        )
    # Mismatched lengths
    with pytest.raises(ValueError, match="bboxes_cls_length_mismatch"):
        predict_mod.predict_visual(
            fake, _png_bytes(), _png_bytes(),
            bboxes=[[0.0, 0.0, 10.0, 10.0]],
            cls_indices=[0, 1],
            class_names=[],
        )


def test_predict_visual_injects_class_names(monkeypatch: pytest.MonkeyPatch) -> None:
    """class_names supplied by the caller override the model's int indices."""
    indexed = _FakeResults(
        boxes=_FakeBoxes(xyxy=[[1.0, 2.0, 3.0, 4.0]], conf=[0.5], cls=[0]),
        masks=None,
        names={0: "0"},
    )
    fake = _FakeYoloePF(indexed)

    # Avoid the real ultralytics import in predict_visual by stubbing the
    # ``YOLOEVPSegPredictor`` symbol the function imports lazily.
    import sys
    import types

    fake_mod = types.ModuleType("ultralytics.models.yolo.yoloe")
    fake_mod.YOLOEVPSegPredictor = object  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "ultralytics", types.ModuleType("ultralytics"))
    monkeypatch.setitem(sys.modules, "ultralytics.models", types.ModuleType("ultralytics.models"))
    monkeypatch.setitem(
        sys.modules, "ultralytics.models.yolo", types.ModuleType("ultralytics.models.yolo"),
    )
    monkeypatch.setitem(sys.modules, "ultralytics.models.yolo.yoloe", fake_mod)

    out = predict_mod.predict_visual(
        fake,
        _png_bytes(),
        _png_bytes(),
        bboxes=[[0.0, 0.0, 10.0, 10.0]],
        cls_indices=[0],
        class_names=["Cat"],
    )
    assert out["detections"][0]["class_name"] == "Cat"
