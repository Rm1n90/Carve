# Imports & exports


## YOLO export

Exports a zip archive that Ultralytics trains from as it is, with each image and its label side by side:

```
<project>_<task>/
  data.yaml
  classes.json            # class ids, names and colours
  README.md
  training_data/
    train/<stem>.jpg
    train/<stem>.txt
    val/...
    test/...
```

With a single split, `train/`, `val/` and `test/` are left out and every split in `data.yaml` points at `training_data/`. `data.yaml` has no `path:`, so the splits resolve against its own folder whichever directory you train from.

- Supports task types: **detect** (bbox), **segment** (polygon/mask), **classify** (tag).
- Each `.txt` file contains one annotation per line in normalised YOLO format.
- **Masks in a segmentation export** (ground, crowds, objects split by something in front of them, ring ropes) are written as one polygon per annotation: every piece and every hole is joined by zero-width cuts, so each annotation stays one instance with its holes open. Filled back, the label covers the mask: on real Carve masks, 99.9% of the mask is covered and 98% of the label is mask. Specks under 9 px are dropped. Outlines are simplified by at most 1.5 px, so they stay within the 1000 points Ultralytics keeps per instance. A mask of hundreds of separate pieces that can't fit is written as a few instances of neighbouring pieces. Boxes in a segmentation export become rectangles: convert them with SAM before exporting.
- **Training a segmentation model on these labels:** set `overlap_mask=False`. The annotations nest (a person with garments on top, a car with its wheels, a net with what is behind it), and the default overlap mode gives each pixel to the smallest instance only.
- **Splits:** configure `train` / `val` / `test` as floats that sum to 1.0. All frames of one clip land in the same split, so validation never scores near copies of training images. A clip is a video's extracted frames (`race.mp4 — frame 00012.jpg`), or a sequence named with its frame number (`FE3_10000.jpg`, `GIROITALIA55.jpg`). Clips are dealt to the splits in a fixed pseudo-random order, so the same images always give the same split, and the shares come out as asked. A clip bigger than half the smallest share is cut into runs of consecutive frames first. That covers a very long video, or a camera's `IMG_xxxx` photos read as one clip.

## COCO export

Exports a single `coco.json` with the standard COCO structure:

```json
{
  "images": [...],
  "annotations": [...],
  "categories": [...]
}
```

- Bounding boxes exported as `[x, y, width, height]`. A box annotation also gets its rectangle as `segmentation`, since COCO readers expect one on every annotation. For mask training, convert boxes with SAM first.
- Category ids run `1..N` (COCO ids start at 1): the YOLO class id plus one. Every exported class is a category, with or without annotations.
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
