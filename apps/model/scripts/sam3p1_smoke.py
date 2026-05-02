"""SAM 3.1 smoke benchmark.

Plan 11 Task 7. Single-shot, non-interactive. Loads the SAM 3 image
predictor, runs one encode + decode on a tiny synthetic frame, prints
elapsed ms + peak VRAM. Optionally warms the multiplex video predictor
when ``SAM_VIDEO_BACKEND=multiplex`` and the native ``sam3`` git package
is installed.

Run with::

    docker compose exec model python /app/scripts/sam3p1_smoke.py
    docker compose exec model python /app/scripts/sam3p1_smoke.py --mode image
    docker compose exec model python /app/scripts/sam3p1_smoke.py --mode video

Output is one ``key=value`` line per measurement so it can be grepped
or piped into a results table.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Any

import numpy as np


def _env_report() -> dict[str, str]:
    return {
        "dtype": os.environ.get("SAM_DTYPE", "bf16"),
        "attn": os.environ.get("SAM_ATTN_IMPL", "sdpa"),
        "compile": os.environ.get("SAM_COMPILE", "false"),
        "backend": os.environ.get("SAM_VIDEO_BACKEND", "multiplex"),
    }


def _peak_vram_mb() -> int:
    try:
        import torch  # type: ignore[import-not-found]

        if not torch.cuda.is_available():
            return 0
        return int(torch.cuda.max_memory_allocated() / (1024 * 1024))
    except Exception:
        return 0


def _reset_peak() -> None:
    try:
        import torch  # type: ignore[import-not-found]

        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
    except Exception:
        pass


def _print_line(phase: str, env: dict[str, str], **extra: Any) -> None:
    parts = [f"phase={phase}"] + [f"{k}={v}" for k, v in env.items()]
    parts += [f"{k}={v}" for k, v in extra.items()]
    print(" ".join(parts), flush=True)


def _bench_image(env: dict[str, str]) -> int:
    from carve_model.sam import sam3_adapter

    rng = np.random.RandomState(0)
    image = rng.randint(0, 255, (640, 640, 3), dtype=np.uint8)

    _reset_peak()
    t0 = time.perf_counter()
    predictor = sam3_adapter.build_sam3_image_predictor()
    t_load_ms = int((time.perf_counter() - t0) * 1000)
    _print_line("image-load", env, elapsed_ms=t_load_ms, peak_vram_mb=_peak_vram_mb())

    _reset_peak()
    t0 = time.perf_counter()
    predictor.set_image(image)
    t_enc_ms = int((time.perf_counter() - t0) * 1000)
    _print_line("image-encode", env, elapsed_ms=t_enc_ms, peak_vram_mb=_peak_vram_mb())

    _reset_peak()
    t0 = time.perf_counter()
    predictor.predict(
        point_coords=[[320.0, 320.0]],
        point_labels=[1],
        multimask_output=True,
    )
    t_dec_ms = int((time.perf_counter() - t0) * 1000)
    _print_line("image-decode", env, elapsed_ms=t_dec_ms, peak_vram_mb=_peak_vram_mb())
    return 0


def _bench_video(env: dict[str, str]) -> int:
    try:
        from sam3.model_builder import build_sam3_multiplex_video_predictor  # type: ignore[import-not-found]
    except Exception as exc:
        _print_line(
            "video-skip",
            env,
            reason=type(exc).__name__,
            note="native_sam3_unavailable",
        )
        return 0

    _reset_peak()
    t0 = time.perf_counter()
    _ = build_sam3_multiplex_video_predictor()
    t_ms = int((time.perf_counter() - t0) * 1000)
    _print_line("video-load", env, elapsed_ms=t_ms, peak_vram_mb=_peak_vram_mb())
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="SAM 3.1 smoke benchmark")
    parser.add_argument(
        "--mode",
        choices=("image", "video", "both"),
        default="both",
        help="Which path to measure (default: both).",
    )
    args = parser.parse_args(argv)
    env = _env_report()

    if args.mode in ("image", "both"):
        _bench_image(env)
    if args.mode in ("video", "both"):
        _bench_video(env)
    return 0


if __name__ == "__main__":
    sys.exit(main())
