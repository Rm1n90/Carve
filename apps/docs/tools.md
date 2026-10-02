# Annotation tools


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

## Logo AI

Detects logos with a hosted vision LLM (Anthropic or OpenAI) and saves them as bounding boxes. The **Logo AI** button appears in the editor toolbar for workspace admins once a provider key is configured — see [Admin & operations](./admin#logo-ai). Images are sent to the provider you select.

- **Logos to find** — one row per class. The class name is what the model looks for, so name classes after the brand; the optional description narrows it ("white wordmark on a red disc"). A single class described as "any brand logo" boxes every logo regardless of brand.
- **Reference examples** — pick a few existing boxes per class. Their crops are sent with every request as examples, which is the largest accuracy gain for brands the model does not know.
- **Model and effort** — effort is how much the model reasons before answering. Reasoning is billed as output and is the largest part of the cost above *Low*. Start at *Low*: on a photo with 40 sponsor logos, GPT-6.1 Sol at Low found the same logos as High in an eighth of the time and at a sixth of the cost. Raise it only if boxes are missed. Not every model is available through a provider's batch API (OpenAI's does not take GPT-6.1 Sol yet, whatever its model page says; GPT-6 Sol, same price, is the one to use for Batch); the dialog greys out *Batch* for such a model.
- **Confidence and visibility** — the model gives each box a confidence and an estimate of how much of the logo is in view (cut by the frame, covered by a hand, wrapped around a sleeve). Boxes under either slider are left out. The default drops logos less than half visible; the estimate varies by a few points between runs, so move the slider rather than expect a hard edge.
- **Image detail** — the most megapixels sent per request, for realtime and batch runs alike. Larger images are shrunk to it (on the model's patch grid, so the returned coordinates map back exactly); smaller ones are sent as they are. The default, *Standard* (1.2 MP), found the same logos as full size on a dense 1080×1920 test photo for 43% fewer image tokens. *Low* (0.6 MP) loosens the boxes on small logos; *High* and *Max* are for images where the logos are only a few pixels across.
- **Small-logo scan** — sends the full frame plus overlapping crops of a large image and merges the results. Finds small logos a single downscaled view loses, at up to 5× (2×2) or 10× (3×3) the requests.
- **Scope and delivery** — *This image* runs immediately. *All assets* and *Range* start a run: **Realtime** processes it now; **Batch** submits it to the provider's batch API at half the price, with results usually within the hour and at most 24 hours later. OpenAI also offers **Flex** pricing for realtime runs (half price, slower).

**Double-check.** On by default for realtime and single-image runs: after detection, a second request shows a model every box enlarged, one numbered tile each, and it scores each from 0 to 100. Boxes scored under 40 (stripes, laces, blurred text, a whole wheel) are dropped, and the score becomes the box's confidence, so the run's confidence threshold and the filter in the editor work on the close look rather than on the detection's own guess. The check model and its effort can be chosen; the default (GPT-6 Sol at low effort for OpenAI) is the one that tested best: on 278 boxes it removed about half of the wrong ones and lost about 2% of the real logos. GPT-6.1 Sol, the better model for detection, was too lenient as a checker; GPT-6 Luna is ten times cheaper but lost about twice as many real logos and varied between runs. More effort did not help any of them. The second pass adds 50–100% to the cost. Batch runs have no second pass.

**Reviewing by score.** Wrong boxes and real logos overlap in the lower scores, so a threshold strict enough to remove the wrong ones takes real ones with it. The filter button next to **Logo AI** therefore also has *Review*: it shows only the boxes scored under a value (0.90 by default) and the arrow keys then jump between the images that have any, so a person looks at a fraction of the boxes and deletes the wrong ones. The Runs tab shows how many boxes each run's second look rejected.

**Filtering after a run.** Every box Logo AI writes keeps its confidence and visibility scores, so thresholds can be changed afterwards without running (and paying for) the images again. Run once with loose values, then open the filter button next to **Logo AI**: moving its two sliders hides, live on the canvas, the boxes that would go, and shows how many the current image and the whole task would keep. *Remove* deletes them for this image or for the task; that is permanent. Boxes you drew, edited or accepted are never counted or removed — reshaping or relabelling a Logo AI box makes it yours and clears its scores. The same scores are available in the editor's annotation filter as *Confidence* and *Visible %*, e.g. `Confidence < 0.7` to step through the images that contain doubtful boxes.

Runs continue on the server when the dialog or the browser is closed, and a batch's results are collected automatically. A run also survives the machine being switched off, a lost internet connection or the provider being down: it waits, shows what it is waiting for in the **Runs** tab, and carries on by itself. The **Runs** tab shows every run, single-image ones included, with its progress, how long it took, the tokens billed (input, cached, output, reasoning) and what it cost. The cost shown before a run is an estimate: once the task has a run with the same model and effort, it is based on what those requests actually cost, so run one image first.
