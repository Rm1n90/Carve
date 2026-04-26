import io
import json
import zipfile

from vaa_api.annotations.models import AnnotationKind
from vaa_api.io.yolo_in import (
    AnnotationDraft, ParsedArchive,
    _parse_yaml_names, parse_yolo_archive,
)


def _build_zip(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, body in files.items():
            zf.writestr(name, body)
    return buf.getvalue()


def test_parse_yaml_names_inline_list() -> None:
    assert _parse_yaml_names('names: ["car", "truck"]') == ["car", "truck"]


def test_parse_yaml_names_block_form() -> None:
    text = "names:\n  0: car\n  1: truck\n"
    assert _parse_yaml_names(text) == ["car", "truck"]


def test_parse_yaml_names_missing_returns_empty() -> None:
    assert _parse_yaml_names("path: .\nnc: 0\n") == []


def test_round_trip_bbox() -> None:
    """A YOLO archive written by yolo_out should re-parse to the same geometry."""
    yaml_text = 'names: ["car"]\n'
    label_text = "0 0.156250 0.187500 0.156250 0.166667\n"
    archive = _build_zip({"data.yaml": yaml_text.encode(), "labels/a.txt": label_text.encode()})
    parsed = parse_yolo_archive(
        archive, image_dimensions={"a.png": (640, 480), "a": (640, 480)}
    )
    assert parsed.warnings == []
    assert len(parsed.drafts) == 1
    d = parsed.drafts[0]
    assert d.kind == AnnotationKind.bbox
    assert d.image_filename == "a"
    assert d.class_name == "car"
    g = d.geometry
    # cx=0.15625 → x = (0.15625 - 0.078125) * 640 = 50; w = 0.15625 * 640 = 100
    assert abs(g["x"] - 50.0) < 0.01
    assert abs(g["w"] - 100.0) < 0.01
    assert abs(g["h"] - 80.0) < 0.05


def test_polygon_round_trip() -> None:
    yaml_text = 'names: ["car"]\n'
    label_text = "0 0.0 0.0 1.0 0.0 1.0 1.0\n"
    archive = _build_zip({"data.yaml": yaml_text.encode(), "labels/a.txt": label_text.encode()})
    parsed = parse_yolo_archive(archive, image_dimensions={"a": (10, 10)})
    assert len(parsed.drafts) == 1
    d = parsed.drafts[0]
    assert d.kind == AnnotationKind.polygon
    assert d.geometry["points"] == [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]]


def test_tag_single_index_round_trip() -> None:
    yaml_text = 'names: ["car"]\n'
    label_text = "0\n"
    archive = _build_zip({"data.yaml": yaml_text.encode(), "labels/a.txt": label_text.encode()})
    parsed = parse_yolo_archive(archive, image_dimensions={"a": (1, 1)})
    assert parsed.drafts[0].kind == AnnotationKind.tag


def test_unknown_class_index_warns() -> None:
    yaml_text = 'names: ["car"]\n'
    label_text = "5 0.5 0.5 0.1 0.1\n"  # idx 5 doesn't exist
    archive = _build_zip({"data.yaml": yaml_text.encode(), "labels/a.txt": label_text.encode()})
    parsed = parse_yolo_archive(archive, image_dimensions={"a": (10, 10)})
    assert len(parsed.drafts) == 0
    assert len(parsed.warnings) == 1
    assert "out of range" in parsed.warnings[0]


def test_missing_yaml_warns_but_returns_empty() -> None:
    archive = _build_zip({"labels/a.txt": b"0 0.5 0.5 0.1 0.1\n"})
    parsed = parse_yolo_archive(archive)
    assert "no data.yaml" in parsed.warnings[0]
    assert parsed.class_names == []


def test_bad_zip_raises() -> None:
    import pytest
    with pytest.raises(ValueError):
        parse_yolo_archive(b"not a zip")


def test_blank_lines_skipped() -> None:
    yaml_text = 'names: ["car"]\n'
    label_text = "0 0.5 0.5 0.1 0.1\n\n   \n"
    archive = _build_zip({"data.yaml": yaml_text.encode(), "labels/a.txt": label_text.encode()})
    parsed = parse_yolo_archive(archive, image_dimensions={"a": (10, 10)})
    assert len(parsed.drafts) == 1
