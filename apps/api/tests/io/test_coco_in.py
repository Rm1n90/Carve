import io
import json
import zipfile

from vaa_api.annotations.models import AnnotationKind
from vaa_api.io.coco_in import parse_coco_archive, parse_coco_bytes


def test_parses_bbox_annotation() -> None:
    coco = {
        "images": [{"id": 1, "file_name": "a.png", "width": 100, "height": 50}],
        "categories": [{"id": 0, "name": "car"}],
        "annotations": [
            {
                "id": 1,
                "image_id": 1,
                "category_id": 0,
                "bbox": [10, 20, 30, 40],
                "area": 1200,
                "iscrowd": 0,
            },
        ],
    }
    parsed = parse_coco_bytes(json.dumps(coco).encode())
    assert parsed.warnings == []
    assert len(parsed.drafts) == 1
    d = parsed.drafts[0]
    assert d.kind == AnnotationKind.bbox
    assert d.class_name == "car"
    assert d.image_filename == "a"
    assert d.geometry == {"kind": "bbox", "x": 10.0, "y": 20.0, "w": 30.0, "h": 40.0}


def test_parses_polygon_segmentation() -> None:
    coco = {
        "images": [{"id": 1, "file_name": "a.png", "width": 100, "height": 50}],
        "categories": [{"id": 0, "name": "car"}],
        "annotations": [
            {
                "id": 1,
                "image_id": 1,
                "category_id": 0,
                "bbox": [0, 0, 30, 30],
                "segmentation": [[0, 0, 30, 0, 30, 30]],
                "iscrowd": 0,
            },
        ],
    }
    parsed = parse_coco_bytes(json.dumps(coco).encode())
    assert len(parsed.drafts) == 1
    d = parsed.drafts[0]
    assert d.kind == AnnotationKind.polygon
    assert d.geometry["points"] == [[0.0, 0.0], [30.0, 0.0], [30.0, 30.0]]


def test_parses_rle_mask_segmentation() -> None:
    coco = {
        "images": [{"id": 1, "file_name": "a.png", "width": 100, "height": 50}],
        "categories": [{"id": 0, "name": "car"}],
        "annotations": [
            {
                "id": 1,
                "image_id": 1,
                "category_id": 0,
                "bbox": [0, 0, 100, 50],
                "segmentation": {"size": [50, 100], "counts": "0,2,2,2,10"},
                "iscrowd": 0,
            },
        ],
    }
    parsed = parse_coco_bytes(json.dumps(coco).encode())
    d = parsed.drafts[0]
    assert d.kind == AnnotationKind.mask
    assert d.geometry == {"kind": "mask_rle", "size": [50, 100], "counts": "0,2,2,2,10"}


def test_full_image_bbox_treated_as_tag() -> None:
    """coco_out emits frame-level tags as a full-image bbox; importer recognises this."""
    coco = {
        "images": [{"id": 1, "file_name": "a.png", "width": 100, "height": 50}],
        "categories": [{"id": 0, "name": "weather-sunny"}],
        "annotations": [
            {
                "id": 1,
                "image_id": 1,
                "category_id": 0,
                "bbox": [0, 0, 100, 50],
                "iscrowd": 0,
            },
        ],
    }
    parsed = parse_coco_bytes(json.dumps(coco).encode())
    assert parsed.drafts[0].kind == AnnotationKind.tag


def test_unknown_image_id_warns() -> None:
    coco = {
        "images": [{"id": 1, "file_name": "a.png", "width": 100, "height": 50}],
        "categories": [{"id": 0, "name": "car"}],
        "annotations": [
            {"id": 1, "image_id": 99, "category_id": 0, "bbox": [0, 0, 10, 10]},
        ],
    }
    parsed = parse_coco_bytes(json.dumps(coco).encode())
    assert parsed.drafts == []
    assert len(parsed.warnings) == 1
    assert "image_id 99" in parsed.warnings[0]


def test_unknown_category_id_warns() -> None:
    coco = {
        "images": [{"id": 1, "file_name": "a.png", "width": 100, "height": 50}],
        "categories": [{"id": 0, "name": "car"}],
        "annotations": [
            {"id": 1, "image_id": 1, "category_id": 99, "bbox": [0, 0, 10, 10]},
        ],
    }
    parsed = parse_coco_bytes(json.dumps(coco).encode())
    assert parsed.drafts == []
    assert "category_id 99" in parsed.warnings[0]


def test_polygon_too_few_points_warns() -> None:
    coco = {
        "images": [{"id": 1, "file_name": "a.png", "width": 100, "height": 50}],
        "categories": [{"id": 0, "name": "car"}],
        "annotations": [
            {"id": 1, "image_id": 1, "category_id": 0, "segmentation": [[0, 0, 1, 1]]},
        ],
    }
    parsed = parse_coco_bytes(json.dumps(coco).encode())
    assert parsed.drafts == []
    assert "polygon" in parsed.warnings[0]


def test_invalid_json_raises() -> None:
    import pytest
    with pytest.raises(ValueError):
        parse_coco_bytes(b"{invalid json")


def test_archive_form_finds_json() -> None:
    coco = {
        "images": [{"id": 1, "file_name": "a.png", "width": 100, "height": 50}],
        "categories": [{"id": 0, "name": "car"}],
        "annotations": [
            {"id": 1, "image_id": 1, "category_id": 0, "bbox": [10, 20, 30, 40]},
        ],
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("coco.json", json.dumps(coco))
    parsed = parse_coco_archive(buf.getvalue())
    assert len(parsed.drafts) == 1


def test_archive_without_json_raises() -> None:
    import pytest
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("readme.txt", "no json here")
    with pytest.raises(ValueError):
        parse_coco_archive(buf.getvalue())


def test_oversized_member_rejected(monkeypatch) -> None:
    """Per-member zip-bomb guard: a single .json larger than the cap raises."""
    import pytest

    from vaa_api.io import coco_in

    monkeypatch.setattr(coco_in, "_MAX_MEMBER_BYTES", 100)
    big_json = (b"{}" + b" " * 5000)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("coco.json", big_json)
    with pytest.raises(ValueError, match="import_archive_member_too_large"):
        coco_in.parse_coco_archive(buf.getvalue())
