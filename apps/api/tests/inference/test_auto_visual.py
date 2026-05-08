"""Tests for auto_visual_for_asset."""
import uuid
from unittest.mock import patch

import pytest

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.models import User, UserRole
from carve_api.inference.auto_visual import (
    AutoVisualMixedRefs,
    AutoVisualNoClass,
    AutoVisualNoRefs,
    auto_visual_for_asset,
)
from carve_api.projects.models import Class, Project, Task, TaskKind


def _seed(db_session):
    """Returns (user, project, task, cls, target, refer)."""
    u = User(email=f"u-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.admin)
    db_session.add(u)
    db_session.flush()
    p = Project(name="P", owner_id=u.id)
    db_session.add(p)
    db_session.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image)
    db_session.add(t)
    db_session.flush()
    cls = Class(project_id=p.id, idx=0, name="cat", color="#ff0000")
    db_session.add(cls)
    db_session.flush()
    target = Asset(
        task_id=t.id,
        kind=AssetKind.image,
        xxh3_128="aa",
        mime="image/png",
        size_bytes=1,
        width=10,
        height=10,
        frames=1,
        original_name="t.png",
    )
    refer = Asset(
        task_id=t.id,
        kind=AssetKind.image,
        xxh3_128="bb",
        mime="image/png",
        size_bytes=1,
        width=10,
        height=10,
        frames=1,
        original_name="r.png",
    )
    db_session.add_all([target, refer])
    db_session.flush()
    db_session.add_all(
        [
            Frame(asset_id=target.id, idx=0, pts_ms=0),
            Frame(asset_id=refer.id, idx=0, pts_ms=0),
        ]
    )
    db_session.flush()
    return u, p, t, cls, target, refer


def test_auto_visual_creates_polygons_per_class(db_session):
    u, p, t, cls, target, refer = _seed(db_session)
    fake_results = [
        {
            "counts": "0",
            "size": [10, 10],
            "score": 0.9,
            "bbox": [1, 1, 9, 9],
            "polygon": [[1, 1], [9, 1], [9, 9]],
        }
    ]
    with patch(
        "carve_api.inference.auto_visual.sam_visual_prompt_for_asset",
        return_value=fake_results,
    ):
        out = auto_visual_for_asset(
            session=db_session,
            asset=target,
            task=t,
            sources=[
                {
                    "asset_id": str(refer.id),
                    "groups": [
                        {
                            "class_id": str(cls.id),
                            "refs": [{"kind": "bbox", "xyxy": [0, 0, 10, 10]}],
                        }
                    ],
                }
            ],
            ref_kind="bbox",
            threshold=0.4,
            find_all=True,
            overwrite=False,
            actor_id=None,
        )
    assert out["annotations_created"] == 1
    assert out["per_class"][str(cls.id)] == 1


def test_mixed_ref_types_rejected(db_session):
    u, p, t, cls, target, _ = _seed(db_session)
    with pytest.raises(AutoVisualMixedRefs):
        auto_visual_for_asset(
            session=db_session,
            asset=target,
            task=t,
            sources=[
                {
                    "asset_id": str(target.id),
                    "groups": [
                        {
                            "class_id": str(cls.id),
                            "refs": [
                                {"kind": "bbox", "xyxy": [0, 0, 10, 10]},
                                {"kind": "polygon", "points": [[0, 0], [1, 0], [1, 1]]},
                            ],
                        }
                    ],
                }
            ],
            ref_kind="bbox",
            threshold=0.4,
            find_all=True,
            overwrite=False,
            actor_id=None,
        )


def test_no_refs_rejected(db_session):
    u, p, t, cls, target, _ = _seed(db_session)
    with pytest.raises(AutoVisualNoRefs):
        auto_visual_for_asset(
            session=db_session,
            asset=target,
            task=t,
            sources=[],
            ref_kind="bbox",
            threshold=0.4,
            find_all=True,
            overwrite=False,
            actor_id=None,
        )


def test_no_class_assignment_rejected(db_session):
    u, p, t, cls, target, refer = _seed(db_session)
    with pytest.raises(AutoVisualNoClass):
        auto_visual_for_asset(
            session=db_session,
            asset=target,
            task=t,
            sources=[
                {
                    "asset_id": str(refer.id),
                    "groups": [
                        {
                            "class_id": "",
                            "refs": [{"kind": "bbox", "xyxy": [0, 0, 10, 10]}],
                        }
                    ],
                }
            ],
            ref_kind="bbox",
            threshold=0.4,
            find_all=True,
            overwrite=False,
            actor_id=None,
        )


def test_overwrite_safe_when_no_matches(db_session):
    """Zero-match runs must NOT delete pre-existing annotations
    (parity with v3.7.2 / auto-text safety)."""
    u, p, t, cls, target, refer = _seed(db_session)
    # Pre-existing annotation on the target frame for the same class.
    existing = Annotation(
        task_id=t.id,
        frame_id=None,
        class_id=cls.id,
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 1, "y": 2, "w": 3, "h": 4},
        track_id=None,
        created_by=None,
    )
    db_session.add(existing)
    db_session.flush()
    with patch(
        "carve_api.inference.auto_visual.sam_visual_prompt_for_asset",
        return_value=[],
    ):
        auto_visual_for_asset(
            session=db_session,
            asset=target,
            task=t,
            sources=[
                {
                    "asset_id": str(refer.id),
                    "groups": [
                        {
                            "class_id": str(cls.id),
                            "refs": [{"kind": "bbox", "xyxy": [0, 0, 10, 10]}],
                        }
                    ],
                }
            ],
            ref_kind="bbox",
            threshold=0.4,
            find_all=True,
            overwrite=True,
            actor_id=None,
        )
    db_session.flush()
    # Existing annotation must still be present.
    assert db_session.get(Annotation, existing.id) is not None
