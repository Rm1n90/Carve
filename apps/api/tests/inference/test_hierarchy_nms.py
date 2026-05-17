# Armin Mehri — mehri.armin@gmail.com
"""v3.31 — unit tests for the cross-class hierarchical NMS resolver.

Targets the pure helpers (`_bbox_from_geometry`, `_bbox_iou`,
`_ancestors_of`) plus the resolver entry point. Avoids the database
dependency by stubbing the SQLAlchemy session with a tiny in-memory
fake — keeps the test suite fast and CI-portable.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

import pytest

from carve_api.inference.hierarchy_nms import (
    MAX_CLASS_HIERARCHY_DEPTH,
    _ancestors_of,
    _bbox_from_geometry,
    _bbox_iou,
    resolve_hierarchy_overlaps,
)


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------


class TestBboxFromGeometry:
    def test_bbox_geometry_converts_xywh_to_xyxy(self) -> None:
        assert _bbox_from_geometry(
            {"kind": "bbox", "x": 10, "y": 20, "w": 30, "h": 40},
        ) == (10.0, 20.0, 40.0, 60.0)

    def test_polygon_collapses_to_axis_aligned_bbox(self) -> None:
        out = _bbox_from_geometry(
            {"kind": "polygon", "points": [[10, 20], [50, 10], [60, 70], [5, 80]]},
        )
        assert out == (5.0, 10.0, 60.0, 80.0)

    def test_returns_none_for_mask_rle(self) -> None:
        assert _bbox_from_geometry(
            {"kind": "mask_rle", "counts": "abc", "size": [10, 10]},
        ) is None

    def test_returns_none_for_degenerate_zero_size_bbox(self) -> None:
        assert _bbox_from_geometry(
            {"kind": "bbox", "x": 0, "y": 0, "w": 0, "h": 0},
        ) is None

    def test_returns_none_for_polygon_with_fewer_than_three_points(self) -> None:
        assert _bbox_from_geometry(
            {"kind": "polygon", "points": [[0, 0], [10, 10]]},
        ) is None

    def test_returns_none_for_malformed_geometry(self) -> None:
        assert _bbox_from_geometry(None) is None
        assert _bbox_from_geometry({}) is None
        assert _bbox_from_geometry({"kind": "bbox", "x": "oops"}) is None


# ---------------------------------------------------------------------------
# IoU
# ---------------------------------------------------------------------------


class TestBboxIou:
    def test_identical_boxes_return_one(self) -> None:
        assert _bbox_iou((0, 0, 10, 10), (0, 0, 10, 10)) == 1.0

    def test_disjoint_boxes_return_zero(self) -> None:
        assert _bbox_iou((0, 0, 10, 10), (20, 20, 30, 30)) == 0.0

    def test_half_overlap_returns_one_third(self) -> None:
        # Two 10x10 boxes sharing a 5x10 overlap -> inter=50, union=150.
        assert _bbox_iou((0, 0, 10, 10), (5, 0, 15, 10)) == pytest.approx(1 / 3)

    def test_degenerate_box_returns_zero(self) -> None:
        assert _bbox_iou((0, 0, 0, 0), (0, 0, 10, 10)) == 0.0


# ---------------------------------------------------------------------------
# Ancestor walk
# ---------------------------------------------------------------------------


@dataclass
class FakeClass:
    id: uuid.UUID
    parent_class_id: uuid.UUID | None = None


@dataclass
class FakeAnnotation:
    id: uuid.UUID
    class_id: uuid.UUID
    geometry: dict


class TestAncestorsOf:
    def test_returns_empty_for_top_level_class(self) -> None:
        a = FakeClass(uuid.uuid4())
        assert _ancestors_of(a.id, {a.id: a}) == set()

    def test_walks_single_parent(self) -> None:
        parent = FakeClass(uuid.uuid4())
        child = FakeClass(uuid.uuid4(), parent_class_id=parent.id)
        cmap = {parent.id: parent, child.id: child}
        assert _ancestors_of(child.id, cmap) == {parent.id}

    def test_walks_multi_level_chain(self) -> None:
        # Vehicle <- Car <- Racing Car <- Formula 1 Car
        v = FakeClass(uuid.uuid4())
        c = FakeClass(uuid.uuid4(), parent_class_id=v.id)
        rc = FakeClass(uuid.uuid4(), parent_class_id=c.id)
        f1 = FakeClass(uuid.uuid4(), parent_class_id=rc.id)
        cmap = {v.id: v, c.id: c, rc.id: rc, f1.id: f1}
        assert _ancestors_of(f1.id, cmap) == {v.id, c.id, rc.id}

    def test_cycle_in_data_does_not_loop(self) -> None:
        # Defensive: the API forbids this but if a migration blip ever
        # introduces a cycle, the walk must terminate.
        a = FakeClass(uuid.uuid4())
        b = FakeClass(uuid.uuid4())
        a.parent_class_id = b.id
        b.parent_class_id = a.id
        cmap = {a.id: a, b.id: b}
        result = _ancestors_of(a.id, cmap)
        assert result == {b.id}

    def test_caps_at_max_depth(self) -> None:
        # Build a chain longer than MAX_CLASS_HIERARCHY_DEPTH and make
        # sure the walk doesn't overshoot.
        classes = []
        prev = None
        for _ in range(MAX_CLASS_HIERARCHY_DEPTH + 4):
            cls = FakeClass(uuid.uuid4(), parent_class_id=prev.id if prev else None)
            classes.append(cls)
            prev = cls
        cmap = {c.id: c for c in classes}
        ancestors = _ancestors_of(classes[-1].id, cmap)
        assert len(ancestors) <= MAX_CLASS_HIERARCHY_DEPTH


# ---------------------------------------------------------------------------
# Resolver entry point — uses a fake session that captures the executed
# delete query so we can assert on which ids would be dropped.
# ---------------------------------------------------------------------------


class _CapturedDelete:
    def __init__(self) -> None:
        self.deleted_ids: list[uuid.UUID] = []
        self.flushed = False


class _FakeScalars:
    def __init__(self, rows: list[FakeAnnotation]) -> None:
        self._rows = rows

    def __iter__(self):
        return iter(self._rows)


class _FakeResult:
    def __init__(self, rows: list[FakeAnnotation]) -> None:
        self._rows = rows

    def scalars(self) -> _FakeScalars:
        return _FakeScalars(self._rows)


@dataclass
class _FakeSession:
    rows: list[FakeAnnotation]
    captured: _CapturedDelete = field(default_factory=_CapturedDelete)

    def execute(self, stmt: Any):  # noqa: D401 — match SQLAlchemy signature
        """Stub of Session.execute. Inspects the statement's class name
        to decide whether to return rows (select) or capture ids
        (delete)."""
        clazz = type(stmt).__name__
        if clazz == "Select":
            return _FakeResult(self.rows)
        if clazz == "Delete":
            try:
                inclause = stmt.whereclause
                ids = []
                for child in inclause.right.element.clauses:
                    ids.append(child.value)
                self.captured.deleted_ids = list(ids)
            except Exception:
                self.captured.deleted_ids = []
            return self
        return self

    def flush(self) -> None:
        self.captured.flushed = True


class TestResolveHierarchyOverlaps:
    def _make_annotation(
        self,
        class_id: uuid.UUID,
        bbox: tuple[float, float, float, float],
    ) -> FakeAnnotation:
        x1, y1, x2, y2 = bbox
        return FakeAnnotation(
            id=uuid.uuid4(),
            class_id=class_id,
            geometry={"kind": "bbox", "x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1},
        )

    def test_drops_ancestor_when_overlap_above_threshold(self) -> None:
        car = FakeClass(uuid.uuid4())
        racing_car = FakeClass(uuid.uuid4(), parent_class_id=car.id)
        cmap = {car.id: car, racing_car.id: racing_car}

        racing_ann = self._make_annotation(racing_car.id, (0, 0, 100, 100))
        car_ann = self._make_annotation(car.id, (0, 0, 100, 100))

        session = _FakeSession(rows=[racing_ann, car_ann])
        deleted = resolve_hierarchy_overlaps(
            session=session,
            new_annotation_ids=[racing_ann.id, car_ann.id],
            classes_by_id=cmap,
            iou_threshold=0.7,
        )
        assert deleted == [car_ann.id]
        # Resolver flushed the delete (canonical signal); the fake
        # session doesn't decode the in-clause structure so we don't
        # assert on captured ids here — the resolver's return value is
        # the public contract callers rely on.
        assert session.captured.flushed is True

    def test_keeps_ancestor_when_overlap_below_threshold(self) -> None:
        car = FakeClass(uuid.uuid4())
        racing_car = FakeClass(uuid.uuid4(), parent_class_id=car.id)
        cmap = {car.id: car, racing_car.id: racing_car}

        racing_ann = self._make_annotation(racing_car.id, (0, 0, 100, 100))
        car_ann = self._make_annotation(car.id, (200, 200, 300, 300))

        session = _FakeSession(rows=[racing_ann, car_ann])
        deleted = resolve_hierarchy_overlaps(
            session=session,
            new_annotation_ids=[racing_ann.id, car_ann.id],
            classes_by_id=cmap,
            iou_threshold=0.7,
        )
        assert deleted == []
        assert session.captured.flushed is False

    def test_siblings_under_same_parent_are_left_alone(self) -> None:
        car = FakeClass(uuid.uuid4())
        sedan = FakeClass(uuid.uuid4(), parent_class_id=car.id)
        racing_car = FakeClass(uuid.uuid4(), parent_class_id=car.id)
        cmap = {car.id: car, sedan.id: sedan, racing_car.id: racing_car}

        sedan_ann = self._make_annotation(sedan.id, (0, 0, 100, 100))
        racing_ann = self._make_annotation(racing_car.id, (0, 0, 100, 100))

        session = _FakeSession(rows=[sedan_ann, racing_ann])
        deleted = resolve_hierarchy_overlaps(
            session=session,
            new_annotation_ids=[sedan_ann.id, racing_ann.id],
            classes_by_id=cmap,
            iou_threshold=0.7,
        )
        assert deleted == []

    def test_multi_level_chain_drops_every_ancestor_in_overlap(self) -> None:
        vehicle = FakeClass(uuid.uuid4())
        car = FakeClass(uuid.uuid4(), parent_class_id=vehicle.id)
        racing_car = FakeClass(uuid.uuid4(), parent_class_id=car.id)
        cmap = {vehicle.id: vehicle, car.id: car, racing_car.id: racing_car}

        racing_ann = self._make_annotation(racing_car.id, (0, 0, 100, 100))
        car_ann = self._make_annotation(car.id, (0, 0, 100, 100))
        vehicle_ann = self._make_annotation(vehicle.id, (0, 0, 100, 100))

        session = _FakeSession(rows=[racing_ann, car_ann, vehicle_ann])
        deleted = resolve_hierarchy_overlaps(
            session=session,
            new_annotation_ids=[
                racing_ann.id,
                car_ann.id,
                vehicle_ann.id,
            ],
            classes_by_id=cmap,
            iou_threshold=0.7,
        )
        assert set(deleted) == {car_ann.id, vehicle_ann.id}

    def test_disabled_flag_is_a_noop(self) -> None:
        car = FakeClass(uuid.uuid4())
        racing_car = FakeClass(uuid.uuid4(), parent_class_id=car.id)
        cmap = {car.id: car, racing_car.id: racing_car}

        racing_ann = self._make_annotation(racing_car.id, (0, 0, 100, 100))
        car_ann = self._make_annotation(car.id, (0, 0, 100, 100))

        session = _FakeSession(rows=[racing_ann, car_ann])
        deleted = resolve_hierarchy_overlaps(
            session=session,
            new_annotation_ids=[racing_ann.id, car_ann.id],
            classes_by_id=cmap,
            iou_threshold=0.7,
            enabled=False,
        )
        assert deleted == []
        assert session.captured.flushed is False

    def test_empty_id_set_is_a_noop(self) -> None:
        session = _FakeSession(rows=[])
        deleted = resolve_hierarchy_overlaps(
            session=session,
            new_annotation_ids=[],
            classes_by_id={},
            iou_threshold=0.7,
        )
        assert deleted == []

    def test_no_class_with_parent_in_run_is_a_noop(self) -> None:
        a_cls = FakeClass(uuid.uuid4())
        b_cls = FakeClass(uuid.uuid4())
        cmap = {a_cls.id: a_cls, b_cls.id: b_cls}

        ann_a = self._make_annotation(a_cls.id, (0, 0, 100, 100))
        ann_b = self._make_annotation(b_cls.id, (0, 0, 100, 100))

        session = _FakeSession(rows=[ann_a, ann_b])
        deleted = resolve_hierarchy_overlaps(
            session=session,
            new_annotation_ids=[ann_a.id, ann_b.id],
            classes_by_id=cmap,
            iou_threshold=0.7,
        )
        assert deleted == []
