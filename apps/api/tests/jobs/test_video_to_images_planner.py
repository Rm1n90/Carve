import pytest

from carve_api.jobs.video_to_images_planner import compute_extraction_timestamps


def test_all_returns_every_frame_timestamp() -> None:
    ts = compute_extraction_timestamps(
        mode="all", n_or_k=0, frame_count=10, fps=10.0, duration_s=1.0
    )
    assert len(ts) == 10
    assert ts[0] == pytest.approx(0.0)
    assert ts[-1] == pytest.approx(0.9, abs=1e-3)


def test_every_nth_returns_step_indices() -> None:
    ts = compute_extraction_timestamps(
        mode="every_nth", n_or_k=3, frame_count=10, fps=10.0, duration_s=1.0
    )
    assert ts == pytest.approx([0.0, 0.3, 0.6, 0.9], abs=1e-3)


def test_count_returns_k_evenly_spaced() -> None:
    ts = compute_extraction_timestamps(
        mode="count", n_or_k=4, frame_count=100, fps=10.0, duration_s=10.0
    )
    assert len(ts) == 4
    assert ts[0] == pytest.approx(0.0, abs=1e-3)
    assert ts[-1] == pytest.approx(10.0, abs=1e-3)


def test_count_when_k_exceeds_frame_count_collapses_to_all() -> None:
    ts = compute_extraction_timestamps(
        mode="count", n_or_k=1000, frame_count=10, fps=10.0, duration_s=1.0
    )
    assert len(ts) == 10


def test_auto_below_500_returns_all() -> None:
    ts = compute_extraction_timestamps(
        mode="auto", n_or_k=0, frame_count=500, fps=25.0, duration_s=20.0
    )
    assert len(ts) == 500


def test_auto_above_500_returns_500() -> None:
    ts = compute_extraction_timestamps(
        mode="auto", n_or_k=0, frame_count=2000, fps=25.0, duration_s=80.0
    )
    assert len(ts) == 500


def test_every_nth_with_n_larger_than_frame_count_returns_first_frame_only() -> None:
    ts = compute_extraction_timestamps(
        mode="every_nth", n_or_k=999, frame_count=10, fps=10.0, duration_s=1.0
    )
    assert ts == pytest.approx([0.0])


def test_rejects_zero_frame_count() -> None:
    with pytest.raises(ValueError, match="frame_count"):
        compute_extraction_timestamps(
            mode="all", n_or_k=0, frame_count=0, fps=10.0, duration_s=1.0
        )


def test_rejects_zero_fps() -> None:
    with pytest.raises(ValueError, match="fps"):
        compute_extraction_timestamps(
            mode="all", n_or_k=0, frame_count=10, fps=0.0, duration_s=1.0
        )
