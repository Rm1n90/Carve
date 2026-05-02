# SAM 3.1 Inference

Operator and developer reference for the SAM 3.1 path that ships with
Plan 11. Covers what 3.1 brings over 2.1, hardware caveats, the env
vars exposed in `docker-compose.yml`, install notes, the server API
surface, and how to read the smoke benchmark output.

## Overview

SAM 3.1 layers two things on top of SAM 3:

- **Object Multiplex** — a single video predictor jointly tracks
  every object in the scene. The cost of adding one more object is
  small relative to running an independent tracker per object,
  giving roughly a 7× speedup at 128 objects on Meta's reference
  hardware.
- **Improved video object segmentation** — better mask quality and
  temporal stability than the SAM 2 → SAM 3 transition.

In this codebase the SAM 3 image predictor is reused unchanged. The
"3.1" delta is the multiplex video tracker; image-prompt encode and
single-frame decode go through the same `Sam3TrackerModel` factory.

## Hardware notes

- **GPUs we run on**: RTX 3090 (Ampere), RTX 4070 Ti / 4090 (Ada).
- **FlashAttention 4 is Hopper / Blackwell only** — **not supported**
  on Ampere or Ada. Use SDPA (the default) or build FlashAttention 2
  from source if you want a small extra step.
- **PyTorch ≥ 2.7**, **CUDA 12.6**.

## Environment variables

All four perf knobs are surfaced on the `model:` service in
`docker-compose.yml` and read by
`apps/model/src/carve_model/sam/perf.py` and
`apps/model/src/carve_model/sam/tracker.py`.

| Variable | Values | Default | Notes |
| --- | --- | --- | --- |
| `SAM_DTYPE` | `bf16` / `fp16` / `fp32` | `bf16` (cuda) / `fp32` (cpu) | bf16 is the right choice on Ampere+. |
| `SAM_ATTN_IMPL` | `sdpa` / `flash_attention_2` / `eager` | `sdpa` | `flash_attention_2` requires the optional `flash-attn` package; if it isn't installed the helper falls back to `sdpa` and logs a warning. |
| `SAM_COMPILE` | `true` / `false` | `false` | When `true`, wraps the vision encoder with `torch.compile(mode="reduce-overhead")`. First call pays a compile cost; subsequent calls are faster. |
| `SAM_VIDEO_BACKEND` | `multiplex` / unset | `multiplex` | `multiplex` routes video tracking through the native `sam3` git package (Object Multiplex joint tracking). Anything else (or unset) makes `SAM_MODEL=sam3` fall back to the transformers SAM 3 dispatcher. |
| `SAM_MODEL` | `sam2.1-large`, `sam3`, `sam3.1`, … | `sam2.1-large` | Setting `sam3.1` is equivalent to `SAM_MODEL=sam3` + `SAM_VIDEO_BACKEND=multiplex` for the video path. |

## Install caveats

The native `sam3` git package is installed via the `sam3p1` extras
group in the model image's Dockerfile:

```bash
pip install -e ".[gpu,sam3p1]" --no-deps
```

Multi-gigabyte checkpoints download lazily on the first call to
`build_sam3_image_predictor` or `build_sam3_multiplex_video_predictor`.
Expect the first `start_session` request after a cold container boot
to take a while; subsequent calls hit the `hf_cache` named volume.

## API surface (server-side, recap)

These endpoints sit on the FastAPI service and proxy through to the
model service. They are documented in detail in `tools.md`; this is
the SAM 3.1-specific recap.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/assets/{aid}/sam-track/start` | Open a tracking session. |
| `POST` | `/assets/{aid}/sam-track/{sid}/objects` | Add a point/box/text prompt. Text prompts return `{obj_ids: [...]}` because multiplex auto-assigns one object id per detected instance. |
| `POST` | `/assets/{aid}/sam-track/{sid}/step?frames=N` | Propagate masks across N frames. |
| `DELETE` | `/assets/{aid}/sam-track/{sid}/objects/{oid}` | Remove a tracked object. **Multiplex only** — non-multiplex returns `422 tracker_not_multiplex`. |
| `POST` | `/assets/{aid}/sam-track/{sid}/reset` | Reset the session's text prompts. **Multiplex only.** |
| `DELETE` | `/assets/{aid}/sam-track/{sid}` | Release the session. |

## Editor UX

- **Track mode** supports point, bbox, and text seeds in the same
  session — pick the tool, click or type, and the tracker stitches
  them into one multiplex predictor state.
- Each tracked object has an X icon on its row that calls the
  `DELETE …/objects/{oid}` endpoint. The icon is hidden when the
  active tracker isn't multiplex.
- Multi-class tracking works by switching the active class between
  adds; each `objects` POST tags the new ids with the current class.

## Benchmarks

The smoke harness lives at `apps/model/scripts/sam3p1_smoke.py` and
emits one `key=value` line per measurement.

```bash
docker compose exec model python /app/scripts/sam3p1_smoke.py
docker compose exec model python /app/scripts/sam3p1_smoke.py --mode image
docker compose exec model python /app/scripts/sam3p1_smoke.py --mode video
```

Sample line:

```
phase=image-encode dtype=bf16 attn=sdpa compile=false backend=multiplex elapsed_ms=420 peak_vram_mb=4123
```

Phases reported:

- `image-load` — predictor construction (HF download + `.to(device)`).
- `image-encode` — `set_image` on a 640×640 synthetic frame.
- `image-decode` — single positive-click `predict` call.
- `video-load` — multiplex predictor construction (only when the
  native `sam3` package is importable; otherwise `video-skip`).

Real numbers will land here once we measure on representative
hardware.

| GPU | Phase | dtype | attn | compile | elapsed_ms | peak_vram_mb |
| --- | --- | --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | TBD | TBD | TBD |

## Troubleshooting

- **`tracker_not_multiplex` 422** from `DELETE …/objects/{oid}` or
  `…/reset`: `SAM_VIDEO_BACKEND=multiplex` isn't set, OR the native
  `sam3` install failed inside the model image. Re-check the model
  container's image and the `model:` service env block.
- **First call is very slow**: the multiplex predictor downloads
  several gigabytes of weights lazily on first `start_session`. The
  `carve-hf-cache` named volume keeps them around for subsequent
  runs; don't remove the volume between deploys.
- **VRAM OOM during tracking**: the predictor's `max_num_objects`
  is currently hardcoded. Lowering it is a follow-up; for now,
  reduce the number of seeds per session or move to a larger GPU.
