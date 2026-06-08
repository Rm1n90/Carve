# Client-side SAM decode (CVAT-style encoder/decoder split)

Status: DESIGN — not yet implemented. Author: Armin Mehri. Date: 2026-06-08.

## CRITICAL CORRECTION (2026-06-08, runtime-verified) — image clicks = SAM 3

The earlier "SAM 3.1 only" framing was WRONG. Verified facts:

- Our interactive image/click path (`build_sam3p1_image_predictor` ->
  native `build_sam3_image_model`) **hardcodes**
  `download_ckpt_from_hf(version="sam3")` -> **`sam3.pt`**. The image
  builder has no `version` param — it can only load SAM 3.
- `facebook/sam3.1` ships ONLY `sam3.1_multiplex.pt` — a **video
  object-multiplex** checkpoint (different architecture). It drives our
  VIDEO tracking path, not image clicking. **There is no SAM 3.1 image
  model.**
- Runtime confirms the image model loaded `models--facebook--sam3/.../sam3.pt`.
- So `SAM_MODEL=sam3.1` only changes video tracking; ALL image annotation
  (the primary use) is SAM 3.

DECISION (Armin confirmed): client-side **click** decode uses the **SAM 3**
image/tracker decoder, which matches the `sam3.pt` weights the click tool
already runs. Source: `onnx-community/sam3-tracker-ONNX` (SAM 3) or
re-export from `facebook/sam3`. The Stage-0 golden parity test compares
client decode against the CURRENT SAM 3 server `/sam/decode`. Do NOT target
`facebook/sam3.1` for image decode.

## Problem

Interactive SAM annotation runs **both** the encoder and the decoder
server-side, per click, on the GPU, against a **single sticky embedding**
(`cached_image_hash` on the one resident predictor). Consequences:
- every click from every user is a GPU job → contention, queueing;
- two users on different images clobber each other's embedding → 409
  thrash (see [[project_sam_single_embedding]]);
- per-click GPU load scales with users.

The admission-queue fix (commit `1be3070`, [[project_gpu_admission_queue]])
made concurrency *safe* but not *cheap*: SAM 3.1 clicks still hit the GPU.

## How CVAT avoids all of it (verified in cvat-ai/cvat@develop)

- Server (Nuclio GPU fn) runs **only the encoder** and returns the image
  **embedding blob** to the browser (`serverless/.../sam/nuclio/main.py`,
  `model_handler.py`; `numWorkers: 1`).
- Browser (`cvat-ui/plugins/sam`) runs the **decoder** via
  **onnxruntime-web in a Web Worker** (`inference.worker.ts`), feeding
  `image_embeddings`, `point_coords`, `point_labels`, `mask_input`.
  Embeddings cached in a browser **LRU keyed by `${taskID}_${frame}`**
  (max 32). Every click decodes **locally** — no server, no GPU.

Result: GPU only does the (stateless, once-per-image) encode; per-click
decode is free and local; the encode is stateless so concurrent users
never collide.

## Feasibility (researched against Meta/HF primary sources, 2026-06-08)

| Mode | Client decode? | Source / contract |
|---|---|---|
| **SAM 2** click/box | feasible, mature | `samexporter` / `SharpAI/sam2-*-onnx`. Encoder out: `image_embed [1,256,64,64]` + `high_res_feats_0 [1,32,256,256]` + `high_res_feats_1 [1,64,128,128]`. Input 1024. |
| **SAM 3** click/box (Tracker/PVS head — what image clicks actually run) | feasible, export exists | `onnx-community/sam3-tracker-ONNX` (`vision_encoder.onnx` + `prompt_encoder_mask_decoder.onnx`, SAM 3 weights = same `sam3.pt` lineage). Embed `[1,256,72,72]` + hi-res at 288/144. Input 1008. The Tracker head is "SAM2 with the same API" (`SAM3InteractiveImagePredictor`). NOTE: no SAM 3.1 image model exists — see CRITICAL CORRECTION above. |
| **SAM 3.1** text/concept/visual (PCS / `Sam3Model`, DETR) | NO — stays server-side | No separable per-click decoder by design. Handled by the existing one-shot server path + admission queue. |

UNVERIFIED RISKS (must close in Stage 0):
1. RESOLVED (runtime-verified): image clicks run **SAM 3** (`sam3.pt`); no
   SAM 3.1 image model exists. Use the **SAM 3** tracker decoder
   (`onnx-community/sam3-tracker-ONNX`). Parity test vs the SAM 3 server
   decode. (Earlier "re-export from sam3.1" is void — see CRITICAL
   CORRECTION above.)
2. Exact ONNX input **node names** in `prompt_encoder_mask_decoder.onnx`
   (transformers.js API confirmed; raw graph not inspected).
3. Whether a **transformers-exported** SAM 2 decoder exists (so the server
   encoder = transformers `Sam2Model` matches the browser decoder). If
   not, run the ONNX `vision_encoder` server-side too (Option A below).

## Encoder-source decision (the load-bearing choice)

The server encoder MUST produce embeddings the browser decoder accepts.

- **Option A — run the bundle's own `vision_encoder.onnx` server-side**
  (onnxruntime-gpu), for both models. Encoder/decoder are compatible **by
  construction** (same export). Cost: add `onnxruntime-gpu` dep + a second
  resident encoder model in VRAM (separate from the native sam3 concept
  model used for text). RECOMMENDED — lowest correctness risk.
- **Option B — run torch encoders** (transformers `Sam2Model` /
  `Sam3TrackerModel.get_image_features`) and rely on the ONNX decoder being
  exported from the same source. Reuses existing torch stack, but requires
  proving numeric parity per model.

DECISION: **Option A**, gated by a Stage-0 parity test. Rationale: "no
mistakes" — by-construction compatibility beats per-model parity proofs.

## Architecture

```
Open image / pick click tool
  -> POST /sam/encode  (server, GPU, ONCE per image)
       runs vision_encoder.onnx for the active interactive model
       -> returns { image_hash, shape, encoder_id, input_size, tensors:{...} }
  -> browser caches tensors in LRU keyed (assetId, frameId, encoder_id)

Each click  (browser, local, per click)
  -> Web Worker: decoder.onnx(image_embed, high_res_feats*, point_coords,
                 point_labels, mask_input, has_mask_input)
       -> masks[1,K,256->orig], iou[1,K], low_res[1,K,256,256]
  -> pick best, derive polygon/RLE locally, preview + commit
  -> NO server call

Fallbacks (any of: no WebGPU+wasm, decoder file missing, encoder_id
unsupported, decode throws, embedding cache miss) -> existing server
/sam/decode path (unchanged). Zero functionality loss.

Text / concept / visual  -> unchanged server-side one-shot + admission queue.
```

### Model-service `/sam/encode` response (extended, back-compat)

Existing fields kept. New structured payload (illustrative/synthetic):
```jsonc
{
  "image_hash": "...",
  "shape": [h, w],
  "encoder_id": "sam2.1-large" | "sam3.1-tracker",   // selects browser decoder
  "input_size": 1024,                                  // or 1008; for point scaling
  "tensors": {                                          // null when client-decode unavailable
    "image_embed":      {"b64":"...","dtype":"float16","shape":[1,256,64,64]},
    "high_res_feats_0": {"b64":"...","dtype":"float16","shape":[1,32,256,256]},
    "high_res_feats_1": {"b64":"...","dtype":"float16","shape":[1,64,128,128]}
  }
}
```
`tensors: null` (or omitted) => browser falls back to server decode. Old
`embedding_b64` retained until SAM2 client path replaces it.

### Browser
- `apps/web/src/canvas/sam/decoder.worker.ts` — NEW Web Worker; lazy
  `onnxruntime-web` (already a dep, 1.20.1); one `InferenceSession` per
  `encoder_id`; `INIT`/`DECODE` messages (mirror CVAT's worker).
- `apps/web/src/canvas/sam/embeddingCache.ts` — NEW per-(asset,frame,
  encoder_id) LRU (cap ~16; each item ~10-21 MB float16). Evict oldest.
- `apps/web/src/canvas/sam/decoder.ts` — replace the throwing stub:
  real feed (scale points to `input_size`, pass `mask_input` for
  refinement) + output parse (masks->RLE/polygon reusing existing
  `samConvert`/`polygon-approx`). Keep `canDecodeLocally()` gate.
- `apps/web/src/canvas/tools/SamTool.ts` — branch in `addClick`/`setBox`/
  `popLastClick`: when `localDecodeReady` AND embedding cached for the
  active `encoder_id`, decode locally; else server. Mirror the existing
  abort/409-resync/loading semantics. Text mode unchanged.
- Decoder `.onnx` files served from `apps/web/public/models/`:
  `sam2.1-large.decoder.onnx`, `sam3.1-tracker.decoder.onnx` (+ wasm in
  `/assets/` per onnxruntime-web).

### Model service
- `onnxruntime-gpu` dep (Option A).
- New encode path: load the matching `vision_encoder.onnx`, preprocess
  (resize to input_size, normalize ImageNet mean/std), run, return tensors
  (float16 to halve payload).
- The interactive encoder is a SEPARATE resident model from the native
  sam3 concept model; lifecycle/VRAM budgeting per [[project_gpu_admission_queue]].
- A provisioning script:
  - **SAM 3** (image clicks): `onnx-community/sam3-tracker-ONNX`
    (`vision_encoder.onnx` + `prompt_encoder_mask_decoder.onnx`) — SAM 3
    weights, matching the `sam3.pt` the click path runs. (No SAM 3.1 image
    model exists.)
  - **SAM 2**: `SharpAI/sam2-hiera-large-onnx` (or `samexporter` from the
    sam2.1-large checkpoint we already run).
  - places encoders in the model-service encoder dir + decoders in web
    `public/models/`.

## Correctness guard (the "no mistakes" safety net)

**Golden parity test (Stage 0, blocking):** for a fixed image + fixed
click sequence (1 pos, 1 pos+1 neg, box, box+refine), the **client-side
decoded mask** must match the **current server-side `/sam/decode` mask**
within an IoU tolerance (>=0.98) for BOTH encoder_ids. If parity fails, the
split is wrong — do not ship. Implemented as a Node+onnxruntime test that
feeds a server-produced embedding through the browser decoder and compares.

## Edge cases to cover (every one gets a test)

- Variant switch (sam2 <-> sam3.1): invalidate embedding cache by
  `encoder_id`; first click re-encodes.
- Frame change (video): cache keyed per frame; scrub re-encodes.
- Embedding cache miss / eviction -> silent re-encode (no user error).
- WebGPU absent -> wasm EP; both absent -> server fallback.
- Decoder file missing / 404 -> server fallback (HEAD probe already exists).
- Decode throws (bad shapes, OOM in tab) -> server fallback + log.
- Point scaling: 1024 vs 1008 input; box as labels 2/3; negatives; padding -1.
- Refinement: pass previous `low_res_masks` as `mask_input`,
  `has_mask_input=1`; first click `has_mask_input=0`.
- Concurrency: two users same image -> each browser its own cache; server
  encode is stateless (no sticky clobber). Different images -> no collision.
- SAM 3.1 text/concept/visual -> untouched (server) + queue.
- Commit semantics identical to today (polygon >=3 else mask_rle).

## Build stages (TDD; each stage green before the next)

0. **Provision + parity** — download/inspect ONNX bundles; pin exact tensor
   node names (Netron/onnx.load); write the golden parity test. BLOCKING.
1. **Model service encode** — onnxruntime-gpu; encoder load + preprocess;
   extended `/sam/encode` returning `tensors`+`encoder_id`+`input_size`;
   keep server `/sam/decode` intact. Unit + parity tests.
2. **Browser decoder** — Web Worker + onnxruntime-web; embedding LRU; real
   `decoder.ts`; unit tests with a tiny fixture ONNX.
3. **SamTool wiring** — local-vs-server branch, all edge cases + fallbacks;
   vitest.
4. **Provisioning script + docs** — operator setup; VRAM budget notes.
5. **Live multi-user verification** — 10 concurrent click sessions: GPU
   shows only encodes, decode is local, no failures.

## Non-goals
- Client-side TEXT/concept/visual (impossible for the PCS head).
- Removing the server `/sam/decode` path (kept as the universal fallback).

## Stage 0 — VERIFIED ONNX contract (onnx-community/sam3-tracker-ONNX, 2026-06-08)

Inspected the real graphs (`onnx.load`, external data not loaded). Repo is
PUBLIC (no HF token). Files: `onnx/vision_encoder.onnx(+_data)`,
`onnx/prompt_encoder_mask_decoder.onnx(+_data)` (+ fp16/q4/int8/... variants).

**vision_encoder.onnx** (server, GPU, once per image)
- input:  `pixel_values` FLOAT `[B,3,1008,1008]`
- outputs (3): `image_embeddings.0`, `image_embeddings.1`, `image_embeddings.2`

**prompt_encoder_mask_decoder.onnx** (browser, per click)
- inputs:
  - `input_points` FLOAT `[B,1,num_points,2]`  (point coords in 1008-space)
  - `input_labels` INT64 `[B,1,num_points]`     (1 fg, 0 bg; box corners 2/3)
  - `input_boxes`  FLOAT `[B,num_boxes,4]`
  - `image_embeddings.0` FLOAT `[B,32,288,288]`
  - `image_embeddings.1` FLOAT `[B,64,144,144]`
  - `image_embeddings.2` FLOAT `[B,256,72,72]`
- outputs:
  - `iou_scores` FLOAT `[B,N,3]`
  - `pred_masks` FLOAT `[B,N,num_masks,H,W]`
  - `object_score_logits` FLOAT `[B,N,1]`

**Preprocessing (preprocessor_config.json):** `do_resize` to 1008x1008,
`do_normalize` with **mean=[0.5,0.5,0.5], std=[0.5,0.5,0.5]** (NOT ImageNet —
this corrects the earlier draft). `image_size: 1008`.

**Payload:** the 3 feature maps = 32*288^2 + 64*144^2 + 256*72^2 = 5.31M
floats ~= 21.2 MB fp32 / ~10.6 MB fp16 per image. Ship fp16.

**IMPORTANT — no `mask_input`/`has_mask_input`.** Unlike SAM 1/2 CVAT
decoders, this decoder has NO iterative mask-feedback input. Refinement =
re-run with the FULL accumulated point set each click. Our server path uses
mask_input for refinement, so multi-click masks may differ slightly — the
golden parity test must compare BOTH single-click and multi-click cases and
decide whether the no-mask_input client refinement is acceptable (likely
yes; it's the transformers Sam3Tracker contract). SAM 2 contract (separate,
has mask_input) still to be verified in its own Stage 0 pass.

### PARITY RESULTS (2026-06-08) — point clicking PASSES; box -> server fallback

ONNX encoder(fp16)+decoder(fp32) vs LIVE native server `/sam/decode`
(sam3.pt), SAM truck image:

| Case | IoU vs server | Verdict |
|---|---|---|
| single positive | 0.9912 | PASS |
| two positive (refine) | 0.9876 | PASS |
| positive + negative (refine, track-prev selection) | 0.9863 | PASS |
| box only | 0.54 | DIVERGES -> server fallback |

**CRITICAL DESIGN RULE — mask selection (no mask_input, so replicate it
statelessly):** the decoder always returns 3 candidate masks.
- **First click** (no previous mask): pick **best by `iou_scores`**.
- **Refinement clicks** (a previous mask exists): pick the candidate with
  the **highest IoU to the previously-shown mask** — NOT best-by-score.
  This reproduces the server's `mask_input` tracking. Verified: for
  positive+negative, best-by-score picks the wrong (collapsed, 53k) mask
  (IoU 0.084 vs server) while track-prev picks the right one (IoU 0.986).
  The client always has the previous mask in hand, so this is free.

**Box prompts diverge** (none of the 3 candidates match the server's box
mask; box has no previous mask to track). Decision: **box prompts use the
server `/sam/decode` fallback** (boxes are far rarer than clicks, and the
server path is concurrency-safe post-1be3070). Revisit box client-decode
later if needed.

Conclusion: ALL point clicking (single/multi positive + negative
refinement) decodes faithfully in the browser; box falls back to server.
Pipeline confirmed: 1008px resize, mean=std=0.5, point->1008-space, 3
embeddings by name, decoder out 288x288 upscaled, selection rule above.

### SAM 2.1 PARITY (2026-06-08) — PASS (same approach as SAM 3)

The transformers-exported `onnx-community/sam2.1-hiera-large-ONNX` has the
SAME contract family as the SAM 3 tracker (NOT the samexporter shape): same
input/output names, 3 embeddings, and **NO mask_input** — so the SAME
track-prev selection rule applies. Differs only in: input **1024** (vs
1008), **ImageNet** normalization (mean=[0.485,0.456,0.406],
std=[0.229,0.224,0.225]), embedding sizes `image_embeddings.0/1/2` =
`[*,32,256,256]`,`[*,64,128,128]`,`[*,256,64,64]`.

Parity vs live server on sam2.1-large (switched for the test, then restored
to sam3.1):

| Case | IoU | Verdict |
|---|---|---|
| single positive | 0.9907 | PASS |
| two positive (refine) | 0.9891 | PASS |
| positive+negative (refine, track-prev) | 0.9895 | PASS |
| box only | 0.9105 | server fallback |

So BOTH variants are proven: SAM 3 (`encoder_id="sam3.1"`, 1008px, 0.5 norm)
and SAM 2.1 (`encoder_id="sam2.1-large"`, 1024px, ImageNet norm). Same client
decoder logic (no mask_input, track-prev, 3-embedding feed, multimask pick),
parameterized by encoder_id. Box -> server fallback for both.

STAGE 0 COMPLETE. Next: Stage 1 (server `/sam/encode` returns the 3
embeddings + encoder_id + input_size + norm params).

### STAGE 1 COMPLETE (2026-06-08) — server encode endpoint

New module `apps/model/src/carve_model/sam/onnx_encoder.py` owns the encoder
half (preprocess -> run -> serialise). `/sam/encode` now also returns
`encoder_id`, `input_size`, `norm{mean,std}`, and `tensors{name:{b64,
dtype:"float16", shape}}` for the 3 feature maps; all are `null` together when
client decode is unavailable, so the browser falls back to the (untouched)
server `/sam/decode`. Key points:

- `ENCODER_SPECS` registry keyed by SAM_MODEL value: `sam3.1` (1008px, mean=
  std=0.5, `onnx-community/sam3-tracker-ONNX`) and `sam2.1-large` (1024px,
  ImageNet, `onnx-community/sam2.1-hiera-large-ONNX`). Other variants ->
  `encoder_id_for(...)` returns `None` -> server fallback.
- `preprocess` reproduces the Stage-0 parity script byte-for-byte (PIL
  bilinear resize, /255, per-channel `(x-mean)/std`, transpose to NCHW
  float32). `serialize_tensor` ships fp16 to halve the payload.
- Real ONNX loading is **opt-in via env `SAM_CLIENT_ENCODE=1`** (default off):
  keeps the second resident encoder model opt-in per deploy and stops tests
  from downloading weights. A `set_test_encoder` seam injects a fake in tests.
  Resident sessions are cached per `encoder_id` and evicted on encode error
  (CUDA-context loss won't pin a dead session forever).
- The encode handler runs the ONNX encode under the existing admission slot
  and captures the active model name *inside* the variant lease, so a
  concurrent `/sam/switch` cannot mismatch `encoder_id` against the embedding.
- Dep `onnxruntime-gpu==1.20.1` added to the `[gpu]` extras (CUDA 12 / cuDNN 9
  base image; matches browser `onnxruntime-web@1.20.1`).
- Tests: `apps/model/tests/sam/test_onnx_encoder.py` (12, all green); the rest
  of the SAM suite shows 0 new regressions.

### STAGE 2 COMPLETE (2026-06-08) — browser decoder

Built under `apps/web/src/canvas/sam/` (vitest, 32 tests green, `pnpm tsc`
clean). The old single-`sam2_decoder.onnx` scaffold was replaced.

- `float16.ts` — base64 fp16 -> Float32Array (the decoder takes fp32 feeds).
- `embeddingCache.ts` — per-`(asset, frame, encoder_id)` LRU (cap 16) so two
  users on different images never share embeddings; `cachedEmbeddingsFromEncode`
  returns `null` (server fallback) when the encode carried no tensors;
  `invalidateEncoder` resets on a variant switch.
- `decoder.ts` — pure, ORT-free (so it unit-tests without WASM). Owns the
  numeric contract: `scalePromptToInput` (per-axis sx/sy to input_size, int64
  labels, empty boxes), `candidateMasksFromLogits` (logit>0 + nearest resize to
  original size), `selectCandidate` (**the Stage-0 track-prev rule** — first
  click best-by-`iou_scores`, refinement = highest IoU to the previous mask),
  and `decodeWithRunner` (injected session). Output `counts` reuses the existing
  `canvas/maskio` `encodeRLE` (server-identical column-major format). Polygon
  extraction is deferred — the editor commits the RLE as a `mask_rle`
  annotation (same kind the mask brush produces), so there's no functionality
  loss; a client contour tracer is a follow-up.
- `ortRunner.ts` — onnxruntime-web adapter (feeds -> Tensor, parse outputs),
  session + `Tensor` injected so it unit-tests. `workerHandler.ts` — the
  message protocol (SET_EMBEDDINGS / DECODE / EVICT / CLEAR) + a worker-side
  embedding store so per-click DECODE messages carry only the points, not the
  ~10-21 MB maps. `decoder.worker.ts` — thin shell that dynamic-imports ORT and
  wires `onmessage` (the only piece not unit-tested — real Worker + ORT).
- `onnx.ts` — `decoderUrlFor` + `canDecodeLocally(encoderId?)`. NOTE: gated on
  decoder-file presence, NOT WebGPU — onnxruntime-web's WASM EP is a valid
  fallback (corrects this spec's earlier WebGPU-required wording).
- `api/sam.ts` — `SamEncodeResult` extended with `encoder_id` / `input_size` /
  `norm` / `tensors` (optional, back-compatible).

Box prompts and any decode error / cache miss stay on the server `/sam/decode`
fallback (unchanged). Stage 3 wires this into `SamTool` + spawns the worker.

### STAGE 3 COMPLETE (2026-06-08) — SamTool wiring

`apps/web/src/canvas/sam/decoderClient.ts` (NEW) bridges the main thread to the
worker: lazy spawn, id-correlated DECODE responses, Promise API with
AbortSignal, injectable `spawn` for tests. `SamTool` now:

- on `activate()`, builds `cachedEmbeddingsFromEncode(enc)`, stores it in the
  `embeddingCache` + hands it to the worker (`setEmbeddings`), and sets
  `localDecodeReady = await canDecodeLocally(encoder_id)`;
- `addClick` / `popLastClick` try `tryLocalDecode` first, falling through to the
  server `/sam/decode` for box prompts, unprovisioned variants, cache misses, or
  any worker error — so there is no functionality loss;
- replays the previous mask (`prevMask`) into the worker for the track-prev
  rule; resets local state on `reset` / `setMode` / `invalidateEncoding` (the
  last also evicts the worker's copy).

The existing 409 re-encode / 503 loading-retry / abort semantics are preserved.
Tests (41 web tests green, `tsc` clean) cover local-vs-server selection, box
fallback, error fallback, and the prevMask replay.

**API proxy: no change required.** `apps/api` `sam_encode` returns the model
service JSON verbatim and `/{asset_id}/sam/encode` returns a bare `dict` (no
`response_model`), so `tensors` / `encoder_id` / `input_size` / `norm` already
reach the browser.

Remaining: Stage 4 (provision the decoder `.onnx` files into
`apps/web/public/models/` + ORT wasm; enable `SAM_CLIENT_ENCODE=1`) and Stage 5
(live multi-user verification). Until Stage 4, the decoder files 404 →
`canDecodeLocally` is false → the click flow uses the server path, so Stage 3 is
safe to ship "dark".

### STAGE 4 COMPLETE (2026-06-08) — provisioning

`apps/model/scripts/provision_sam_decoders.py` provisions the browser assets:

- Downloads each variant's `prompt_encoder_mask_decoder.onnx` (+ external
  `_data`) and re-saves it inline as a single self-contained file →
  `apps/web/public/models/sam3.1.decoder.onnx` /
  `sam2.1-large.decoder.onnx`. We ship the **fp32** decoder — the exact graph
  the Stage-0 parity validated — so client masks match the server (~22 MB each,
  cached after first load). onnxruntime-web can't auto-fetch `_data` sidecars by
  URL, hence the inline re-save.
- Copies onnxruntime-web's `*.wasm` + loaders to
  `apps/web/public/models/ort/`; the worker sets
  `ort.env.wasm.wasmPaths = "/models/ort/"` (self-hosted, no CDN) and
  `numThreads = 1` (works without COOP/COEP cross-origin isolation; WebGPU is
  the fast path when available).
- `--check` verifies presence without downloading; `--prewarm-encoders`
  optionally pulls the server-side vision encoders into the HF cache.
- The decoder/wasm binaries are git-ignored (`apps/web/public/models/*.onnx`,
  `.../ort/`) — fetched at deploy, not tracked.

Operator turn-on: run the script, set `SAM_CLIENT_ENCODE=1` on the model
service, restart it. VRAM: client encode adds one resident fp16 vision encoder
(~0.9 GB) per active variant beside the native SAM model; decode then never
touches the GPU.

Only **Stage 5** remains: live 2+ user verification (different images, SAM 3.1)
that the GPU shows only encodes, clicks decode locally, and there is no
thrash/error — that requires running the script + a real browser.

## Sources
SAM2: github.com/vietanhdev/samexporter; HF SharpAI/sam2-hiera-large-onnx;
github.com/lucasgelfond/webgpu-sam2. SAM3: github.com/facebookresearch/sam3;
HF docs model_doc/sam3 (concept=DETR) + model_doc/sam3_tracker (PVS,
points/boxes, image_embeddings reuse); HF onnx-community/sam3-tracker-ONNX.
CVAT: cvat-ai/cvat serverless/.../sam/nuclio/* + cvat-ui/plugins/sam/*.
