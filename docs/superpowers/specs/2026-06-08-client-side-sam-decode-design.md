# Client-side SAM decode (CVAT-style encoder/decoder split)

Status: DESIGN — not yet implemented. Author: Armin Mehri. Date: 2026-06-08.

## CRITICAL CONSTRAINT — SAM 3.1 ONLY (not SAM 3)

Armin: **"the difference between SAM 3.1 and SAM 3 is only the weight
file."** Architecture is identical; only the checkpoint differs. Therefore:

- Both ONNX halves (`vision_encoder.onnx` AND
  `prompt_encoder_mask_decoder.onnx`) MUST be **re-exported from
  `facebook/sam3.1`** weights, using the same `Sam3Tracker` -> ONNX recipe
  that produced `onnx-community/sam3-tracker-ONNX`.
- `onnx-community/sam3-tracker-ONNX` is a **recipe/architecture reference
  ONLY** — do NOT ship its SAM-3 weights at runtime. SAM-3 decoder weights
  against a SAM-3.1 encoder = weight mismatch = wrong masks.
- The Stage-0 golden parity test runs against the **SAM 3.1** server decode,
  so any 3.0-vs-3.1 weight drift is caught before shipping.
- SAM 3.1 video/multiplex weights and the interactive Tracker weights both
  come from the 3.1 checkpoint; keep everything on `facebook/sam3.1`.

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
| **SAM 3.1** click/box (Tracker/PVS head) | feasible — RE-EXPORT from 3.1 | Recipe = `onnx-community/sam3-tracker-ONNX` (`vision_encoder.onnx` + `prompt_encoder_mask_decoder.onnx`); **weights from `facebook/sam3.1`, NOT SAM 3**. Embed `[1,256,72,72]` + hi-res at 288/144. Input 1008. The Tracker head is "SAM2 with the same API" (`SAM3InteractiveImagePredictor`). |
| **SAM 3.1** text/concept/visual (PCS / `Sam3Model`, DETR) | NO — stays server-side | No separable per-click decoder by design. Handled by the existing one-shot server path + admission queue. |

UNVERIFIED RISKS (must close in Stage 0):
1. RESOLVED (decision): **re-export both ONNX halves from `facebook/sam3.1`**
   via the `Sam3Tracker` -> ONNX recipe. Do NOT ship `onnx-community`'s
   SAM-3 weights (architecture-identical but wrong checkpoint). Stage 0
   verifies the 3.1 re-export against the 3.1 server decode (parity test).
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
  - **SAM 3.1**: re-exports `vision_encoder.onnx` + `prompt_encoder_mask_decoder.onnx`
    from **`facebook/sam3.1`** (transformers `Sam3Tracker` -> ONNX, same
    recipe as `onnx-community/sam3-tracker-ONNX`). NOT the SAM-3 weights.
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

## Sources
SAM2: github.com/vietanhdev/samexporter; HF SharpAI/sam2-hiera-large-onnx;
github.com/lucasgelfond/webgpu-sam2. SAM3: github.com/facebookresearch/sam3;
HF docs model_doc/sam3 (concept=DETR) + model_doc/sam3_tracker (PVS,
points/boxes, image_embeddings reuse); HF onnx-community/sam3-tracker-ONNX.
CVAT: cvat-ai/cvat serverless/.../sam/nuclio/* + cvat-ui/plugins/sam/*.
