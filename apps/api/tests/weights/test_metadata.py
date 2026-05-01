"""Plan-09b Task 5 -- tests for the ``Weight.metadata_`` JSONB column,
``WeightOut.metadata`` exposure, and ``WeightIn`` rejection of writes.

The migration up/down sanity check is exercised implicitly by the test
DB fixture (``db_session``) which runs ``alembic upgrade head`` on
startup. We additionally verify the round-trip persistence and the
schema layer here.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from carve_api.auth.models import User, UserRole
from carve_api.projects.models import Project
from carve_api.weights.models import Weight, WeightTaskKind
from carve_api.weights.schemas import WeightIn, WeightOut


def _seed_user_project(db_session) -> tuple[User, Project]:
    u = User(email="meta@x.com", password_hash="x", role=UserRole.admin)
    db_session.add(u)
    db_session.flush()
    p = Project(name="P-meta", owner_id=u.id)
    db_session.add(p)
    db_session.flush()
    return u, p


def test_weight_metadata_round_trip(db_session) -> None:
    """Round-trip: assign metadata_, flush, re-read, assert equal."""
    u, p = _seed_user_project(db_session)
    w = Weight(
        project_id=p.id,
        name="meta-weight",
        task_kind=WeightTaskKind.detect,
        minio_key="weights/aa/bb.pt",
        size_bytes=1,
        class_names=["car"],
        created_by=u.id,
        metadata_={"k": "v"},
    )
    db_session.add(w)
    db_session.flush()

    db_session.expire(w)
    reloaded = db_session.query(Weight).filter(Weight.id == w.id).one()
    assert reloaded.metadata_ == {"k": "v"}


def test_weight_metadata_defaults_to_none(db_session) -> None:
    """Existing call sites that omit metadata_ keep ``None``."""
    u, p = _seed_user_project(db_session)
    w = Weight(
        project_id=p.id,
        name="no-meta",
        task_kind=WeightTaskKind.detect,
        minio_key="weights/aa/cc.pt",
        size_bytes=1,
        class_names=[],
        created_by=u.id,
    )
    db_session.add(w)
    db_session.flush()
    assert w.metadata_ is None


def test_weight_out_exposes_metadata(db_session) -> None:
    """``WeightOut.metadata`` mirrors ``Weight.metadata_``."""
    u, p = _seed_user_project(db_session)
    w = Weight(
        project_id=p.id,
        name="meta-out",
        task_kind=WeightTaskKind.detect,
        minio_key="weights/aa/dd.pt",
        size_bytes=1,
        class_names=["car"],
        created_by=u.id,
        metadata_={"k": "v"},
    )
    db_session.add(w)
    db_session.flush()

    out = WeightOut.from_orm_weight(w)
    assert out.metadata == {"k": "v"}


def test_weight_out_metadata_none_when_absent(db_session) -> None:
    u, p = _seed_user_project(db_session)
    w = Weight(
        project_id=p.id,
        name="no-meta-out",
        task_kind=WeightTaskKind.detect,
        minio_key="weights/aa/ee.pt",
        size_bytes=1,
        class_names=[],
        created_by=u.id,
    )
    db_session.add(w)
    db_session.flush()
    out = WeightOut.from_orm_weight(w)
    assert out.metadata is None


def test_weight_in_rejects_metadata_field() -> None:
    """``extra=\"forbid\"`` -- callers cannot set metadata via the request schema."""
    with pytest.raises(ValidationError):
        WeightIn(
            name="x",
            task_kind=WeightTaskKind.detect,
            class_names=[],
            metadata={"x": 1},  # type: ignore[call-arg]
        )


def test_weight_in_accepts_minimum_payload() -> None:
    """Sanity: WeightIn round-trips a valid payload without metadata."""
    payload = WeightIn(
        name="x",
        task_kind=WeightTaskKind.detect,
        class_names=["car"],
    )
    assert payload.name == "x"
    assert payload.class_names == ["car"]
