"""Tests for ``sam_visual_prompt_for_asset`` (the API-side helper that
fetches asset bytes from MinIO + forwards to ``/sam/visual-prompt`` on
the model service).

These were originally written against a non-existent
``/assets/{aid}/sam/visual-prompt`` HTTP route. Rewritten in v3.28 to
test the Python helper directly — the real HTTP surface is
``/assets/{id}/sam/auto-visual`` (sync) and ``/tasks/{id}/sam/auto-visual-batch``
(batch), already covered by ``test_auto_visual_router.py`` and
``test_auto_visual_batch.py``.
"""
from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest

from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.models import User, UserRole
from carve_api.inference.sam import (
    Sam3NotEnabled,
    SamModelFailed,
    SamModelUnreachable,
    sam_visual_prompt_for_asset,
)
from carve_api.inference.model_client import ModelServiceError
from carve_api.projects.models import Project, Task, TaskKind


def _seed(db_session):
    u = User(email=f"u-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.admin)
    db_session.add(u)
    db_session.flush()
    p = Project(name="P", owner_id=u.id)
    db_session.add(p)
    db_session.flush()
    t = Task(project_id=p.id, name="T", kind=TaskKind.image)
    db_session.add(t)
    db_session.flush()
    target = Asset(
        task_id=t.id, kind=AssetKind.image, xxh3_128="aa",
        mime="image/png", size_bytes=1, width=10, height=10,
        frames=1, original_name="t.png",
    )
    refer = Asset(
        task_id=t.id, kind=AssetKind.image, xxh3_128="bb",
        mime="image/png", size_bytes=1, width=10, height=10,
        frames=1, original_name="r.png",
    )
    db_session.add_all([target, refer])
    db_session.flush()
    db_session.add_all([
        Frame(asset_id=target.id, idx=0, pts_ms=0),
        Frame(asset_id=refer.id, idx=0, pts_ms=0),
    ])
    db_session.commit()
    return target, refer


def test_sam_visual_prompt_for_asset_loads_bytes_and_forwards(db_session):
    target, refer = _seed(db_session)
    with (
        patch("carve_api.inference.sam.fetch_asset_bytes", return_value=b"fakebytes"),
        patch(
            "carve_api.inference.sam.sam_visual_prompt",
            return_value=[{
                "counts": "0", "size": [10, 10], "score": 0.9,
                "bbox": [1, 1, 9, 9], "polygon": [[1, 1], [9, 1], [9, 9]],
            }],
        ) as mock_vp,
    ):
        out = sam_visual_prompt_for_asset(
            target_asset=target,
            refer_asset=refer,
            regions=[{"kind": "bbox", "xyxy": [0, 0, 10, 10]}],
        )
    assert len(out) == 1
    assert out[0]["score"] == 0.9
    mock_vp.assert_called_once()
    kwargs = mock_vp.call_args.kwargs
    assert "refer_b64" in kwargs
    assert "target_b64" in kwargs
    assert kwargs["regions"] == [{"kind": "bbox", "xyxy": [0, 0, 10, 10]}]


def test_sam_visual_prompt_for_asset_maps_409_to_sam3_not_enabled(db_session):
    target, refer = _seed(db_session)
    with (
        patch("carve_api.inference.sam.fetch_asset_bytes", return_value=b"fakebytes"),
        patch(
            "carve_api.inference.sam.sam_visual_prompt",
            side_effect=ModelServiceError(409, {"detail": "sam3p1_not_enabled"}),
        ),
        pytest.raises(Sam3NotEnabled),
    ):
        sam_visual_prompt_for_asset(
            target_asset=target, refer_asset=refer,
            regions=[{"kind": "bbox", "xyxy": [0, 0, 10, 10]}],
        )


def test_sam_visual_prompt_for_asset_maps_503_to_unreachable(db_session):
    target, refer = _seed(db_session)
    with (
        patch("carve_api.inference.sam.fetch_asset_bytes", return_value=b"fakebytes"),
        patch(
            "carve_api.inference.sam.sam_visual_prompt",
            side_effect=ModelServiceError(503, {"detail": "model_service_unreachable"}),
        ),
        pytest.raises(SamModelUnreachable),
    ):
        sam_visual_prompt_for_asset(
            target_asset=target, refer_asset=refer,
            regions=[{"kind": "bbox", "xyxy": [0, 0, 10, 10]}],
        )


def test_sam_visual_prompt_for_asset_maps_other_4xx_to_failed(db_session):
    target, refer = _seed(db_session)
    with (
        patch("carve_api.inference.sam.fetch_asset_bytes", return_value=b"fakebytes"),
        patch(
            "carve_api.inference.sam.sam_visual_prompt",
            side_effect=ModelServiceError(422, {"detail": "mixed_ref_types"}),
        ),
        pytest.raises(SamModelFailed),
    ):
        sam_visual_prompt_for_asset(
            target_asset=target, refer_asset=refer,
            regions=[
                {"kind": "bbox", "xyxy": [0, 0, 10, 10]},
                {"kind": "polygon", "points": [[0, 0], [1, 0], [1, 1]]},
            ],
        )
