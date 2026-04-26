"""Column-major run-length encoder matching the web maskio.ts format.

Output is a comma-separated ASCII run length list, alternating zero-runs first.
This v1 simplification round-trips losslessly with the web client; full COCO
LEB128-base64 is a Plan 06 concern when import/export needs cross-format.
"""

import numpy as np


def encode_mask_rle(mask: np.ndarray) -> tuple[str, list[int]]:
    """Encode a 2-D 0/1 mask as a tuple of (counts, [h, w]).

    Mask must be a numpy array of shape (h, w). Non-zero pixels are treated as 1.
    """
    if mask.ndim != 2:
        raise ValueError(f"mask must be 2-D, got shape {mask.shape}")
    h, w = mask.shape
    flat = (mask.astype(np.uint8) > 0).T.flatten()  # column-major flatten
    runs: list[int] = []
    prev = 0
    run = 0
    for v in flat:
        v_int = int(v)
        if v_int == prev:
            run += 1
        else:
            runs.append(run)
            prev = v_int
            run = 1
    runs.append(run)
    return ",".join(str(r) for r in runs), [h, w]
