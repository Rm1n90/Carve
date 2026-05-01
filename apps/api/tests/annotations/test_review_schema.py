"""Tests for the Phase 5 review-workflow schema (plan-09 task-01).

Covers:
1. Inserting an annotation without ``status`` defaults to ``"proposed"``.
2. The four review fields round-trip through ``AnnotationOut``.
3. ``AnnotationIn`` rejects attempts to set the review fields (model_config
   ``extra="forbid"``) -- clients cannot smuggle review state through the
   create path.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.annotations.schemas import AnnotationIn, AnnotationOut
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.models import User, UserRole
from carve_api.projects.models import Class, Project, Task, TaskKind


def _setup(db):
    u = User(email="rev@y.com", password_hash="x", role=UserRole.admin)
    db.add(u)
    db.flush()
    p = Project(name="P-rev", owner_id=u.id)
    db.add(p)
    db.flush()
    t = Task(project_id=p.id, name="T-rev", kind=TaskKind.image)
    db.add(t)
    db.flush()
    a = Asset(
        task_id=t.id, kind=AssetKind.image, xxh3_128="rv", mime="image/png",
        size_bytes=10, width=100, height=100, frames=1, original_name="r.png",
    )
    db.add(a)
    db.flush()
    f = Frame(asset_id=a.id, idx=0, pts_ms=0)
    db.add(f)
    db.flush()
    c = Class(project_id=p.id, idx=0, name="car", color="#ff0000")
    db.add(c)
    db.flush()
    return t, f, c, u


def test_status_defaults_to_proposed_on_insert(db_session) -> None:
    # Arrange
    t, f, c, u = _setup(db_session)
    ann = Annotation(
        task_id=t.id, frame_id=f.id, class_id=c.id,
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0},
        created_by=u.id,
    )

    # Act
    db_session.add(ann)
    db_session.flush()
    db_session.refresh(ann)

    # Assert
    assert ann.status == "proposed"
    assert ann.reviewed_by_id is None
    assert ann.reviewed_at is None
    assert ann.prev_geometry is None


def test_review_fields_round_trip_through_annotation_out(db_session) -> None:
    # Arrange
    t, f, c, u = _setup(db_session)
    reviewer = User(email="reviewer@y.com", password_hash="x", role=UserRole.admin)
    db_session.add(reviewer)
    db_session.flush()

    reviewed_at = datetime(2026, 5, 1, 12, 0, 0, tzinfo=timezone.utc)
    prev_geom = {"kind": "bbox", "x": 0.0, "y": 0.0, "w": 5.0, "h": 5.0}
    ann = Annotation(
        task_id=t.id, frame_id=f.id, class_id=c.id,
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0},
        created_by=u.id,
        status="accepted",
        reviewed_by_id=reviewer.id,
        reviewed_at=reviewed_at,
        prev_geometry=prev_geom,
    )
    db_session.add(ann)
    db_session.flush()
    db_session.refresh(ann)

    # Act
    out = AnnotationOut.from_orm_annotation(ann)

    # Assert
    assert out.status == "accepted"
    assert out.reviewed_by_id == str(reviewer.id)
    assert out.reviewed_at == reviewed_at
    assert out.prev_geometry == prev_geom


@pytest.mark.parametrize(
    "field, value",
    [
        ("status", "accepted"),
        ("reviewed_by_id", "00000000-0000-0000-0000-000000000001"),
        ("reviewed_at", "2026-05-01T12:00:00+00:00"),
        ("prev_geometry", {"kind": "bbox", "x": 0, "y": 0, "w": 1, "h": 1}),
    ],
)
def test_annotation_in_rejects_review_fields(field: str, value) -> None:
    """Inbound writes must NOT be able to set review state. The model's
    ``extra="forbid"`` config raises ``ValidationError`` when a client
    attempts to inject any of the review-workflow fields.
    """
    # Arrange
    payload = {
        "class_id": "00000000-0000-0000-0000-000000000abc",
        "kind": "bbox",
        "geometry": {"kind": "bbox", "x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0},
        field: value,
    }

    # Act / Assert
    with pytest.raises(ValidationError):
        AnnotationIn.model_validate(payload)


def test_annotation_in_still_accepts_legitimate_payload() -> None:
    # Arrange / Act
    obj = AnnotationIn.model_validate(
        {
            "class_id": "00000000-0000-0000-0000-000000000abc",
            "kind": "bbox",
            "geometry": {"kind": "bbox", "x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0},
        }
    )

    # Assert
    assert obj.kind == AnnotationKind.bbox
    assert obj.class_id == "00000000-0000-0000-0000-000000000abc"
