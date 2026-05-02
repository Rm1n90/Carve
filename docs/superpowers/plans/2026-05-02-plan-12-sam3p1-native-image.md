# Plan 12 — Native SAM 3.1 image predictor (Point + BBox + Text)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** finish the SAM 3.1 migration by routing the IMAGE side through the native `sam3` git package's image predictor (`build_sam3_image_model(enable_inst_interactivity=True)` + `Sam3Processor`), so point + bbox + text prompts on images all use SAM 3.1 with its runtime improvements (FA3 fallback to SDPA on Ampere/Ada, batched postprocessing, fused operators, `torch.compile`).

The video side already uses native multiplex (Plan 11 — `Sam3p1MultiplexVideoAdapter`). After this plan: with `SAM_MODEL=sam3.1`, the entire pipeline is on the native sam3 package.

## Native API summary

```python
from sam3 import build_sam3_image_model
from sam3.model.sam3_image_processor import Sam3Processor

model = build_sam3_image_model(
    bpe_path=f"{sam3_root}/assets/bpe_simple_vocab_16e6.txt.gz",
    enable_inst_interactivity=True,  # MANDATORY — enables point clicks
    compile=False,                   # opt-in via SAM_COMPILE
)
processor = Sam3Processor(model)

# Image cache:
state = processor.set_image(image_np_HWC_uint8)

# Point prompts (and/or box):
masks, scores, logits = model.predict_inst(
    state,
    point_coords=np.array([[x, y], ...]) | None,
    point_labels=np.array([1/0, ...]) | None,
    box=np.array([x1, y1, x2, y2]) | None,
    mask_input=prev_logits | None,
    multimask_output=True/False,
)

# Text prompt:
processor.set_text_prompt(text, state)
# → state now contains the per-detection masks/boxes; read out the highest-score mask(s).

# Reset between calls if switching prompt type:
processor.reset_all_prompts(state)
```

## Series context

- ✅ Plan 11 — SAM 3.1 multiplex video adapter
- **Plan 12 — Native SAM 3.1 image predictor** ← *this plan*

---

## Task 1: `Sam3p1NativeImagePredictorAdapter` + factory routing

**Files:**
- modify `apps/model/src/carve_model/sam/sam3p1_adapter.py` — add the new image adapter alongside the existing `Sam3p1MultiplexVideoAdapter`.
- modify `apps/model/src/carve_model/sam/predictor.py` — `_image_predictor_for(model_name)` (or wherever the existing factory dispatches by model name) routes `sam3.1` to the new adapter; `sam3` keeps the existing transformers `Sam3ImagePredictorAdapter`.
- modify `apps/model/src/carve_model/sam/sam3_adapter.py` — `make_sam3_text_predictor()` and `make_sam3_box_predictor()` need a sam3.1-aware variant (or new module-level factories `make_sam3p1_text_predictor()` / `make_sam3p1_box_predictor()`); these wrap `processor.set_text_prompt(...)` / `model.predict_inst(box=...)` respectively and expose the same callable signature the existing routes already invoke (`fn(image_b64=..., text=...)`, `fn(image_b64=..., boxes=..., box_labels=..., text=None)`).
- new `apps/model/tests/sam/test_sam3p1_image_adapter.py`

**Spec:**
- The new image adapter implements the existing `SamPredictor` protocol our routes rely on:
  - `set_image(image: np.ndarray) -> None` — calls `processor.set_image(image)`, caches the returned state on `self._state`. Also calls `model.set_image(image)` if needed.
  - `predict(point_coords, point_labels, multimask_output, box=None) -> (masks, scores, _)` — wraps `model.predict_inst(self._state, point_coords=..., point_labels=..., box=..., multimask_output=...)`. Returns `(masks, scores, logits)` — `logits` may be ignored downstream but the tuple shape matches the existing transformers adapter.
  - The image-encode path (`/sam/encode`) reads the cached state's `image_embed` if exposed by `set_image`; otherwise falls back to "no embedding cached" same as the existing fallback.
- Build via:
  ```python
  import sam3, os
  from sam3 import build_sam3_image_model
  from sam3.model.sam3_image_processor import Sam3Processor
  bpe = f"{os.path.dirname(sam3.__file__)}/../assets/bpe_simple_vocab_16e6.txt.gz"
  model = build_sam3_image_model(
      bpe_path=bpe,
      enable_inst_interactivity=True,
      compile=perf.get_compile_enabled(),
  )
  processor = Sam3Processor(model)
  ```
- The model is heavy — cache at module level (one instance per process).
- Apply `perf.get_dtype()` / `perf.apply_compile_to_image_encoder(model)` after construction.
- bf16 → numpy bridge via `perf.to_numpy_safe(...)` for any output tensor.

**Text predictor (`make_sam3p1_text_predictor`):**
- Returns a callable `fn(*, image_b64, text) -> list[dict]`. Each dict has `counts`, `size`, `score`, `polygon` matching the existing text-prompt route's `Sam3TextPromptOut` shape.
- Internally: decode base64 → numpy → `processor.set_image(image)` → `processor.set_text_prompt(text, state)` → read masks from state, encode each to RLE + Douglas-Peucker polygon (use the existing `encode_mask_rle` + `mask_to_polygon` helpers).
- Returns up to N candidates sorted by score descending.

**Box predictor (`make_sam3p1_box_predictor`):**
- Returns a callable `fn(*, image_b64, boxes, box_labels, text=None) -> list[dict]`.
- Internally: decode base64 → set_image → for each (box, label) pair, call `model.predict_inst(state, box=np.array(box), multimask_output=False)`. If `text` is also provided, do `processor.set_text_prompt(text, state)` first to bias.
- Negative box labels (`box_labels[i] == 0`) are subtracted from the positive set's union (mirrors the existing `Sam3VideoDispatcherAdapter`'s SAM 3 behavior).

### `predictor.py` factory change

Find the existing function that dispatches the image predictor by model name (search for `Sam3ImagePredictorAdapter`'s only call site, likely in a `_default_factory` or similar). Add:

```python
if model == "sam3.1":
    from carve_model.sam.sam3p1_adapter import build_sam3p1_image_predictor
    return build_sam3p1_image_predictor()
```

Same for `set_text_predictor` / `set_box_predictor` — when SAM 3.1 is selected, register `make_sam3p1_text_predictor()` / `make_sam3p1_box_predictor()`.

### Tests

**`test_sam3p1_image_adapter.py`:**
- Mock the native package classes (`build_sam3_image_model`, `Sam3Processor`) with stubs that mimic the API (`set_image` returns a dict; `predict_inst` returns `(masks, scores, logits)` tuples; `set_text_prompt` mutates state).
- Verify the adapter's `set_image()` calls the processor's `set_image()` once.
- Verify `predict(points, labels, multimask=True)` calls `predict_inst(state, point_coords=points, point_labels=labels, multimask_output=True)` and returns the tuple unchanged (after `to_numpy_safe`).
- Verify `predict(box=[x1,y1,x2,y2])` calls `predict_inst(state, box=...)`.
- Verify `predict_inst` raises `ValueError` cleanly when neither points nor box are supplied.
- Verify the text predictor: `fn(image_b64=..., text="person")` returns a list of `{counts, size, score, polygon}` dicts.
- Integration smoke: `pytest.importorskip("sam3")` + a tiny synthetic image; just ensure the model loads and `set_image` doesn't crash. Skip when `SAM3P1_AVAILABLE=0`.

## Constraints

- Don't break the existing transformers SAM 3 path (`SAM_MODEL=sam3` keeps using `Sam3ImagePredictorAdapter`).
- Keep `npx tsc --noEmit` clean (no FE changes needed).
- Run model tests:
  ```
  docker compose exec -e SAM3P1_AVAILABLE=1 model pytest apps/model/tests/sam/test_sam3p1_image_adapter.py -xvs
  ```
- Bind-mount issue: `tests/` isn't auto-mounted; use `docker compose cp` for new test files.

## Self-Review Checklist

- [ ] `SAM_MODEL=sam3.1` → image predictor is `Sam3p1NativeImagePredictorAdapter` (not transformers `Sam3ImagePredictorAdapter`).
- [ ] Point click on image → `predict_inst` with `point_coords`/`point_labels`.
- [ ] BBox drag on image → `predict_inst` with `box`.
- [ ] Text prompt on image → `processor.set_text_prompt(text, state)` returns masks.
- [ ] Video tracker → still uses `Sam3p1MultiplexVideoAdapter` (Plan 11).
- [ ] No regression in `SAM_MODEL=sam3` path (transformers).
- [ ] Tests pass.

## Tag

`v3.10.1 — Native SAM 3.1 image predictor (point/box/text)`
