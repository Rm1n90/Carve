# Armin Mehri — mehri.armin@gmail.com
"""v3.33 -- unit tests for the cross-class winner-takes-all NMS resolver.

Defends the fix for the user-reported bug:

  "After adding the parent class logic, I see sometimes some wrong
   annotation is appearing... Motorbike has 2 annotations, one
   motorbike and racing car!"

The hierarchy resolver intentionally left Motorbike + Racing Car alone
because Motorbike isn't in Racing Car's ancestor chain. This new
resolver, when the user opts in, drops the lower-confidence sibling
in any unrelated-class overlap.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from carve_api.inference.cross_class_nms import resolve_cross_class_overlaps


# ---------------------------------------------------------------------------
# Shared fakes (mirror the hierarchy_nms test conventions so future
# maintenance has a single mental model). Kept local to this file to
# avoid a shared test-helper module.
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

    def execute(self, stmt: Any):  # noqa: D401 — SQLAlchemy signature
        clazz = type(stmt).__name__
        if clazz == "Select":
            return _FakeResult(self.rows)
        if clazz == "Delete":
            try:
                inclause = stmt.whereclause
                ids: list[uuid.UUID] = []
                for child in inclause.right.element.clauses:
                    ids.append(child.value)
                self.captured.deleted_ids = list(ids)
            except Exception:
                self.captured.deleted_ids = []
            return self
        return self

    def flush(self) -> None:
        self.captured.flushed = True


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestResolveCrossClassOverlaps:
    def _bbox_geom(
        self, bbox: tuple[float, float, float, float]
    ) -> dict:
        x1, y1, x2, y2 = bbox
        return {"kind": "bbox", "x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}

    def test_drops_lower_confidence_for_unrelated_overlap(self) -> None:
        """The user-reported scenario: Motorbike (high conf) + Racing Car
        (low conf) on the same pixels -> Racing Car dropped."""
        motorbike = FakeClass(uuid.uuid4())
        racing_car = FakeClass(uuid.uuid4())  # unrelated to motorbike
        cmap = {motorbike.id: motorbike, racing_car.id: racing_car}

        mb_ann = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=motorbike.id,
            geometry=self._bbox_geom((0, 0, 100, 100)),
        )
        rc_ann = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=racing_car.id,
            geometry=self._bbox_geom((0, 0, 100, 100)),
        )
        scores = {mb_ann.id: 0.92, rc_ann.id: 0.41}

        session = _FakeSession(rows=[mb_ann, rc_ann])
        deleted = resolve_cross_class_overlaps(
            session=session,
            new_annotation_ids=[mb_ann.id, rc_ann.id],
            scores=scores,
            classes_by_id=cmap,
            iou_threshold=0.7,
        )
        assert deleted == [rc_ann.id]
        assert session.captured.flushed is True

    def test_keeps_both_when_iou_below_threshold(self) -> None:
        """Cleanly separated objects (e.g. a motorbike on the left, a
        real racing car on the right) must not be cross-suppressed."""
        motorbike = FakeClass(uuid.uuid4())
        racing_car = FakeClass(uuid.uuid4())
        cmap = {motorbike.id: motorbike, racing_car.id: racing_car}

        mb_ann = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=motorbike.id,
            geometry=self._bbox_geom((0, 0, 100, 100)),
        )
        rc_ann = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=racing_car.id,
            geometry=self._bbox_geom((300, 300, 400, 400)),
        )
        scores = {mb_ann.id: 0.92, rc_ann.id: 0.41}

        session = _FakeSession(rows=[mb_ann, rc_ann])
        deleted = resolve_cross_class_overlaps(
            session=session,
            new_annotation_ids=[mb_ann.id, rc_ann.id],
            scores=scores,
            classes_by_id=cmap,
            iou_threshold=0.7,
        )
        assert deleted == []
        assert session.captured.flushed is False

    def test_defers_ancestor_descendant_pairs_to_hierarchy_resolver(
        self,
    ) -> None:
        """Critical safety: if we acted on Car/Racing Car overlap we
        could drop Racing Car (lower conf) and undo the hierarchy fix.
        Those pairs are explicitly skipped here."""
        car = FakeClass(uuid.uuid4())
        racing_car = FakeClass(uuid.uuid4(), parent_class_id=car.id)
        cmap = {car.id: car, racing_car.id: racing_car}

        car_ann = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=car.id,
            geometry=self._bbox_geom((0, 0, 100, 100)),
        )
        rc_ann = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=racing_car.id,
            geometry=self._bbox_geom((0, 0, 100, 100)),
        )
        # Confusingly, the Car has HIGHER confidence than Racing Car.
        # If we unconditionally dropped the lower-score annotation we'd
        # delete Racing Car -- exactly the wrong outcome.
        scores = {car_ann.id: 0.92, rc_ann.id: 0.41}

        session = _FakeSession(rows=[car_ann, rc_ann])
        deleted = resolve_cross_class_overlaps(
            session=session,
            new_annotation_ids=[car_ann.id, rc_ann.id],
            scores=scores,
            classes_by_id=cmap,
            iou_threshold=0.7,
        )
        assert deleted == []
        assert session.captured.flushed is False

    def test_drops_lower_confidence_sibling_under_shared_parent(
        self,
    ) -> None:
        """Sibling classes (Sedan + Racing Car under Car) overlapping
        on the same object: the hierarchy resolver leaves them alone,
        but a user who opted into cross-class NMS wants the winner."""
        car = FakeClass(uuid.uuid4())
        sedan = FakeClass(uuid.uuid4(), parent_class_id=car.id)
        racing_car = FakeClass(uuid.uuid4(), parent_class_id=car.id)
        cmap = {car.id: car, sedan.id: sedan, racing_car.id: racing_car}

        sedan_ann = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=sedan.id,
            geometry=self._bbox_geom((0, 0, 100, 100)),
        )
        rc_ann = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=racing_car.id,
            geometry=self._bbox_geom((0, 0, 100, 100)),
        )
        scores = {sedan_ann.id: 0.87, rc_ann.id: 0.42}

        session = _FakeSession(rows=[sedan_ann, rc_ann])
        deleted = resolve_cross_class_overlaps(
            session=session,
            new_annotation_ids=[sedan_ann.id, rc_ann.id],
            scores=scores,
            classes_by_id=cmap,
            iou_threshold=0.7,
        )
        assert deleted == [rc_ann.id]

    def test_disabled_flag_is_a_noop(self) -> None:
        a_cls = FakeClass(uuid.uuid4())
        b_cls = FakeClass(uuid.uuid4())
        cmap = {a_cls.id: a_cls, b_cls.id: b_cls}
        a = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=a_cls.id,
            geometry=self._bbox_geom((0, 0, 100, 100)),
        )
        b = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=b_cls.id,
            geometry=self._bbox_geom((0, 0, 100, 100)),
        )

        session = _FakeSession(rows=[a, b])
        deleted = resolve_cross_class_overlaps(
            session=session,
            new_annotation_ids=[a.id, b.id],
            scores={a.id: 0.9, b.id: 0.4},
            classes_by_id=cmap,
            iou_threshold=0.7,
            enabled=False,
        )
        assert deleted == []
        assert session.captured.flushed is False

    def test_same_class_pairs_are_ignored(self) -> None:
        """Intra-class NMS already deduped these upstream; this resolver
        must not interfere with them."""
        cls = FakeClass(uuid.uuid4())
        cmap = {cls.id: cls}
        a = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=cls.id,
            geometry=self._bbox_geom((0, 0, 100, 100)),
        )
        b = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=cls.id,
            geometry=self._bbox_geom((0, 0, 100, 100)),
        )

        session = _FakeSession(rows=[a, b])
        deleted = resolve_cross_class_overlaps(
            session=session,
            new_annotation_ids=[a.id, b.id],
            scores={a.id: 0.9, b.id: 0.4},
            classes_by_id=cmap,
            iou_threshold=0.7,
        )
        assert deleted == []

    def test_missing_score_treated_as_zero(self) -> None:
        """A missing score doesn't crash the resolver; the annotation
        is treated as zero-confidence and gets dropped first."""
        a_cls = FakeClass(uuid.uuid4())
        b_cls = FakeClass(uuid.uuid4())
        cmap = {a_cls.id: a_cls, b_cls.id: b_cls}
        a = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=a_cls.id,
            geometry=self._bbox_geom((0, 0, 100, 100)),
        )
        b = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=b_cls.id,
            geometry=self._bbox_geom((0, 0, 100, 100)),
        )

        session = _FakeSession(rows=[a, b])
        deleted = resolve_cross_class_overlaps(
            session=session,
            new_annotation_ids=[a.id, b.id],
            # ``a`` has a score; ``b`` doesn't -> treated as 0.0.
            scores={a.id: 0.6},
            classes_by_id=cmap,
            iou_threshold=0.7,
        )
        assert deleted == [b.id]

    def test_three_way_overlap_drops_two_lowest(self) -> None:
        """Three unrelated detections all overlapping the same object.
        The highest-confidence one should be the sole survivor."""
        cls_a = FakeClass(uuid.uuid4())
        cls_b = FakeClass(uuid.uuid4())
        cls_c = FakeClass(uuid.uuid4())
        cmap = {cls_a.id: cls_a, cls_b.id: cls_b, cls_c.id: cls_c}
        a = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=cls_a.id,
            geometry=self._bbox_geom((0, 0, 100, 100)),
        )
        b = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=cls_b.id,
            geometry=self._bbox_geom((0, 0, 100, 100)),
        )
        c = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=cls_c.id,
            geometry=self._bbox_geom((0, 0, 100, 100)),
        )

        session = _FakeSession(rows=[a, b, c])
        deleted = resolve_cross_class_overlaps(
            session=session,
            new_annotation_ids=[a.id, b.id, c.id],
            scores={a.id: 0.95, b.id: 0.60, c.id: 0.30},
            classes_by_id=cmap,
            iou_threshold=0.7,
        )
        # ``a`` is the highest; ``b`` and ``c`` must be dropped.
        assert set(deleted) == {b.id, c.id}

    def test_mask_only_annotations_are_skipped(self) -> None:
        """mask_rle geometries can't be turned into a bbox without
        decoding the RLE. The resolver leaves them alone (same as the
        hierarchy resolver)."""
        cls_a = FakeClass(uuid.uuid4())
        cls_b = FakeClass(uuid.uuid4())
        cmap = {cls_a.id: cls_a, cls_b.id: cls_b}
        a = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=cls_a.id,
            geometry={"kind": "mask_rle", "size": [100, 100], "counts": "x"},
        )
        b = FakeAnnotation(
            id=uuid.uuid4(),
            class_id=cls_b.id,
            geometry={"kind": "mask_rle", "size": [100, 100], "counts": "y"},
        )

        session = _FakeSession(rows=[a, b])
        deleted = resolve_cross_class_overlaps(
            session=session,
            new_annotation_ids=[a.id, b.id],
            scores={a.id: 0.9, b.id: 0.4},
            classes_by_id=cmap,
            iou_threshold=0.7,
        )
        assert deleted == []
