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


def test_mask_emits_bbox_line_and_lossy_warning() -> None:
    """Mask path in the writer emits a 5-token bbox line (detection mode).
    The segmentation-mode mask→polygon conversion happens in the export
    job before the writer is called."""
    # 2x2 foreground block at top-left of a 10x10 image; column-major
    # RLE: 0 zeros, 2 ones, 8 zeros, 2 ones, 86 zeros.
    ann = _FakeAnnotation(
        kind=AnnotationKind.mask,
        geometry={"kind": "mask_rle", "size": [10, 10], "counts": "0 2 8 2 86"},
        class_id=_car_id(),
    )
    lines, warnings = write_yolo_label(
        [ann], remap=_remap_car_only_truck_skip(), image_w=10, image_h=10,
    )
    assert len(lines) == 1
    assert lines[0].startswith("0 ")
    assert any("mask" in w.lower() for w in warnings)


def test_empty_mask_drops_line_and_warns() -> None:
    ann = _FakeAnnotation(
        kind=AnnotationKind.mask,
        geometry={"kind": "mask_rle", "size": [10, 10], "counts": "100"},
        class_id=_car_id(),
    )
    lines, warnings = write_yolo_label(
        [ann], remap=_remap_car_only_truck_skip(), image_w=10, image_h=10,
    )
    assert lines == []
    assert any("empty mask" in w for w in warnings)


def test_tag_is_skipped_in_writer() -> None:
    """Tags are routed through the ImageFolder classification layout —
    the geometric writer ignores them so detection/segmentation label
    files stay strictly geometric."""
    ann = _FakeAnnotation(kind=AnnotationKind.tag, geometry={}, class_id=_car_id())
    lines, warnings = write_yolo_label(
        [ann], remap=_remap_car_only_truck_skip(), image_w=10, image_h=10,
    )
    assert lines == []
    assert warnings == []


def test_bbox_coords_are_clamped_to_unit_interval() -> None:
    """A bbox that extends past the image right/bottom edge is clamped
    so Ultralytics' loader doesn't warn / silently clip."""
    ann = _FakeAnnotation(
        kind=AnnotationKind.bbox,
        # x=8, y=8, extends to 18 — well past the 10x10 image.
        geometry={"kind": "bbox", "x": 8, "y": 8, "w": 10, "h": 10},
        class_id=_car_id(),
    )
    lines, _ = write_yolo_label(
        [ann], remap=_remap_car_only_truck_skip(), image_w=10, image_h=10,
    )
    parts = lines[0].split()
    cx, cy, nw, nh = (float(p) for p in parts[1:])
    assert 0.0 <= cx <= 1.0
    assert 0.0 <= cy <= 1.0
    assert 0.0 <= nw <= 1.0
    assert 0.0 <= nh <= 1.0


def test_degenerate_polygon_dropped() -> None:
    ann = _FakeAnnotation(
        kind=AnnotationKind.polygon,
        geometry={"kind": "polygon", "points": [[0, 0], [5, 5]]},
        class_id=_car_id(),
    )
    lines, warnings = write_yolo_label(
        [ann], remap=_remap_car_only_truck_skip(), image_w=10, image_h=10,
    )
    assert lines == []
    assert any("<3 vertices" in w for w in warnings)


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
        splits={"train": "training_data"},
    )
    assert "nc: 2" in yaml
    assert '"vehicle"' in yaml
    assert '"person"' in yaml
    assert "train: training_data" in yaml
    # Unspecified splits are omitted — no fallback to `images/val` etc.
    assert "val:" not in yaml
    assert "test:" not in yaml


def test_data_yaml_omits_unspecified_splits() -> None:
    yaml = write_data_yaml(
        targets=[RemapTarget(export_id=0, name="x")],
        splits={"train": "td", "val": "td"},
    )
    assert "train: td" in yaml
    assert "val: td" in yaml
    assert "test:" not in yaml


def test_data_yaml_custom_splits() -> None:
    yaml = write_data_yaml(
        targets=[RemapTarget(export_id=0, name="x")],
        splits={"train": "splits/t", "val": "splits/v", "test": "splits/test"},
    )
    assert "train: splits/t" in yaml
    assert "val: splits/v" in yaml
