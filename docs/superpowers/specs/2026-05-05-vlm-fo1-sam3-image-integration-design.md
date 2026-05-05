# VLM-FO1 × SAM 3 — Image-Path Integration Design

- **Date:** 2026-05-05
- **Author:** Armin Mehri
- **Status:** Draft (awaiting review)
- **Scope:** Image annotation path only. Video paths (SAM 3.1 multiplex, SAM 3 video dispatcher) are explicitly out of scope.
- **Goal:** Reduce SAM 3 text-prompt failures (missed objects, wrong objects, ambiguous compositional prompts) by inserting VLM-FO1 as a precision filter on top of SAM 3's mask proposals. Annotation becomes more "user types a prompt, system returns the right masks."
- **Default posture:** Feature is **OFF by default**, both server-side (capability gate) and per-request (user opt-in). The toggle lives in the annotation editor UI and is honored by both the single-image text-prompt path and the **Auto mode** (multi-class) batch path.

## Naming note (SAM 3 vs SAM 3.1)

The user requested "apply this on SAM3.1." In our codebase, **SAM 3.1** specifically refers to the **multiplex video** backend (`sam3p1_adapter.py`). The image-side concept-text path runs through **SAM 3** (`sam3_adapter.py`) using the transformers `Sam3Model` + `Sam3Processor` classes against `facebook/sam3` weights. Since the user explicitly excluded video and wants only the image path, this design integrates VLM-FO1 with the existing **SAM 3 image text-prompt** flow. No code under `sam3p1_adapter.py` is modified.

## Context

### What VLM-FO1 actually is
- Paper: arXiv 2509.25916 (Om AI Lab, Sept 2025).
- Model: `omlab/VLM-FO1_Qwen2.5-VL-3B-v01` — 3B parameters, **Qwen2.5-VL-3B base** plus a Hybrid Fine-grained Region Encoder (HFRE) that produces region tokens.
- Mechanism: VLM receives image + text + a list of candidate bounding boxes; LLM emits "region indexes" indicating which boxes match the prompt. Sidesteps the "VLMs are bad at coordinates" problem.
- Reported metrics (with UPN proposals): COCO mAP 44.4, HumanRef DF1/P/R 82.6/86.8/83.5, LVIS SS-IoU 92.5, PACO SS-IoU 88.1.
- Repo: https://github.com/om-ai-lab/VLM-FO1 (299★, last push 2026-03-12).
- Reference script: `scripts/inference_with_sam3.py` — SAM 3 produces proposals (top-100 by score), FO1 filters.

### Why this fits our pain
The user has reported SAM 3 text-prompts "missing or cannot find what I exactly want." Failure modes:
1. Returns nothing for a valid concept.
2. Returns the wrong object (visual ambiguity).
3. Misses instances in dense scenes (logos in stadium shots).
4. Compositional prompts ("the goalkeeper diving left") don't work.

VLM-FO1 directly addresses (2) and (4); modes (1) and (3) are addressed by the design choice to **send all SAM 3 candidates over a low score threshold** to VLM-FO1, not just top-1.

### What we don't try to solve here
- **Logos / brand recognition.** VLM-FO1 doesn't know your specific brands. A SigLIP 2 reference-bank for logos is a separate spec.
- **Open-vocabulary detection from scratch** (Grounding DINO / YOLO-World). Out of scope.
- **Video.** Excluded by user.

## Constraints

- **VRAM:** Single 24 GB GPU. Existing footprint: SAM 3 image (`Sam3Model`) ~6 GB bf16. VLM-FO1 (Qwen2.5-VL-3B) ~6 GB bf16, ~3 GB 4-bit.
- **Process model:** All models live inside the `model` Docker service (`apps/model`). The `api` service calls it over HTTP at `MODEL_BASE_URL`.
- **License:** VLM-FO1 GitHub repo declares **no license** (HF Space metadata says Apache-2.0). Our project is AGPL-3.0. **Action item before merge:** open an issue on the VLM-FO1 repo asking them to declare a license, OR vendor only the inference utilities under a clear use-rights statement, OR call the model purely via HF transformers without copying their code. Resolution gates merge.
- **Maturity:** Reference Space is research-grade, not production. Real-world latency on our hardware unknown.
- **Idle eviction:** Existing pattern in `apps/model/src/carve_model/main.py:8` (`evict_predictor_if_idle`, `evict_idle_sessions`). VLM-FO1 must follow the same pattern.

## Design

### High-level data flow

```
client → POST /sam/text-prompt {image_b64, text}
        │
        ▼
 model service: text predictor (sam3_adapter.make_sam3_text_predictor)
        │
        ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ Stage 1: SAM 3 concept segmentation (existing)              │
 │   Sam3Model + Sam3Processor → masks, boxes, scores          │
 │   Filter: score >= SAM3_PROPOSAL_THRESHOLD (default 0.20,   │
 │           lower than today's 0.50 so FO1 sees more recall)  │
 │   Cap: top-K by score (default K=64)                        │
 └─────────────────────────────────────────────────────────────┘
        │ N proposals (masks, boxes, scores, polygons)
        ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ Stage 2: VLM-FO1 filtering (new, optional)                  │
 │   Inputs: image + text + boxes                              │
 │   Output: subset of indexes matching the prompt             │
 │   Skip if VLM_FO1_ENABLED=false OR N == 0                   │
 │   Skip and pass through if Stage 2 hits an error/timeout    │
 └─────────────────────────────────────────────────────────────┘
        │ filtered indexes
        ▼
 Return list[TextPromptOut] (counts/size/score/bbox/polygon)
```

### Toggle architecture (default OFF, user-controllable)

Two layers of opt-in:

1. **Server capability gate** — `VLM_FO1_AVAILABLE=0` by default. When 0, the FO1 module is never imported, weights are never downloaded, and `/sam/status` reports `vlm_fo1_loaded=false, vlm_fo1_available=false`. Flipping to `1` lets the model service lazily load FO1 on first opted-in request. Set in `docker-compose.yml` / `.env`.

2. **Per-request opt-in** — `TextPromptIn.use_vlm_fo1: bool = False`. The HTTP boundary defaults to **false** so SAM 3 text-prompt behavior is byte-for-byte identical to today unless the caller asks for FO1. This flag is honored only when the server capability gate is on; otherwise the flag is ignored and the response carries `vlm_fo1_filtered=false, vlm_fo1_available=false` so clients can show "feature unavailable on this server."

3. **Editor UI** — a toggle in the annotation editor's settings panel (project-scoped or user-scoped — see below). When on, the frontend sets `use_vlm_fo1=true` on every `/sam/text-prompt` and Auto-mode batch request. Default off. The toggle is hidden when `/sam/status` reports `vlm_fo1_available=false`.

4. **Auto mode coverage** — `apps/api/src/carve_api/inference/auto_text.py` (multi-class SAM 3 text-prompt batch) reads the same toggle and forwards `use_vlm_fo1` through `model_client.sam_text_prompt()`. The Auto-annotate dialog (`apps/web/src/components/annotation/AutoAnnotateDialog.tsx`) exposes the toggle next to the existing class selection, defaulting to off.

**Toggle persistence — open question for review:**
- Option A: **per-user** (column on `users` table) — simplest; persists across projects.
- Option B: **per-project** (column on `projects` table) — admins decide for the whole team.
- Option C: **per-session** (localStorage only) — lowest commitment.

Recommendation: **Option A (per-user)** with a future-proof shape that allows project-level override later. Mirrors how the per-user shortcut feature is already stored.

### Component changes

#### 1. New module: `apps/model/src/carve_model/vlm_fo1/`
- `__init__.py` — public re-exports.
- `adapter.py` — `VlmFo1Filter` class. Load Qwen2.5-VL-3B + FO1 weights lazily. Public method: `filter(image_pil, text, boxes_xyxy) -> list[int]` returning matched indexes. Imports `torch` and `transformers` only inside method bodies (mirrors `sam3_adapter.py` policy — keeps the dev path import-clean).
- `prompts.py` — copy of FO1's `OD_template` (single string constant). Cite source. No FO1 source code copied beyond this template until license is clarified.
- `loader.py` — singleton-ish: load on first call, expose `evict_if_idle()` for the sweeper, expose `is_loaded()` for `/sam/status`.
- `quantization.py` — bf16 default; 4-bit (bitsandbytes) optional via env. Tuned per VRAM headroom.

#### 2. Modify: `apps/model/src/carve_model/sam/sam3_adapter.py`
In `make_sam3_text_predictor` (line 276+):
- Lower default proposal threshold from 0.50 to `SAM3_PROPOSAL_THRESHOLD` (default 0.20). Make it env-configurable.
- After `post_process_instance_segmentation`, sort by score desc and cap at `SAM3_TOPK_PROPOSALS` (default 64).
- After scoring, if `VlmFo1Filter` is registered + enabled, call `vlm_fo1.filter(pil, text, boxes)` to get indexes; subset masks/boxes/scores to those indexes. On error/timeout, log and pass through unfiltered (graceful degradation).
- Re-apply existing final threshold (`0.50`) AFTER FO1 filtering, OR drop the post-FO1 threshold entirely — FO1 confidence is the authoritative signal at this point. Decision: **drop post-FO1 threshold.** FO1 is more discriminating than raw mask scores.

#### 3. Modify: `apps/model/src/carve_model/sam/predictor.py`
- Add a parallel slot for `vlm_fo1_filter` next to `text_predictor`. Public setters: `set_vlm_fo1_filter(...)`, `evict_vlm_fo1_if_idle()`.
- Surface `vlm_fo1_loaded` / `vlm_fo1_loading` in `/sam/status` response (alongside existing fields).
- Idle sweeper (`main.py:_sweep_loop`) gains `evict_vlm_fo1_if_idle()` call.

#### 4. Modify: `apps/model/src/carve_model/sam/router.py`
- Extend `TextPromptIn` (line ~234) with optional `use_vlm_fo1: bool = False` — **defaults false**. Caller must explicitly opt in. No new endpoint — existing `/sam/text-prompt` keeps its contract.
- Extend `TextPromptOut` with optional `vlm_fo1_filtered: bool` and `vlm_fo1_available: bool` flags so the client can render the toggle state and show "feature unavailable" cleanly.
- `/sam/status` payload gains `vlm_fo1_available`, `vlm_fo1_loaded`, `vlm_fo1_loading`, `vlm_fo1_dtype`, `vlm_fo1_quant`.

#### 5. Modify: `apps/model/src/carve_model/main.py`
- In `_lifespan`, if `VLM_FO1_AVAILABLE=1`, register the filter via `predictor.set_vlm_fo1_filter(vlm_fo1.adapter.build_filter())`. **Default 0** — feature off. Lazy load — no eager weight download even when available.
- Document `VLM_FO1_AVAILABLE`, `VLM_FO1_QUANT`, `VLM_FO1_MAX_PROPOSALS`, `VLM_FO1_TIMEOUT_S` in the env help block.

#### 6. Modify: `docker-compose.yml`
- Add env passthrough for `VLM_FO1_AVAILABLE` (default 0), `VLM_FO1_QUANT`, `SAM3_PROPOSAL_THRESHOLD`, `SAM3_TOPK_PROPOSALS`. No new service.
- Mount HF cache volume so the Qwen2.5-VL-3B base + FO1 head don't re-download every restart (already done for SAM 3 via `HF_HOME`).

#### 7. Modify: `apps/model/pyproject.toml` (or equivalent requirements file)
- Pin: `transformers >= 4.50.1` (already required by SAM 3; FO1 reference uses `4.50.1` exactly — verify our version compatible).
- Optional dep: `bitsandbytes` for 4-bit quant.
- No new top-level deps for FO1 itself if we use HF transformers; FO1 module code copied only for `OD_template` (license-permitting).

#### 8. API service: thread the toggle through both single-image and Auto mode

- `apps/api/src/carve_api/inference/model_client.py:206` — `sam_text_prompt(image_b64, text, *, use_vlm_fo1=False)` — add the kwarg and POST it to the model service. Default false preserves all existing callers.
- `apps/api/src/carve_api/inference/sam.py` — `sam_text_prompt_for_asset(...)` — accept and forward `use_vlm_fo1`.
- `apps/api/src/carve_api/inference/auto_text.py:run_auto_text_annotate` — accept `use_vlm_fo1` from the request schema and forward to `sam_text_prompt_for_asset` for every class iteration. **This is the Auto mode coverage.**
- `apps/api/src/carve_api/inference/router.py` — extend the request schema for the multi-asset Auto-annotate batch endpoint to accept `use_vlm_fo1: bool = False`.
- New endpoint: `GET /inference/capabilities` (or fold into existing `/sam/status` proxy) — surfaces `vlm_fo1_available` to the frontend so the UI can hide the toggle when the server can't satisfy it.

#### 9. Frontend: editor toggle + Auto-annotate dialog toggle

- New per-user setting: `use_vlm_fo1: bool` (default false). Persisted alongside other user preferences (mirroring the per-user shortcuts pattern from commit `fd920f7`).
- Backend: `users` table column or settings JSON; expose via existing `/users/me/preferences` (or equivalent). Migration required.
- Frontend control: small toggle in the annotation editor's settings/preferences area labeled "VLM-FO1 smart filter (beta)" with a tooltip that explains the trade-off (more accurate, slower, requires server support).
- The toggle is **hidden** when `vlm_fo1_available=false` from the capabilities endpoint.
- `apps/web/src/components/annotation/AutoAnnotateDialog.tsx` — same toggle (reads/writes the same user preference), so toggling in either surface stays in sync.
- `apps/web/src/api/...` — add the flag to the relevant request payloads (`/sam/text-prompt` proxy, Auto-annotate batch).

### Failure handling
- **FO1 not loaded yet**: pass through SAM 3 proposals unfiltered, return with `vlm_fo1_filtered=false`. Client UX should treat this as "less precise — the user may need to manually trim."
- **FO1 OOM**: catch and degrade to passthrough; log once per minute. Mark for eviction.
- **FO1 timeout** (default 6s/image): same as OOM.
- **FO1 returns no matches**: legitimate result. Return empty list — better than passing through false positives.
- **Empty SAM 3 proposals**: skip FO1 entirely; return empty.

### Observability
- Latency metrics: `sam3_text_prompt_ms` (existing) + `vlm_fo1_filter_ms` (new) + `vlm_fo1_proposals_in` / `vlm_fo1_proposals_out` (new).
- Status endpoint exposes `vlm_fo1_loaded`, `vlm_fo1_dtype`, `vlm_fo1_quant` so the UI can show "smart filtering on" badge.
- Log structured event on every filter call: `{"text": ..., "n_in": N, "n_out": M, "ms": T}`.

### Testing strategy
- **Unit:** mock `Sam3Model` output; verify FO1 wrapper produces filtered indexes (mock the LLM generation to return canned token strings).
- **Integration:** docker-compose-up the model service with `VLM_FO1_ENABLED=1`, hit `/sam/text-prompt` with a fixture image, assert response shape and filter activation.
- **Regression:** capture 10 prompts that previously failed and assert FO1 path returns ≥ 1 correct mask each.
- **Performance:** measure end-to-end latency at K=64 proposals on RTX 3090/4090. Acceptance: P95 latency under 4s on 4-bit quant; document the cost so users can disable for batch jobs.
- **A/B harness:** allow `use_vlm_fo1=false` per request to compare with/without FO1 on the same image.

## Open questions

1. **License.** VLM-FO1 repo has no LICENSE file. We need to (a) ask Om AI Lab to clarify, (b) decide whether to vendor any code, (c) confirm the HF model weights are usable in an AGPL-3 product. Until resolved, the integration ships behind `VLM_FO1_ENABLED=0` and is not advertised.
2. **bitsandbytes vs bf16.** 4-bit cuts VRAM ~2× but adds ~10–30% latency and may regress quality. Default to bf16; expose `VLM_FO1_QUANT=4bit` for users with tight VRAM.
3. **Top-K cap.** Reference uses 100; our 64 default is a guess. Need empirical tuning on real festival/sports/wildlife images.
4. **Thresholds.** Lowering SAM 3's score threshold to 0.20 increases FO1 input volume and latency. Tune jointly with K.
5. **Logo path.** Out of scope here, but a follow-up spec should add SigLIP 2 reference-bank classification for logo crops, layered on top of FO1 results.

## Out-of-scope follow-ups (nice-to-have, separate specs)
- SigLIP 2 reference-bank for logos.
- Grounding DINO 1.5 / YOLO-World as a parallel proposer (compare vs SAM 3 proposals on recall).
- Gemma 3 / Gemma 4 as a prompt parser ("find Nike logos and the players wearing them" → list of structured queries).
- VLM-FO1 video tracking (the upstream demo exists; out of scope per user request).

## Acceptance criteria
- With `VLM_FO1_AVAILABLE=0` (default): zero behavior change. `/sam/text-prompt`, Auto mode, and the editor look exactly as today. No latency regression. No new model weights downloaded. The editor toggle is hidden.
- With `VLM_FO1_AVAILABLE=1` and per-user toggle on: `/sam/text-prompt` and Auto mode return filtered, higher-precision results on a fixture set.
- Per-request `use_vlm_fo1=false` always wins over the user preference (explicit beats implicit).
- License posture documented and approved before public release.
- Idle eviction returns the model service to baseline VRAM within 5 minutes of inactivity.
- All new code paths covered by unit + integration tests; existing SAM 3 tests unaffected.
- Auto mode (`auto_text.py`) honors the toggle for every class iteration, not just the first.
