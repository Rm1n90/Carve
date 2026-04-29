"""Unit tests for the unified ``classes.json`` export manifest helper.

The helper lives in :mod:`carve_api.exports.job` so it can be reused from both
the YOLO and COCO archive paths. These tests pin the wire format that
downstream consumers (training pipelines, dataset tools) depend on.
"""

import json
import uuid
from dataclasses import dataclass

from carve_api.exports.job import build_classes_manifest


@dataclass
class _FakeClass:
    """Lightweight stand-in for ``carve_api.projects.models.Class``.

    The helper only reads ``id``, ``idx``, ``name`` and ``color`` so we keep
    this fixture deliberately minimal — it intentionally does not try to
    re-create the SQLAlchemy mapper.
    """

    id: uuid.UUID
    idx: int
    name: str
    color: str


def _classes() -> list[_FakeClass]:
    return [
        _FakeClass(
            id=uuid.UUID("00000000-0000-0000-0000-000000000001"),
            idx=0,
            name="person",
            color="#EF4444",
        ),
        _FakeClass(
            id=uuid.UUID("00000000-0000-0000-0000-000000000002"),
            idx=1,
            name="car",
            color="#3B82F6",
        ),
        _FakeClass(
            id=uuid.UUID("00000000-0000-0000-0000-000000000003"),
            idx=2,
            name="bicycle",
            color="#10B981",
        ),
    ]


def test_build_classes_manifest_returns_one_entry_per_class() -> None:
    # Arrange
    classes = _classes()

    # Act
    manifest = build_classes_manifest(classes)

    # Assert
    assert len(manifest) == 3


def test_build_classes_manifest_has_expected_shape() -> None:
    # Arrange
    classes = _classes()

    # Act
    manifest = build_classes_manifest(classes)

    # Assert — every entry has exactly id / idx / name / color (no kind).
    for entry in manifest:
        assert set(entry.keys()) == {"id", "idx", "name", "color"}
        assert isinstance(entry["id"], str)
        assert isinstance(entry["idx"], int)
        assert isinstance(entry["name"], str)
        assert isinstance(entry["color"], str)
        # Class colors are stored as 7-char hex (#RRGGBB).
        assert entry["color"].startswith("#")


def test_build_classes_manifest_sorted_by_idx_ascending() -> None:
    # Arrange — feed the helper out-of-order classes to prove it sorts.
    classes = list(reversed(_classes()))

    # Act
    manifest = build_classes_manifest(classes)

    # Assert
    indices = [e["idx"] for e in manifest]
    assert indices == sorted(indices)
    assert indices == [0, 1, 2]
    # First entry must be the lowest idx ("person", idx=0).
    assert manifest[0]["name"] == "person"
    assert manifest[-1]["name"] == "bicycle"


def test_build_classes_manifest_serializes_to_json() -> None:
    # Arrange
    classes = _classes()

    # Act
    manifest = build_classes_manifest(classes)
    encoded = json.dumps(manifest)

    # Assert — round-trip without losing fields.
    decoded = json.loads(encoded)
    assert decoded == manifest
    assert decoded[0]["id"] == "00000000-0000-0000-0000-000000000001"
    assert decoded[0]["color"] == "#EF4444"


def test_build_classes_manifest_handles_empty_iterable() -> None:
    # Arrange / Act
    manifest = build_classes_manifest([])

    # Assert
    assert manifest == []
