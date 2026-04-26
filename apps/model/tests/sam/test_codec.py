import numpy as np

from vaa_model.sam.codec import encode_mask_rle


def test_encode_all_zero_mask() -> None:
    m = np.zeros((4, 4), dtype=np.uint8)
    counts, size = encode_mask_rle(m)
    assert size == [4, 4]
    # 16 zeros → first run is 16 zeros (only one run, no flips)
    assert counts == "16"


def test_encode_all_one_mask() -> None:
    m = np.ones((4, 4), dtype=np.uint8)
    counts, size = encode_mask_rle(m)
    assert size == [4, 4]
    # First run is zero-len then 16 ones
    assert counts == "0,16"


def test_encode_top_left_block() -> None:
    """4x4 mask with a 2x2 ones block in the top-left. Column-major:
    column 0: rows 0..3 → [1,1,0,0]
    column 1: rows 0..3 → [1,1,0,0]
    column 2: rows 0..3 → [0,0,0,0]
    column 3: rows 0..3 → [0,0,0,0]
    flat: [1,1,0,0, 1,1,0,0, 0,0,0,0, 0,0,0,0]
    runs (starting with a zero-run, alternating):
      0  (initial zero-run, no leading zeros)
      2  ones
      2  zeros
      2  ones
      10 zeros (rest of column 1 + columns 2 & 3)
    => "0,2,2,2,10"
    """
    m = np.array([
        [1, 1, 0, 0],
        [1, 1, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
    ], dtype=np.uint8)
    counts, size = encode_mask_rle(m)
    assert size == [4, 4]
    assert counts == "0,2,2,2,10"


def test_encode_rejects_non_2d() -> None:
    import pytest
    with pytest.raises(ValueError):
        encode_mask_rle(np.zeros((1, 2, 3)))


def test_encode_treats_nonzero_as_one() -> None:
    m = np.array([[5, 0], [0, 7]], dtype=np.int32)
    # column-major flat: [5, 0, 0, 7] → [1, 0, 0, 1]
    # runs: 0 (zero-run start), 1, 2, 1
    counts, _ = encode_mask_rle(m)
    assert counts == "0,1,2,1"
