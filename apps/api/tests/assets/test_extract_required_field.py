# Armin Mehri — mehri.armin@gmail.com
"""AssetOut.extract_required is True for fresh video uploads, False
for images and for videos that already have frames extracted. Used by
the client to decide whether to call POST /frames/extract.
"""
from datetime import datetime
from types import SimpleNamespace
import uuid

import pytest

from carve_api.assets.models import AssetKind
from carve_api.assets.schemas import AssetOut


def _make_asset_row(*, kind: AssetKind, frames: int):
    """Stand-in for an ORM Asset row — only the attributes from_orm_asset reads."""
    return SimpleNamespace(
        id=uuid.uuid4(),
        task_id=uuid.uuid4(),
        kind=kind,
        xxh3_128="a" * 32,
        mime="image/png" if kind == AssetKind.image else "video/mp4",
        size_bytes=1024,
        width=16,
        height=16,
        frames=frames,
        original_name="x.png" if kind == AssetKind.image else "clip.mp4",
        created_at=datetime(2026, 5, 7, 12, 0, 0),
    )


@pytest.mark.unit
def test_video_with_zero_frames_is_extract_required_true():
    asset = _make_asset_row(kind=AssetKind.video, frames=0)
    out = AssetOut.from_orm_asset(asset)
    assert out.kind == AssetKind.video
    assert out.extract_required is True


@pytest.mark.unit
def test_video_with_extracted_frames_is_extract_required_false():
    asset = _make_asset_row(kind=AssetKind.video, frames=120)
    out = AssetOut.from_orm_asset(asset)
    assert out.extract_required is False


@pytest.mark.unit
def test_image_is_extract_required_false():
    asset = _make_asset_row(kind=AssetKind.image, frames=1)
    out = AssetOut.from_orm_asset(asset)
    assert out.kind == AssetKind.image
    assert out.extract_required is False
