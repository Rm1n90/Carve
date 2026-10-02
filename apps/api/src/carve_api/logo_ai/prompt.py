# Armin Mehri — mehri.armin@gmail.com
"""The prompt and the strict output schema.

The prompt is split where it changes:

* **Stable prefix** — the annotation rubric, the target classes and the
  optional reference crops. Identical for every request of a run, so
  both providers cache it and bill re-reads at 5–10% of the input
  price. Nothing request-specific may leak into it: one differing byte
  and the cache never hits.
* **Per-request suffix** — the image to annotate and one line giving
  its size.

The rubric is deliberately thorough. It is the only instruction the
model gets about what a usable training box is, and because it is
cached its length is nearly free after the first request. Keep it above
the providers' minimum cacheable prefix (512 tokens on current Claude
models, 1,024 on OpenAI) even for a single class with no description:
below the minimum nothing is cached and every request pays for the
whole prompt at the full input rate.
"""

from __future__ import annotations

from dataclasses import dataclass

from carve_api.logo_ai.catalog import COORDS_GRID999, COORDS_PIXEL

_RUBRIC = """\
You are annotating images for a logo-detection training set. Your boxes are \
used directly as ground-truth labels for training an object detector, so \
three things matter, in this order. First, every box is on a real logo: a \
box on a stripe, a shoelace or a blur teaches the detector that those are \
logos, and that does more damage than a logo left out. Second, every logo \
that can be read or recognised gets a box. Third, every box hugs the logo's \
visible ink tightly. Nobody looks at the image alongside your answer, so the \
list you return is the whole result.

## What counts as a logo
A logo is the designed mark that identifies a brand or organisation, as it \
appears in the scene: a symbol or emblem, a stylized wordmark, or the two \
together as one lockup. Logos turn up on products and packaging, storefronts \
and signage, clothing and shoes, vehicles, sports kits and pitch-side boards, \
screens and posters, stickers, and watermarks or overlays burned into the \
image itself.

The test for every candidate is identification: looking at it, you can read \
its lettering, or you recognise its symbol as the emblem of a particular \
brand or organisation (whether or not you know its name). Something that \
merely sits where a logo would sit, or looks printed, does not pass.

Count a mark that passes the test, including when it is:
- small or distant, as long as it can still be read or recognised;
- low-contrast (embossed, tone-on-tone, stitched);
- partly hidden, cut by the image edge, folded, or wrapped around a curved \
surface;
- rotated, mirrored, seen in perspective, or in a colour variant \
(white-on-black, monochrome, outline only);
- repeated: a pattern of the same mark, a row of identical cans, a logo on \
both the shirt and the cap. Each instance gets its own box.

Do not box:
- the design of the product itself. Stripes, bands, panels, piping, \
stitching, laces, soles, mesh and perforations, colour blocks, checks, \
camouflage, gradients and other patterns on shoes, clothing, helmets, \
gloves, bicycles, wheels, cars and equipment are styling, not logos. A shape \
without lettering is a logo only when it is the emblem of a brand you can \
identify, such as a swoosh; "some lines on a shoe" or "a pattern on a \
sleeve" is not;
- anything too blurred, too small or too dark to pass the identification \
test: out-of-focus lettering in the background, a smudge where a logo \
probably is, a few pixels of something printed. If you cannot read it and \
cannot recognise it, leave it out, even when you can guess from the context \
what it must be;
- numbers and names that are not a brand's mark: race, bib and jersey \
numbers, athlete names, dates, scores, prices, clock and watch dials;
- the brand name set in ordinary running text (a caption, a paragraph, a \
list of ingredients). Only the designed mark counts;
- the product or object carrying the logo. The box is the mark, never the \
bottle, shirt, car, wheel, ball or shoe it is on;
- national flags, traffic signs, generic icons and decorative shapes that \
are not a brand's identity;
- logos of brands outside the target classes listed below, unless a class is \
explicitly described as a catch-all for any logo.

## How to look
Scan the whole image before answering, including the edges, the background, \
and cluttered or reflective areas where marks hide: shelves behind the \
subject, hoardings, vehicle sides, clothing tags, screen contents. Small \
logos are the ones most often missed, so look at fine detail deliberately \
rather than only at the main subject.

Then check each candidate against the identification test before you list \
it. Do not use a low confidence as a way to include something doubtful: a \
mark you would only be guessing at is left out, not listed with a low number.

## Hard cases
- Lookalikes: a generic swoosh, star, crown, shield or initial is not a \
brand's mark unless its specific shape matches. Compare against the class \
description and any reference examples before boxing.
- Sportswear and equipment carry both: the maker's mark (box it) and the \
maker's styling (do not). On a shoe, the brand emblem or wordmark is a \
logo; the laces, the sole, the stripes of the upper and its colour panels \
are not. On a bicycle, the wordmark on the frame or rim is a logo; spokes, \
rim bands and frame graphics are not. On a jersey, sponsor marks are logos; \
the team's stripes, hoops, checks and colour blocks are not.
- Co-branding and sponsor walls: marks of several brands often sit side by \
side on jerseys, banners and press backdrops. Box each target mark on its \
own and ignore the others. A repeating backdrop can hold dozens of instances, \
and each one counts.
- A logo inside a larger printed design (a poster, an advertisement, a \
product label): box the mark itself, not the whole design.
- Product shapes and colour schemes (a distinctive bottle silhouette, a \
vehicle livery) are not logos on their own. Box only the mark printed on them.
- Reflections, mirrored glass, and screens showing the logo count when the \
mark is recognisable there.
- Very small marks: if you can read it or recognise whose it is, box it, \
even when the box is only a few pixels across. If you can only tell that \
something is printed there, leave it out.
- The same mark at several sizes (a large sign and a small tag): report all \
of them, not only the most prominent.

## Boxes
- One box per logo instance. Never merge two instances into one box, even \
when they touch or sit side by side.
- The box is the smallest axis-aligned rectangle containing all visible ink \
of the mark: no margin, no background plate, and no surrounding tagline \
unless the tagline is part of the official lockup.
- A symbol and a wordmark that sit together as one lockup are one box. If \
they are clearly apart (symbol on the chest, wordmark on the sleeve), they \
are separate instances.
- For a rotated or skewed logo the box stays axis-aligned and encloses the \
whole mark.
- For a partly hidden or cut-off logo, box only the portion that is visible.
{coords}

## Visibility
For every box, estimate what percentage of the whole mark is in view, judged \
against the mark as it would look unobstructed: 100 when all of it can be \
seen, less when part is cut off by the image edge, covered by a hand, an arm, \
another object or a fold of fabric, or wrapped around a surface so that part \
faces away. A ten-letter wordmark with five letters showing is about 50; a \
crest with a hand across a third of it is about 65. Report the partly hidden \
ones too rather than leaving them out: the percentage is used afterwards to \
decide which boxes to keep, so an honest low number is more useful than a \
missing box.

## Confidence
Give each box a confidence from 0 to 100 that it is a real logo of that class \
(it passes the identification test) and that the box is right:
- 90 and up: unmistakable: clearly legible lettering or a clearly recognised \
emblem.
- 70 to 90: read or recognised, with some blur, occlusion, or small size.
- 50 to 70: read or recognised only with effort.
Anything you could not put at 50 or more does not pass the test: leave it out.

## Output
Return every instance you find, in any order, one row of integers per \
instance:
{row}
If the image contains none of the target logos, return an empty list. That is \
a normal and common answer, and inventing a box to avoid it damages the \
dataset.

## Target classes
{classes}"""

_COORDS_TEXT = {
    COORDS_PIXEL: (
        "- Coordinates are integer pixels in the image exactly as provided, "
        "with the origin (0, 0) at the top-left corner, x increasing to the "
        "right and y increasing downward. `x1, y1` is the box's top-left "
        "corner and `x2, y2` its bottom-right corner, so x1 < x2 and y1 < y2. "
        "Each request states the image's width and height; stay within them."
    ),
    COORDS_GRID999: (
        "- Coordinates are integers on a 0 to 999 grid laid over the image as "
        "provided: x = 0 is the left edge and x = 999 the right edge, y = 0 "
        "the top edge and y = 999 the bottom edge, independently per axis "
        "whatever the aspect ratio. `x1, y1` is the box's top-left corner and "
        "`x2, y2` its bottom-right corner, so x1 < x2 and y1 < y2."
    ),
}

# A row is positional to keep the answer short: the JSON is billed as
# output, and at low effort it is most of what a request costs. Keyed
# objects spend about 30 tokens per box on names and punctuation; a row
# of integers about 14. With a single class the label would be the same
# number on every row, so it is left out.
_ROW_FIELDS = ("x1", "y1", "x2", "y2", "confidence", "visible")
_ROW_TEXT = {
    False: (
        "`[x1, y1, x2, y2, confidence, visible]`, for example "
        "`[412, 96, 530, 141, 95, 100]`."
    ),
    True: (
        "`[label, x1, y1, x2, y2, confidence, visible]`, where `label` is the "
        "number of the target class below, for example "
        "`[2, 412, 96, 530, 141, 95, 100]`."
    ),
}

REFERENCE_INTRO = (
    "Reference examples. Each crop below shows one confirmed instance of a "
    "target logo, labelled with its class. Use them to recognise the marks, "
    "including unfamiliar or local brands. They are not part of the image to "
    "annotate, so never return a box for them."
)

SCHEMA_NAME = "logo_detections"


@dataclass(frozen=True)
class TargetClass:
    """One class the model may assign, in prompt order (label = index + 1)."""

    class_id: str
    name: str
    description: str


def row_length(n_classes: int) -> int:
    """Integers per detection row: the label is only sent when there is
    more than one class to tell apart."""
    return len(_ROW_FIELDS) + (1 if n_classes > 1 else 0)


def build_system_text(classes: list[TargetClass], coords: str) -> str:
    lines = []
    for i, c in enumerate(classes, start=1):
        desc = " ".join((c.description or "").split())
        if desc and desc.lower() != c.name.lower():
            lines.append(f"{i}. {c.name}: {desc}")
        else:
            lines.append(f"{i}. {c.name}")
    return _RUBRIC.format(
        coords=_COORDS_TEXT[coords],
        row=_ROW_TEXT[len(classes) > 1],
        classes="\n".join(lines),
    )


def reference_label(index: int, cls: TargetClass) -> str:
    return f"Example of class {index} ({cls.name}):"


def build_request_text(width: int, height: int, *, is_tile: bool, coords: str) -> str:
    """The only text that differs between two requests of a run."""
    if coords == COORDS_PIXEL:
        text = f"The image above is the one to annotate. It is {width}x{height} pixels."
    else:
        text = "The image above is the one to annotate."
    if is_tile:
        text += (
            " It is a cropped region of a larger photo, so logos may be cut "
            "by its edges; box the visible part."
        )
    return text


def build_schema(n_classes: int, coords: str, *, numeric_bounds: bool) -> dict:
    """Strict JSON schema for the answer: a list of integer rows.

    Kept to keywords both providers' constrained decoders accept.
    ``numeric_bounds`` adds the row length and value range. OpenAI
    enforces them; Anthropic rejects a request that carries them, so
    there the row shape rests on the prompt and is checked when parsed.
    """
    row: dict = {"type": "array", "items": {"type": "integer"}}
    if numeric_bounds:
        row["minItems"] = row["maxItems"] = row_length(n_classes)
        if coords == COORDS_GRID999:
            # Every field fits: coordinates 0-999, percentages 0-100,
            # labels 1-100.
            row["items"] = {"type": "integer", "minimum": 0, "maximum": 999}
    return {
        "type": "object",
        "properties": {"detections": {"type": "array", "items": row}},
        "required": ["detections"],
        "additionalProperties": False,
    }


# The second pass. Detection sees the whole image, where a small mark is
# a handful of pixels; the check sees each candidate enlarged and only
# has to score it. It is what removes the boxes the detection confidence
# cannot: the model is as sure of a shoe's stripes as of a sponsor's
# wordmark until it is made to look at them one at a time. A score, not
# a yes/no, because the score separates better than the verdict did in
# testing and can be tightened afterwards without another request.
#
# The text is kept above 1,024 tokens on purpose: that is the shortest
# prefix OpenAI will cache, and a cached prefix is re-read at a tenth of
# the input price on every image of a run. Trimming it below that makes
# every check request pay for the whole prompt again.
_CHECK = """\
You are checking candidate boxes for a logo-detection training set. The image \
is a sheet of numbered tiles. Each tile is an enlarged crop from one photo, and \
the green rectangle in it marks one candidate; what is around the rectangle is \
only context.

A logo is the designed mark that identifies a brand or organisation: a symbol \
or emblem, a stylized wordmark, or the two together. The test is \
identification: you can read its lettering, or you recognise the symbol as the \
emblem of a particular brand or organisation.

For each tile give a score from 0 to 100: how sure you are that the green \
rectangle encloses a real logo of one of the target classes below.
- 90 to 100: a logo beyond doubt: clearly legible lettering, or an emblem you \
recognise at once (a swoosh, a team crest).
- 70 to 89: a logo that can be read or recognised with a little effort: small, \
slightly blurred, at an angle, or partly cut off.
- 40 to 69: could be a logo, but you cannot actually read it or say whose \
emblem it is.
- 0 to 39: not a logo: product styling (stripes, bands, panels, patterns, \
checks, piping, laces, soles, spokes, rims, wheel or frame graphics, ball \
panels, helmet vents, colour blocks); a blur or smudge; numbers or names that \
are not a brand's mark (race or jersey numbers, athlete names, clock dials); a \
whole object (a wheel, a ball, a shoe, a bottle) rather than a mark on it; a \
reflection, shadow, skin, hair or background; a mark that is not one of the \
target classes.
Judge what is inside the rectangle, not what the surrounding context suggests \
should be there. Well-known marks count even when they are only a shape: a \
swoosh, the three stripes of a sportswear brand, a team's cap insignia.

## How to judge a tile
Look at the rectangle first and ask what, exactly, is inside it. Then score \
that, using the cases below. Each tile is judged on its own: neighbouring \
tiles often show the same garment or vehicle, and one being a logo says \
nothing about the next.

Score high (70 and up):
- a wordmark you can read, even if it is small, curved around a sleeve or a \
bottle, upside down, mirrored, or set vertically along a frame or a leg;
- a wordmark with a few letters hidden or cut off, when the letters that show \
still identify it (the end of a sponsor name on a folded shirt);
- an emblem of a brand, club, league, federation or event that you recognise \
or that is plainly a designed crest or badge: a swoosh on a glove or a shoe, \
an insignia on a cap, a round maker's badge on a helmet, a crest on a ball;
- a sticker or tag carrying a brand's mark, on a cap, a tool, a device;
- a small maker's mark on a sock, a cuff, a collar, a saddle or a component, \
as long as its lettering or its shape is clear at this size.

Score low (under 40):
- bands of stripes, chevrons, hoops, dots or squares that repeat along a \
sleeve, a sock, a rim or a frame without spelling or depicting anything;
- a rectangle that takes in a whole wheel, a large part of a frame, a whole \
shoe, glove, ball or bottle: the mark, if there is one, is much smaller than \
the rectangle;
- the laces, sole, tongue or panels of a shoe; the vents or shell of a \
helmet; spokes, hubs, brake and gear parts; cables and levers;
- a patch of fabric, skin, hair, grass, road or sky; a fold, a seam, a \
shadow, a highlight or a reflection in glass or lenses;
- lettering so blurred or so small that it cannot be read at this size, \
however likely it is that a sponsor's name is printed there;
- a number on a rider, a player, a car or a bike; a name on a shirt or a \
bib; the figures of a clock, a scoreboard or a price.

Score in between (40 to 69) only for a mark that looks designed but that you \
can neither read nor place. Do not use the middle for things that are plainly \
not marks, and do not use it to hedge on a mark you can read.

The rectangle may be looser or tighter than the mark; that does not change \
the score as long as the mark is what it is on. A rectangle that holds two \
different marks is scored for the one it is centred on.

## What the score is used for
A box scored under 40 is deleted. A box scored 40 or more is kept as a \
training label, and its score is stored with it so that a stricter cut can be \
applied later. So a wrong high score puts a stripe or a blur into the \
training set, and a wrong low score throws away a real logo; both are \
errors. Give each tile the score you would stand by if someone opened that \
one crop next to your number.

Return one row per tile: `[tile number, score]`.

## Target classes
{classes}"""

CHECK_SCHEMA_NAME = "logo_checks"


def build_check_text(classes: list[TargetClass]) -> str:
    lines = []
    for i, c in enumerate(classes, start=1):
        desc = " ".join((c.description or "").split())
        named = desc and desc.lower() != c.name.lower()
        lines.append(f"{i}. {c.name}: {desc}" if named else f"{i}. {c.name}")
    return _CHECK.format(classes="\n".join(lines))


def build_check_request_text(n_tiles: int) -> str:
    return f"The sheet has {n_tiles} tile{'' if n_tiles == 1 else 's'}, numbered 1 to {n_tiles}."


def build_check_schema(*, numeric_bounds: bool) -> dict:
    """``{"scores": [[tile, score 0..100], ...]}``. As with detections,
    the row length and value range are only declared where the
    provider's decoder accepts them."""
    row: dict = {"type": "array", "items": {"type": "integer"}}
    if numeric_bounds:
        row = {
            "type": "array",
            "items": {"type": "integer", "minimum": 0, "maximum": 999},
            "minItems": 2,
            "maxItems": 2,
        }
    return {
        "type": "object",
        "properties": {"scores": {"type": "array", "items": row}},
        "required": ["scores"],
        "additionalProperties": False,
    }
