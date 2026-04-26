import uuid
from typing import Any

import pytest

from vaa_api.annotations.models import AnnotationKind
from vaa_api.io.coco_out import build_coco


class _FakeAnnotation:
    def __init__(self, *, kind: AnnotationKind, geometry: dict, class_id: Any):
        self.kind = kind
        self.geometry = geometry
        self.class_id = class_id


CAR = uuid.UUID("00000000-0000-0000-0000-000000000001")
TRUCK = uuid.UUID("00000000-0000-0000-0000-000000000002")


def _images() -> list[dict]:
    return [
        {"id": 1, "file_name": "a.png", "width": 640, "height": 480},
        {"id": 2, "file_name": "b.png", "width": 320, "height": 240},
    ]


def _remap() -> dict:
    return {
        str(CAR): {"export_id": 0, "name": "vehicle"},
        str(TRUCK): {"export_id": 0, "name": "vehicle"},  # merged into "vehicle"
    }


def test_bbox_emits_xywh_and_area() -> None:
    bbox = _FakeAnnotation(
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 10, "y": 20, "w": 30, "h": 40},
        class_id=CAR,
    )
    coco = build_coco(
        images=_images(),
        annotations_by_image_id={1: [bbox]},
        remap=_remap(),
    )
    assert len(coco["annotations"]) == 1
    a = coco["annotations"][0]
    assert a["bbox"] == [10.0, 20.0, 30.0, 40.0]
    assert a["area"] == 1200.0
    assert a["category_id"] == 0
    assert a["image_id"] == 1
    assert a["iscrowd"] == 0


def test_polygon_emits_flat_segmentation_and_bbox() -> None:
    poly = _FakeAnnotation(
        kind=AnnotationKind.polygon,
        geometry={"kind": "polygon", "points": [[10, 10], [30, 10], [30, 50]]},
        class_id=CAR,
    )
    coco = build_coco(
        images=_images(),
        annotations_by_image_id={1: [poly]},
        remap=_remap(),
    )
    a = coco["annotations"][0]
    assert a["segmentation"] == [[10.0, 10.0, 30.0, 10.0, 30.0, 50.0]]
    assert a["bbox"] == [10.0, 10.0, 20.0, 40.0]
    assert a["area"] == 800.0


def test_mask_emits_rle_segmentation() -> None:
    mask = _FakeAnnotation(
        kind=AnnotationKind.mask,
        geometry={"kind": "mask_rle", "size": [4, 4], "counts": "0,2,2,2,10"},
        class_id=CAR,
    )
    coco = build_coco(
        images=_images(),
        annotations_by_image_id={1: [mask]},
        remap=_remap(),
    )
    a = coco["annotations"][0]
    assert a["segmentation"] == {"size": [4, 4], "counts": "0,2,2,2,10"}
    assert a["bbox"] == [0.0, 0.0, 640.0, 480.0]
    assert a["area"] == 640.0 * 480.0


def test_tag_emits_full_image_bbox() -> None:
    tag = _FakeAnnotation(kind=AnnotationKind.tag, geometry={}, class_id=CAR)
    coco = build_coco(
        images=_images(),
        annotations_by_image_id={2: [tag]},
        remap=_remap(),
    )
    a = coco["annotations"][0]
    assert a["bbox"] == [0.0, 0.0, 320.0, 240.0]
    assert a["area"] == 320.0 * 240.0


def test_categories_dedup_by_export_id() -> None:
    car_box = _FakeAnnotation(
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 1, "y": 1, "w": 2, "h": 2},
        class_id=CAR,
    )
    truck_box = _FakeAnnotation(
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 1, "y": 1, "w": 3, "h": 3},
        class_id=TRUCK,
    )
    coco = build_coco(
        images=_images(),
        annotations_by_image_id={1: [car_box, truck_box]},
        remap=_remap(),
    )
    # Both classes mapped to export_id=0 ("vehicle"); should be one category.
    assert coco["categories"] == [{"id": 0, "name": "vehicle"}]


def test_skipped_remap_drops_annotation() -> None:
    other = _FakeAnnotation(
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 1, "y": 1, "w": 2, "h": 2},
        class_id=CAR,
    )
    coco = build_coco(
        images=_images(),
        annotations_by_image_id={1: [other]},
        remap={str(CAR): None},
    )
    assert coco["annotations"] == []
    assert coco["categories"] == []


def test_unknown_image_id_raises() -> None:
    ann = _FakeAnnotation(
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 1, "y": 1, "w": 2, "h": 2},
        class_id=CAR,
    )
    with pytest.raises(ValueError):
        build_coco(
            images=_images(),
            annotations_by_image_id={99: [ann]},
            remap=_remap(),
        )


def test_categories_sorted_by_id() -> None:
    # Two distinct export_ids; verify deterministic ordering
    remap = {
        str(CAR): {"export_id": 5, "name": "z-class"},
        str(TRUCK): {"export_id": 1, "name": "a-class"},
    }
    car_box = _FakeAnnotation(
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 1, "y": 1, "w": 2, "h": 2},
        class_id=CAR,
    )
    truck_box = _FakeAnnotation(
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 1, "y": 1, "w": 3, "h": 3},
        class_id=TRUCK,
    )
    coco = build_coco(
        images=_images(),
        annotations_by_image_id={1: [car_box, truck_box]},
        remap=remap,
    )
    ids = [c["id"] for c in coco["categories"]]
    assert ids == [1, 5]


def test_annotation_ids_are_unique_and_sequential() -> None:
    boxes = [
        _FakeAnnotation(
            kind=AnnotationKind.bbox,
            geometry={"kind": "bbox", "x": i, "y": i, "w": 1, "h": 1},
            class_id=CAR,
        )
        for i in range(5)
    ]
    coco = build_coco(
        images=_images(),
        annotations_by_image_id={1: boxes},
        remap=_remap(),
    )
    ids = [a["id"] for a in coco["annotations"]]
    assert ids == [1, 2, 3, 4, 5]
