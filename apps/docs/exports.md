# Imports & exports

> © Armin Mehri — [mehri.armin@gmail.com](mailto:mehri.armin@gmail.com) · [github.com/Rm1n90/Carve](https://github.com/Rm1n90/Carve)

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
- Segmentation exported as polygon point lists or RLE depending on annotation type.
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
