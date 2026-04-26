import uuid
from typing import Any

import pytest

from carve_api.annotations.models import AnnotationKind
from carve_api.io.yolo_out import RemapTarget, write_data_yaml, write_yolo_label


class _FakeAnnotation:
    """Duck type matching the bits of Annotation that yolo_out reads."""
    def __init__(self, *, kind: AnnotationKind, geometry: dict, class_id: Any):
        self.kind = kind
        self.geometry = geometry
        self.class_id = class_id


def _car_id() -> uuid.UUID:
    return uuid.UUID("00000000-0000-0000-0000-000000000001")


def _truck_id() -> uuid.UUID:
    return uuid.UUID("00000000-0000-0000-0000-000000000002")


def _remap_car_only_truck_skip() -> dict:
    return {
        str(_car_id()): {"export_id": 0, "name": "vehicle"},
        str(_truck_id()): None,
    }


def test_bbox_normalised_correctly() -> None:
    ann = _FakeAnnotation(
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 50, "y": 50, "w": 100, "h": 80},
        class_id=_car_id(),
    )
    lines, warnings = write_yolo_label(
        [ann], remap=_remap_car_only_truck_skip(), image_w=640, image_h=480,
    )
    # cx = (50+50)/640 = 0.156250; cy = (50+40)/480 = 0.187500
    # w = 100/640 = 0.156250; h = 80/480 = 0.166667
    assert lines == ["0 0.156250 0.187500 0.156250 0.166667"]
    assert warnings == []


def test_skipped_class_produces_no_line() -> None:
    truck = _FakeAnnotation(
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 1, "y": 1, "w": 2, "h": 2},
        class_id=_truck_id(),
    )
    lines, warnings = write_yolo_label(
        [truck], remap=_remap_car_only_truck_skip(), image_w=10, image_h=10,
    )
    assert lines == []
    assert warnings == []


def test_unmapped_class_produces_no_line_and_no_warning() -> None:
    """When the remap doesn't mention a class, the row is dropped silently.

    (Warning is for shapes the format can't represent — like masks — not
    for classes the user didn't include in the remap.)
    """
    other = uuid.UUID("00000000-0000-0000-0000-000000000099")
    ann = _FakeAnnotation(
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 1, "y": 1, "w": 2, "h": 2},
        class_id=other,
    )
    lines, warnings = write_yolo_label(
        [ann], remap=_remap_car_only_truck_skip(), image_w=10, image_h=10,
    )
    assert lines == []
    assert warnings == []


def test_polygon_normalised() -> None:
    ann = _FakeAnnotation(
        kind=AnnotationKind.polygon,
        geometry={"kind": "polygon", "points": [[0, 0], [10, 0], [10, 10]]},
        class_id=_car_id(),
    )
    lines, _ = write_yolo_label(
        [ann], remap=_remap_car_only_truck_skip(), image_w=10, image_h=10,
    )
    assert lines == ["0 0.000000 0.000000 1.000000 0.000000 1.000000 1.000000"]


def test_mask_emits_warning_and_no_line() -> None:
    ann = _FakeAnnotation(
        kind=AnnotationKind.mask,
        geometry={"kind": "mask_rle", "size": [10, 10], "counts": "0,2,2"},
        class_id=_car_id(),
    )
    lines, warnings = write_yolo_label(
        [ann], remap=_remap_car_only_truck_skip(), image_w=10, image_h=10,
    )
    assert lines == []
    assert any("mask" in w for w in warnings)


def test_tag_emits_class_index_only_once_per_image() -> None:
    ann1 = _FakeAnnotation(kind=AnnotationKind.tag, geometry={}, class_id=_car_id())
    ann2 = _FakeAnnotation(kind=AnnotationKind.tag, geometry={}, class_id=_car_id())
    lines, warnings = write_yolo_label(
        [ann1, ann2], remap=_remap_car_only_truck_skip(), image_w=1, image_h=1,
    )
    assert lines == ["0"]
    assert any("first tag" in w for w in warnings)


def test_invalid_image_dimensions_raise() -> None:
    with pytest.raises(ValueError):
        write_yolo_label([], remap={}, image_w=0, image_h=10)


def test_invalid_remap_entry_raises() -> None:
    with pytest.raises(ValueError):
        write_yolo_label([], remap={"x": {"export_id": 0}}, image_w=10, image_h=10)


def test_data_yaml_contains_class_names_and_counts() -> None:
    yaml = write_data_yaml(
        targets=[
            RemapTarget(export_id=0, name="vehicle"),
            RemapTarget(export_id=0, name="vehicle"),  # duplicate id deduped
            RemapTarget(export_id=1, name="person"),
        ],
    )
    assert "nc: 2" in yaml
    assert '"vehicle"' in yaml
    assert '"person"' in yaml
    assert "train: images/train" in yaml


def test_data_yaml_custom_splits() -> None:
    yaml = write_data_yaml(
        targets=[RemapTarget(export_id=0, name="x")],
        splits={"train": "splits/t", "val": "splits/v", "test": "splits/test"},
    )
    assert "train: splits/t" in yaml
    assert "val: splits/v" in yaml
