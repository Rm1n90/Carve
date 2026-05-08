# SAM Visual Prompt — Design Spec

**Date:** 2026-05-08
**Author:** Armin Mehri
**Status:** Draft (approved for plan)
**Track:** Auto-Annotate v3.28

---

## 1. Problem

Auto-Annotate today is text-only: each project class carries a `text_prompt`, and SAM 3 runs `/sam/text-prompt` per class. That works when classes have linguistically distinctive names ("hard hat", "forklift") but fails on:

- Visually-defined classes the user can't easily describe in language ("the shape on the conveyor", a specific defect).
- Domains where the project's classes are coded names with no semantic content.
- Cases where one well-chosen example beats five iterations of prompt wording.

YOLOE's Smart Find already ships a **Visual Prompt** mode for exactly this case (pick reference annotations across the task, find similar objects). This spec adds the same capability to SAM-based Auto-Annotate so the user can run **SAM-only** on visual exemplars and get clean polygon output without bringing the YOLOE checkpoints into the workflow.

## 2. Goals

1. New "Visual Prompt" tab in the Auto-Annotate dialog (sibling of "Text Prompt").
2. Multi-source, multi-class reference picking with the same UX patterns the YOLOE Visual Prompt mode established.
3. Reference type toggle — **bbox XOR polygon** per run.
4. Sync ("this image") and batch ("all assets in task") scopes with the existing RQ batch progress / cancel / background UX.
5. Pure-SAM execution: native SAM 3.1 PCS (Promptable Concept Segmentation) using `visual_prompt_embed`. No YOLOE dependency.

## 3. Non-goals

- Cross-task / project-wide reference picking. Stays task-scoped, like YOLOE Visual Prompt.
- Per-frame video reference picking. Same constraint as YOLOE Visual Prompt: image assets only as sources.
- Mixed bbox+polygon refs in a single run. Single toggle picks the type for the whole run.
- SAM 2 / SAM 3 transformers support. Visual Prompt requires SAM 3.1 native variant.

## 4. UX

### 4.1 Dialog layout

`AutoAnnotateDialog` becomes a 2-tab layout matching `YoloeDialog`:

| Tab | Body |
|---|---|
| **Text Prompt** | Existing controls: class checklist, threshold, find mode, scope, FO1, post-process. |
| **Visual Prompt** (new) | Reference-type toggle, source thumbnail strip, per-source ref list with auto-class assignment, scope, threshold, find mode, overwrite. |

The Auto-Annotate trigger button keeps the existing label (Wand2 icon, "Auto-Annotate"). The dialog title remains "Auto-annotate".

### 4.2 Reference picker

`VisualReferencePicker` is extracted from `YoloeDialog.tsx` into a shared component:
`apps/web/src/components/annotation/VisualReferencePicker.tsx`

It owns:
- Source asset thumbnail strip (image-only assets in the current task that have refs of the active type).
- Per-source ref list, with the same toggle-checkbox / class-assignment row layout YOLOE uses.
- Picks summary chip ("N picks · M sources · K classes").
- Empty / loading states.

Inputs (new):
- `refKindFilter: "bbox" | "polygon" | undefined` — restricts picker to one geometry type. `undefined` keeps the YOLOE behavior (both kinds visible).
- `picks` / `onChange` controlled state (parent owns the map).

Both `YoloeDialog` and `AutoAnnotateDialog` consume it. The YOLOE behavior (bbox-or-polygon, polygon→bbox flatten on send) is preserved by passing `refKindFilter=undefined` and the existing geometry flatten in the YOLOE wire builder. SAM passes a concrete `refKindFilter`.

### 4.3 Reference type toggle

A small two-pill segmented control above the picker:

```
Reference type:  [ Bbox ] [ Polygon ]
```

- Default: `bbox`.
- Switching the toggle clears all current picks. Show a confirm modal when switching with a non-empty pick set.
- The thumbnail strip's pick-count badge counts only refs of the active type.
- The picker hides refs of the other type entirely (not greyed-out — they're not legal in this run).

### 4.4 Scope, threshold, find mode, overwrite

Same controls as the Text tab (and same wire-level meaning).

## 5. Architecture

### 5.1 Layered overview

```
AutoAnnotateDialog (web, Visual tab)
  └─ VisualReferencePicker (shared)
       └─ picks: { (assetId, refId) → { class_id, kind, geometry } }

samApi.autoVisual(assetId, payload)        — sync, single asset
samApi.autoVisualBatch(taskId, payload)    — async RQ enqueue
samApi.autoVisualBatchProgress / Cancel    — same shape as autoTextBatch*

apps/api/src/carve_api/inference/
  router.py
    POST /sam/auto-visual/{asset_id}       — sync
    POST /sam/auto-visual-batch/{task_id}  — enqueue
    GET  /sam/auto-visual-batch/{task_id}/{job_id}     — poll
    POST /sam/auto-visual-batch/{task_id}/{job_id}/cancel
  auto_visual.py (new)                     — auto_visual_for_asset(...)
  sam.py                                   — sam_visual_prompt_for_asset(...)
  batch.py                                 — kind=sam_auto_visual worker

apps/model/src/carve_model/sam/
  router.py                                — POST /sam/visual-prompt
  sam3p1_adapter.py
    Sam3p1NativeImagePredictorAdapter.set_visual_prompt(...)  (NEW)
  sam3_adapter.py
    make_sam3_visual_predictor()           — factory
  predictor.py
    _VISUAL_PREDICTOR_FACTORY + get_visual_predictor()
```

### 5.2 Data shape — wire payload

```ts
type SamVisualRef =
  | { kind: 'bbox'; xyxy: [number, number, number, number] }
  | { kind: 'polygon'; points: [number, number][] };

type SamVisualGroup = { class_id: string; refs: SamVisualRef[] };
type SamVisualSource = { asset_id: string; groups: SamVisualGroup[] };

interface SamAutoVisualBody {
  sources: SamVisualSource[];
  ref_kind: 'bbox' | 'polygon';   // server-side validation: every ref matches
  threshold: number;
  find_all: boolean;
  overwrite: boolean;
}
```

`ref_kind` is redundant with the per-ref `kind` field but explicit so the server can reject mixed payloads with a clean 422 (`mixed_ref_types`) without inspecting every ref.

### 5.3 Run flow (sync, "this image")

1. Frontend builds `sources` from picks (group by `(asset_id, class_id)`), POST to `/api/sam/auto-visual/{target_id}`.
2. API fetches **target asset bytes once** and **each source asset bytes once** from MinIO.
3. For each `(source_asset, class_id)` group, API calls `POST /model/sam/visual-prompt` with `{ refer_b64, region_list, target_b64 }`.
4. Model service:
   a. `set_image(target)` — backbone over target.
   b. For each ref in `region_list`: `set_image(refer)` then `compute_visual_prompt_embed(region)` → list of per-ref embeddings.
   c. Pool the embeddings (mean) → single `visual_prompt_embed` for the class.
   d. `_forward_grounding(state, encode_text=False, visual_prompt_embed=pooled)` → masks + scores + boxes.
5. API filters by `threshold`, applies `find_all` / best-only, persists annotations under `class_id`.
6. Apply the same `overwrite` safety used by `auto_text_for_asset` (delete only after computing all new rows; scope strictly to selected class IDs).

### 5.4 Run flow (batch, "all assets in task")

Same wire payload + a target-asset loop in the RQ worker. Per-asset commits (cancel-safe). Progress / cancel / background mirrors `auto-text-batch`.

### 5.5 Native SAM 3.1 visual prompt setter

New method on `Sam3p1NativeImagePredictorAdapter`:

```python
def set_visual_prompt(
    self,
    refer_image: np.ndarray,            # HxWx3 uint8 RGB, the source asset
    region: dict,                       # {"kind": "bbox", "xyxy": [...]}
                                        # OR {"kind": "polygon", "points": [...]}
    *,
    fusion_mode: str = "dense_plus_global",   # see §5.6.1
    pad_ratio: float = 0.15,                  # see §5.6.2
    multi_scale: bool = True,                 # see §5.6.3
    tta_hflip: bool = False,                  # off by default; opt-in via env
) -> np.ndarray:
    """Return a pooled visual_prompt_embed for the region.

    bbox: pool backbone features over the bbox-aligned grid cells.
    polygon: rasterise polygon to a binary mask at the backbone feature
             resolution, then masked-mean pool feature vectors where
             the mask is True.

    The returned embed is the fused dense + global vector described in
    §5.6.1. The caller stacks per-ref embeds and means across exemplars.
    """
```

Per-ref pseudocode (the per-ref output is the input to multi-exemplar mean):

```python
# 1. Preprocess: crop with padding + aspect-preserving square pad (§5.6.2).
crop, region_local = preprocess_refer(refer_image, region, pad_ratio=pad_ratio)

# 2. Backbone forward at native input resolution.
backbone_out = self._processor.set_image(pil(crop))

# 3. Multi-scale dense features (§5.6.3): pull both the highest-res FPN
#    stage AND a coarser one. Both are used; we don't average them.
dense_hi, dense_lo = get_image_features_multi_scale(backbone_out)
# dense_hi: (H_hi, W_hi, D), dense_lo: (H_lo, W_lo, D)

# 4. Build feature-resolution mask from region_local (bbox grid OR
#    rasterised polygon downsampled to feature resolution).
mask_hi = build_region_mask(region_local, dense_hi.shape[:2])
mask_lo = build_region_mask(region_local, dense_lo.shape[:2])

# 5. Dense pool — masked mean per scale, L2-normalised.
dense_vec_hi = l2norm(masked_mean(dense_hi, mask_hi))   # (D,)
dense_vec_lo = l2norm(masked_mean(dense_lo, mask_lo))   # (D,)
dense_vec    = l2norm(0.5 * (dense_vec_hi + dense_vec_lo))   # (D,)

# 6. Global pool — whole-crop mean (or backbone CLS token if available).
global_vec = l2norm(masked_mean(dense_hi, ones_like(mask_hi)))    # (D,)

# 7. Fuse (§5.6.1).
fused = fuse_dense_global(dense_vec, global_vec, mode=fusion_mode)  # (D,)

# 8. Optional TTA: horizontal flip, repeat 1–7, mean and re-L2-norm.
if tta_hflip:
    fused_flip = encode_with_hflip(...)
    fused = l2norm(0.5 * (fused + fused_flip))

return fused
```

The fused per-ref `(D,)` is appended to the class's exemplar list. After all refs for a class are encoded, the multi-exemplar pool is the L2-normalised mean of the per-ref vectors. The result becomes the `visual_prompt_embed` slot:

```python
visual_prompt_embed = pooled[None, None, :]           # (1, 1, D) shape match
visual_prompt_mask  = torch.ones(1, 1, dtype=bool)    # one valid concept
```

Text features are replaced by the dummy "visual" embedding the SAM 3.1 native package already supports for vision-only mode (verified at `sam3_image_processor.py:140`).

### 5.6 Preprocessing & feature design — accuracy levers

#### 5.6.1 Dense + global fusion

Dense (region-pooled) features capture **part-level appearance**; global (whole-crop) features capture **object identity / context**. PCS-style models behave noticeably better when both signals are combined, especially when the refer region is small (dense features are noisy) or large (global features wash out part detail).

Two fusion modes, selected via the `fusion_mode` argument:

| Mode | Operation | When |
|---|---|---|
| `dense_plus_global` (default) | `fused = l2norm(α · dense + (1 − α) · global)` with `α = 0.7` | Default — dense-led blend, robust across small/large refs. |
| `concat` | `fused = l2norm(concat(dense, global))` then project back to D via a fixed linear layer | Reserved for a possible future learned projection. **Not implemented in v1** to keep the path checkpoint-free. |

`α` is tunable via the `SAM_VISUAL_PROMPT_ALPHA` env var (default `0.7`). The default value is documented; the env exists so we can A/B test on real tasks without a redeploy.

#### 5.6.2 Crop with context padding + aspect-preserving square pad

Encoding the bare bbox crop is a known PCS failure mode: the encoder loses scene context and over-fits to the central pixels. Mitigations:

1. **Context expansion**: enlarge the region by `pad_ratio` (default `0.15` = 15 %) on each side, clipped to image bounds. Recorded as `region_local` in expanded crop coordinates so the mask still aligns.
2. **Aspect-preserving square pad**: pad the expanded crop with replicate-edge pixels (NOT zeros — zero-padding biases backbone activations) so the input is square before resize. SAM 3.1's processor resizes to its native input size; feeding a stretched rectangle distorts feature geometry.
3. **Min-size guard**: if the original region is < 32 px in either dimension, expand the crop to at least 64×64 with replicate padding. SAM 3.1's backbone has stride 16; sub-stride regions otherwise pool from 1–2 cells of noise.

Polygon-specific:
- Rasterise polygon at full crop resolution first, **then** downsample to feature-map resolution with bilinear → threshold. Gives smoother feature-grid coverage than rasterising at feature resolution directly (verified standard practice in detection codebases).

#### 5.6.3 Multi-scale dense features

SAM 3.1's image backbone exposes a Hiera FPN. We pull dense features from two scales:
- **High-res** — finest stage available (typically stride 16). Captures part detail.
- **Low-res** — coarsest segmentation-relevant stage (typically stride 32). Captures shape / object-level structure.

Per-scale pool first (so each scale's mask covers the same physical region), then average. Empirically this is more robust than concatenating across scales when the refer region size varies.

#### 5.6.4 L2 normalisation discipline

Every aggregation step ends in L2 normalisation:
- Per-scale dense pool
- Cross-scale dense average
- Global pool
- Final fused vector
- Cross-exemplar mean

Without it, large-magnitude exemplars dominate the cross-ref mean. The downstream `_forward_grounding` doesn't itself L2-normalise the visual prompt slot.

#### 5.6.5 Test-time augmentation (off by default)

Optional horizontal-flip TTA: encode the refer crop normally and flipped, average the per-ref vectors. Improves accuracy ~1–2 % on shape-rotation-invariant classes; doubles refer-side encode cost. Off by default; opt-in via `SAM_VISUAL_PROMPT_TTA_HFLIP=1`. The `tta_hflip` parameter exists in the adapter signature so a future UI toggle can plumb it through without touching internals.

#### 5.6.6 What we are NOT doing (and why)

- **Vertical-flip / rotation TTA** — not natural for object orientation; usually hurts.
- **Random-color augmentation** — backbones we use are already trained with strong color aug; runtime aug doesn't help.
- **Self-attention on the dense map before pool** — adds compute without measurable gain at our typical region sizes.
- **Cross-image self-similarity refinement** — would require running the encoder across the target's tile bank; out of scope, defer until perf trace shows headroom.

### 5.7 Capability gate

`samStatus()` already returns `variant`. Add a derived flag:

```json
{
  "variant": "sam3p1",
  "visual_prompt_available": true,
  ...
}
```

`visual_prompt_available = (variant == "sam3p1")`. The Visual tab is hidden when `false`. The legacy SAM 2 / SAM 3 transformers paths return 409 `sam3p1_not_enabled` if invoked directly.

## 6. Error handling

| Code | Status | Where |
|---|---|---|
| `sam3p1_not_enabled` | 409 | `/sam/visual-prompt`, `/sam/auto-visual/*` when variant ≠ sam3p1 |
| `mixed_ref_types` | 422 | API when payload contains refs of both kinds |
| `no_refs` | 422 | API when `sources` is empty after group/class filter |
| `no_class_assignment` | 422 | API when any group has empty `class_id` |
| `polygon_degenerate` | 422 | API when polygon has < 3 points or zero area |
| `sam_predictor_not_loaded` | 503 | Model service; lazy-rebuild on first hit (matches text path) |
| `model_service_unreachable` | 502 | API → frontend toast |

Frontend toasts mirror the existing auto-text error map.

## 7. Testing

### 7.1 Model service

`apps/model/tests/sam/test_sam3p1_visual_prompt.py` (new):
- `test_set_visual_prompt_bbox_pool_shape` — verifies returned embed has shape `(D,)`.
- `test_set_visual_prompt_polygon_masks_background` — bbox embed differs from polygon embed on the same shape (mask actually applied).
- `test_multi_exemplar_pool_is_mean_l2_normed` — feeding two refs returns the L2-normed mean of their L2-normed per-ref embeds.
- `test_visual_prompt_runs_without_text` — `_forward_grounding` produces masks with text-disabled state.
- `test_visual_prompt_returns_polygon_when_polygonize_succeeds` — same polygon shaping the text path uses.
- `test_dense_plus_global_default_is_alpha_0_7` — fused vector equals `l2norm(0.7 * dense + 0.3 * global)` with stub features.
- `test_alpha_env_override` — `SAM_VISUAL_PROMPT_ALPHA=0.5` flips the blend weight.
- `test_multi_scale_pool_uses_two_stages` — fused dense vector is the L2-normed mean of two per-scale L2-normed pools, not just the highest-res.
- `test_crop_padding_expands_region` — region with `pad_ratio=0.15` expands by 15 % each side and clips to image bounds.
- `test_aspect_preserving_square_pad_uses_replicate` — non-square crop is padded with replicate-edge, not zeros (verify boundary pixel equality).
- `test_min_size_guard_expands_tiny_region` — a 16×16 region is expanded to at least 64×64 before encode.
- `test_polygon_rasterise_then_downsample_smoother_than_direct` — comparison check: rasterise-then-downsample retains more True cells than rasterise-at-feature-resolution for a thin shape.
- `test_tta_hflip_off_by_default` — without env, encode is called once per ref.
- `test_tta_hflip_env_runs_twice` — `SAM_VISUAL_PROMPT_TTA_HFLIP=1` doubles the encode count and averages.
- `test_l2_normalisation_at_every_aggregation_step` — intermediate vectors all have unit norm (within fp tolerance).

### 7.2 API service

`apps/api/tests/inference/test_auto_visual.py` (new):
- `test_auto_visual_creates_polygons_per_class` — happy path.
- `test_overwrite_safe_when_no_matches` — zero-match doesn't wipe existing rows (parity with v3.7.2 / auto-text safety).
- `test_overwrite_scoped_to_selected_classes` — other classes' annotations untouched.
- `test_threshold_filters_below_minimum`.
- `test_find_all_vs_best_only`.
- `test_multi_source_dispatch` — refs spanning two source assets each get one model call per (source, class).
- `test_mixed_ref_types_rejected` — 422.
- `test_no_class_assignment_rejected` — 422.
- `test_sam3p1_required` — 409 on other variants.

### 7.3 Frontend

`apps/web/tests/auto-annotate-visual.test.tsx` (new):
- Tab switch hides text controls and shows visual picker.
- Reference-type toggle filters picker and clears picks (with confirm modal).
- Auto-class assignment fills the source class on first pick.
- Run button disabled until ≥1 pick AND every pick has a class.
- Scope toggle disabled when no `taskId`.
- Run wires `samApi.autoVisual` for "this", `autoVisualBatch` for "all".
- Batch progress overlay reuses the existing `BatchProgressView` shape.
- Visual tab hidden when `samStatus().visual_prompt_available === false`.

`apps/web/tests/visual-reference-picker.test.tsx` (new) — unit tests for the extracted shared component.

### 7.4 E2E

Extend the existing AutoAnnotate Playwright spec with one Visual Prompt run on an image-task fixture.

## 8. Open questions

None blocking. Future work that can ship later:

- **Per-frame video sources** — picking a single video frame's annotations as a ref. Out of scope for this spec; same constraint YOLOE Visual Prompt has today.
- **Visual + text combined concept** — SAM 3.1 supports text + visual concept fusion. Could be a "use class text_prompt to refine the visual concept" toggle in a future iteration. Not in this spec.
- **Embedding cache for refer assets** — pooled embeds for the same `(asset_id, region_hash)` can be cached. Defer until the batch path shows it matters in the perf trace.

## 9. File touch list

**New**:
- `apps/web/src/components/annotation/VisualReferencePicker.tsx`
- `apps/web/tests/visual-reference-picker.test.tsx`
- `apps/web/tests/auto-annotate-visual.test.tsx`
- `apps/api/src/carve_api/inference/auto_visual.py`
- `apps/api/tests/inference/test_auto_visual.py`
- `apps/model/tests/sam/test_sam3p1_visual_prompt.py`

**Modified**:
- `apps/web/src/components/annotation/AutoAnnotateDialog.tsx` — tab layout
- `apps/web/src/components/annotation/YoloeDialog.tsx` — consume shared picker
- `apps/web/src/api/sam.ts` — `autoVisual`, `autoVisualBatch`, etc.
- `apps/api/src/carve_api/inference/router.py` — new routes
- `apps/api/src/carve_api/inference/sam.py` — `sam_visual_prompt_for_asset`
- `apps/api/src/carve_api/inference/batch.py` — sam_auto_visual kind
- `apps/model/src/carve_model/sam/router.py` — `/sam/visual-prompt` + status flag
- `apps/model/src/carve_model/sam/sam3p1_adapter.py` — `set_visual_prompt`
- `apps/model/src/carve_model/sam/sam3_adapter.py` — visual factory
- `apps/model/src/carve_model/sam/predictor.py` — visual factory registry
