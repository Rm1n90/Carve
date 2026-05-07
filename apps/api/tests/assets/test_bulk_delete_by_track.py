# Armin Mehri — mehri.armin@gmail.com
"""DELETE /assets/{id}/annotations:by-track-ids — Track Discard helper."""
from unittest.mock import MagicMock
import pytest


@pytest.mark.unit
def test_bulk_delete_by_track_calls_db_delete():
    from carve_api.assets.router import _bulk_delete_by_track_ids_impl

    fake_db = MagicMock()
    fake_db.execute.return_value = MagicMock(rowcount=4)
    n = _bulk_delete_by_track_ids_impl(
        fake_db,
        asset_id="00000000-0000-0000-0000-000000000001",
        track_ids=[
            "11111111-1111-1111-1111-111111111111",
            "22222222-2222-2222-2222-222222222222",
        ],
    )
    assert n == 4
    assert fake_db.execute.called
    fake_db.commit.assert_called_once()
