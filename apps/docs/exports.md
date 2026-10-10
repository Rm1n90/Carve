# Imports & exports


## YOLO export

Exports a zip archive with the standard Ultralytics layout:

```
data.yaml
labels/
  train/<stem>.txt
  val/<stem>.txt
  test/<stem>.txt
images/           # optional, controlled by include_images flag
  train/<stem>.jpg
  ...
```

- Supports task types: **detect** (bbox), **segment** (polygon/mask), **classify** (tag).
- Each `.txt` file contains one annotation per line in normalised YOLO format.
- **Masks in a segmentation export** (ground, crowds, objects split by something in front of them, ring ropes) are written as one polygon per annotation: every piece and every hole is joined by zero-width cuts, so each annotation stays one instance with its holes open. Filled back, the label covers the mask: on real Carve masks, 99.9% of the mask is covered and 98% of the label is mask. Specks under 9 px are dropped. Outlines are simplified by at most 1.5 px, so they stay within the 1000 points Ultralytics keeps per instance. A mask of hundreds of separate pieces that can't fit is written as a few instances of neighbouring pieces. Boxes in a segmentation export become rectangles: convert them with SAM before exporting.
- **Training a segmentation model on these labels:** set `overlap_mask=False`. The annotations nest (a person with garments on top, a car with its wheels, a net with what is behind it), and the default overlap mode gives each pixel to the smallest instance only.
- **Splits:** configure `train` / `val` / `test` as floats that sum to 1.0. Assets are partitioned deterministically: `floor(n * train)` go to train, `floor(n * val)` to val, the remainder to test.

## COCO export

Exports a single `coco.json` with the standard COCO structure:

```json
{
  "images": [...],
  "annotations": [...],
  "categories": [...]
}
```

- Bounding boxes exported as `[x, y, width, height]`.
- Segmentation exported as polygon point lists or RLE depending on annotation type. Masks are uncompressed COCO RLE (`counts` as a list of integers), which pycocotools reads; a polygon's `area` is its own area. COCO imports accept RLE in all three forms (list, run text, compressed string).
- `include_images` flag bundles the image files alongside the JSON.

## Class remap

Before exporting you can remap the project's class palette to a different target schema. For each project class choose one of:

- **Map to** a destination class id and name (merge multiple project classes into one export class).
- **Skip** — exclude annotations of this class from the export entirely.

The remap configuration is saved per export so you can have different remaps for different export presets.

## Importing annotations

Supported import formats:

| Format | How to import |
|---|---|
| YOLO `.zip` | Upload a zip containing `labels/` and optionally `data.yaml` |
| COCO `.json` | Upload a bare JSON file |
| COCO `.zip` | Upload a zip containing a `coco.json` |

Imports match annotations to assets by filename. Classes are resolved by name against the project's class palette. Imported annotations are created as drafts for review before acceptance.
