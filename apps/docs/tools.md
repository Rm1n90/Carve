# Annotation tools

> © Armin Mehri — [mehri.armin@gmail.com](mailto:mehri.armin@gmail.com) · [github.com/Rm1n90/Carve](https://github.com/Rm1n90/Carve)

All tools operate on the annotation canvas (Chrome, WebGL2 required). Select a tool from the toolbar on the left side of the canvas.

## Bbox tool

Draw a bounding box by clicking and dragging. Once drawn, select the box to resize or move it. Assign a class from the class panel.

## Polygon tool

Click to place vertices one by one. Double-click or press **Enter** to close and commit the polygon. Press **Esc** to cancel the current polygon in progress.

## Mask brush

Paint a freehand mask with an adjustable radius slider. Right-click (or hold the erase modifier) to erase painted pixels. Useful for irregular regions where a polygon would be tedious.

## SAM tool

Click on the image to place positive points (left-click) or negative points (right-click) as SAM prompts. The server runs the SAM 2 encoder once per image and the browser decoder produces a mask prediction after each click. Press **Enter** to commit the predicted mask as an annotation, or **Esc** to discard and reset the prompts.

## SAM track

After committing a SAM mask on a video frame, use SAM track to propagate the mask across adjacent frames using SAM 2 video tracking. Results are added as draft annotations on each propagated frame.

## Tag tool

Assigns a class label to the entire image without drawing any geometry. Used for image-level classification tasks.

## SAM 3 text prompts

Text-prompt support requires SAM 3 to be enabled by an admin. See [Admin & operations](./admin#sam-3-toggle) for the setup steps.
