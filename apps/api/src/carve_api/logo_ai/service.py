# Armin Mehri — mehri.armin@gmail.com
"""Per-asset orchestration shared by the sync endpoint and the jobs."""

from __future__ import annotations

import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field, replace
from io import BytesIO

from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation
from carve_api.assets.models import Asset, Frame
from carve_api.errors import AppError
from carve_api.inference.autoannotate import fetch_asset_bytes
from carve_api.logo_ai import catalog
from carve_api.logo_ai.detections import (
    BadModelOutput,
    Detection,
    merge_detections,
    parse_detections,
    to_original,
)
from carve_api.logo_ai.imaging import (
    CHECK_MAX_TILES,
    View,
    image_patches,
    load_image,
    plan_views,
    render_check_sheet,
    render_reference_crop,
    render_view,
)
from carve_api.logo_ai.prompt import (
    TargetClass,
    build_check_request_text,
    build_check_schema,
    build_check_text,
    build_request_text,
    build_schema,
    build_system_text,
)
from carve_api.logo_ai.providers.base import (
    ProviderClient,
    ProviderResult,
    Reference,
    RunContext,
    Usage,
)
from carve_api.projects.models import Class, Task

# Exemplars are re-read (at the cached rate) on every request, so a
# handful per class is the useful range.
MAX_REFERENCES = 16

# Text tokens per character, for the pre-run estimate only. On the low
# side for English prose, so the estimate does not claim the prompt
# prefix is long enough to be cached when it is borderline.
_TOKENS_PER_CHAR = 1 / 4.4
# Answer tokens per request when the task has no history: about ten
# boxes at ~14 tokens a row.
_EST_ANSWER_TOKENS = 150
# Per image, measured over 32 images (278 boxes) with GPT-6 Sol at low
# effort; the output is mostly reasoning.
_EST_CHECK_INPUT_TOKENS = 1100
_EST_CHECK_OUTPUT_TOKENS = 170
# Finished runs looked at when estimating from the task's own history.
_HISTORY_RUNS = 20


class LogoAiBadRequest(AppError):
    http_status = 422
    code = "logo_ai_bad_request"


@dataclass
class RunOptions:
    """A validated run request. Stored verbatim in ``LogoAiJob.params``."""

    provider: str
    model: str
    effort: str | None
    # [{"class_id": str, "prompt": str}] in prompt order.
    prompts: list[dict]
    # [{"class_id": str, "asset_id": str, "bbox": [x1, y1, x2, y2]}]
    references: list[dict] = field(default_factory=list)
    detail: str = catalog.DEFAULT_DETAIL
    tiling: str = catalog.DEFAULT_TILING
    min_confidence: float = 0.3
    overwrite: bool = False
    skip_annotated: bool = False
    # Keep a box only if the model judged at least this percentage of
    # the mark to be in view. 0 keeps every box.
    min_visible: int = 0
    flex: bool = False
    # Look at every box a second time, enlarged, and drop the ones that
    # are not logos. Realtime and single-image runs only.
    double_check: bool = False
    # The model and effort of that second look; ``None`` for the
    # provider's default (see the catalog).
    check_model: str | None = None
    check_effort: str | None = None
    # The task's own instructions at the moment the run was started
    # (``None`` = the default text). Kept with the run so that editing
    # the task's prompt changes the next run, not one that is half done:
    # a run whose prompt changed midway would stop hitting its cache and
    # label its second half by other rules than its first.
    instructions: str | None = None
    check_instructions: str | None = None
    asset_ids: list[str] | None = None

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict) -> RunOptions:
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in raw.items() if k in known})


@dataclass
class AssetOutcome:
    detections: list[Detection] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)
    # What the image's requests cost, each at the rate the provider
    # said it served it at.
    cost_usd: float = 0.0
    # Requests asked for at a discount that the provider says it served
    # at the standard rate.
    served_at_full_price: int = 0
    # Boxes the second pass looked at and threw out.
    rejected: int = 0
    error: str | None = None


def build_context(
    session: Session, task: Task, options: RunOptions, *, with_references: bool = True
) -> RunContext:
    """Resolve a request into the constant part of every API call.

    ``with_references=False`` leaves the exemplar crops out. Reading a
    batch's results needs the classes and the coordinate system, not the
    prompt, and must not fail because a reference image was deleted
    while the batch was running.

    Raises :class:`LogoAiBadRequest` for anything the caller got wrong.
    """
    try:
        provider = catalog.get_provider(options.provider)
        model = catalog.get_model(options.provider, options.model)
    except ValueError as exc:
        raise LogoAiBadRequest(str(exc)) from exc
    if options.detail not in catalog.DETAIL_MEGAPIXELS:
        raise LogoAiBadRequest(f"unknown detail: {options.detail}")
    if options.tiling not in catalog.TILING_MAX_PER_SIDE:
        raise LogoAiBadRequest(f"unknown tiling: {options.tiling}")

    project_classes = {
        str(c.id): c
        for c in session.execute(
            select(Class).where(Class.project_id == task.project_id)
        ).scalars()
    }
    classes: list[TargetClass] = []
    for row in options.prompts:
        cid = str(row.get("class_id") or "")
        cls = project_classes.get(cid)
        if cls is None:
            raise LogoAiBadRequest(f"class not in this project: {cid}")
        if any(c.class_id == cid for c in classes):
            continue
        classes.append(
            TargetClass(class_id=cid, name=cls.name, description=str(row.get("prompt") or ""))
        )
    if not classes:
        raise LogoAiBadRequest("pick at least one class to detect")

    index_of = {c.class_id: i for i, c in enumerate(classes)}
    references = (
        _build_references(session, task, options, index_of, model)
        if with_references
        else []
    )

    coords = model.coords or provider.coords
    check_model, check_effort = None, None
    if options.double_check:
        chosen = options.check_model or provider.default_check_model or model.id
        try:
            check_model = catalog.get_model(provider.id, chosen)
        except ValueError as exc:
            raise LogoAiBadRequest(str(exc)) from exc
        wanted = options.check_effort
        if wanted is None:
            # The tested default goes with the tested model; any other
            # model starts from the run's own effort.
            wanted = (
                provider.default_check_effort
                if check_model.id == provider.default_check_model
                else options.effort
            )
        check_effort = catalog.resolve_effort(check_model, wanted)
    return RunContext(
        provider=provider,
        model=model,
        effort=catalog.resolve_effort(model, options.effort),
        classes=classes,
        references=references,
        system_text=build_system_text(classes, coords, options.instructions),
        schema=build_schema(len(classes), coords, numeric_bounds=provider.id == catalog.OPENAI),
        flex=bool(options.flex and provider.supports_flex),
        coords=coords,
        check_model=check_model,
        check_effort=check_effort,
    )


def _build_references(
    session: Session,
    task: Task,
    options: RunOptions,
    index_of: dict[str, int],
    model: catalog.ModelSpec,
) -> list[Reference]:
    if len(options.references) > MAX_REFERENCES:
        raise LogoAiBadRequest(f"at most {MAX_REFERENCES} reference examples")
    images: dict[str, Image.Image] = {}
    out: list[Reference] = []
    for ref in options.references:
        cid = str(ref.get("class_id") or "")
        if cid not in index_of:
            raise LogoAiBadRequest("reference points at a class that is not being detected")
        aid = str(ref.get("asset_id") or "")
        if aid not in images:
            try:
                asset = session.get(Asset, uuid.UUID(aid))
            except ValueError:
                asset = None
            # Same task only: a reference crop is image data leaving for
            # the provider, so it must not reach into another project.
            if asset is None or asset.task_id != task.id:
                raise LogoAiBadRequest("reference asset is not in this task")
            frame = first_frame(session, asset)
            images[aid] = load_image(read_image_bytes(asset, frame))
        bbox = ref.get("bbox") or []
        if len(bbox) != 4:
            raise LogoAiBadRequest("reference bbox must be [x1, y1, x2, y2]")
        try:
            jpeg = render_reference_crop(
                images[aid], tuple(float(v) for v in bbox), model.grid
            )
        except ValueError as exc:
            raise LogoAiBadRequest(str(exc)) from exc
        out.append(Reference(class_index=index_of[cid], jpeg=jpeg))
    # Grouped by class so the prefix reads as "class 1: …, class 2: …".
    # The sort is stable, and the prefix must be byte-identical across
    # the requests of a run for the cache to hit.
    out.sort(key=lambda r: r.class_index)
    return out


def first_frame(session: Session, asset: Asset) -> Frame | None:
    return session.execute(
        select(Frame).where(Frame.asset_id == asset.id).order_by(Frame.idx).limit(1)
    ).scalar_one_or_none()


def first_frames(session: Session, assets: list[Asset]) -> dict[uuid.UUID, Frame]:
    """First frame of each asset, in one query."""
    frames: dict[uuid.UUID, Frame] = {}
    if not assets:
        return frames
    rows = session.execute(
        select(Frame)
        .where(Frame.asset_id.in_([a.id for a in assets]))
        .order_by(Frame.asset_id, Frame.idx)
    ).scalars()
    for f in rows:
        frames.setdefault(f.asset_id, f)
    return frames


def scoped_assets(
    session: Session, task_id: uuid.UUID, asset_ids: list[str] | None
) -> list[Asset]:
    """The run's assets, in the deterministic order the GPU batches
    resume by."""
    from carve_api.inference.batch import _filter_assets_by_ids, list_assets_for_task

    return _filter_assets_by_ids(list_assets_for_task(session, task_id), asset_ids)


def read_image_bytes(asset: Asset, frame: Frame | None) -> bytes:
    """The image for one frame: the extracted JPEG for a video, the
    original for an image asset."""
    is_video = getattr(asset.kind, "value", asset.kind) == "video"
    return fetch_asset_bytes(asset, frame_id=frame.id if frame and is_video else None)


def views_for(ctx: RunContext, options: RunOptions, width: int, height: int) -> list[View]:
    return plan_views(
        width,
        height,
        catalog.grid_for(ctx.model, options.detail),
        max_tiles_per_side=catalog.TILING_MAX_PER_SIDE[options.tiling],
    )


def render_views(im: Image.Image, views: list[View]) -> list[bytes]:
    return [render_view(im, v) for v in views]


def build_view_requests(
    client: ProviderClient,
    ctx: RunContext,
    views: list[View],
    jpegs: list[bytes],
    *,
    batch: bool,
) -> list[dict]:
    return [
        client.build_request(
            jpeg,
            build_request_text(
                v.out_w, v.out_h, is_tile=v.is_tile, coords=ctx.coords
            ),
            batch=batch,
        )
        for v, jpeg in zip(views, jpegs, strict=True)
    ]


def interpret(
    ctx: RunContext,
    results: list[ProviderResult],
    views: list[View],
    *,
    image_w: int,
    image_h: int,
    batch: bool = False,
    discounted: bool | None = None,
) -> AssetOutcome:
    """Turn the per-view answers for one image into merged detections.

    Every view must have answered: tiles overlap and are merged against
    the full frame, so a missing one would silently thin the labels.

    ``batch`` and ``discounted`` price the requests; a request the
    provider says it served at another tier is priced at that one.
    ``discounted`` defaults to ``batch or ctx.flex``.
    """
    if discounted is None:
        discounted = batch or ctx.flex
    outcome = AssetOutcome()
    dets: list[Detection] = []
    for view, result in zip(views, results, strict=True):
        outcome.usage.add(result.usage)
        outcome.cost_usd += result.cost_usd(
            ctx.provider, ctx.model, batch=batch, discounted=discounted
        )
        if discounted and result.discounted is False:
            outcome.served_at_full_price += 1
        if outcome.error:
            continue
        if result.error:
            outcome.error = result.error
            continue
        try:
            raw = parse_detections(result.text or "", n_classes=len(ctx.classes))
        except BadModelOutput as exc:
            outcome.error = f"bad_output: {exc}"
            continue
        dets.extend(
            to_original(
                raw, view, coords=ctx.coords, image_w=image_w, image_h=image_h
            )
        )
    if not outcome.error:
        outcome.detections = merge_detections(dets)
    outcome.cost_usd = round(outcome.cost_usd, 6)
    return outcome


def detect_image(
    client: ProviderClient,
    ctx: RunContext,
    options: RunOptions,
    image_bytes: bytes,
    *,
    pool: ThreadPoolExecutor | None = None,
) -> AssetOutcome:
    """Run every view of one image now and merge the answers."""
    im = load_image(image_bytes)
    views = views_for(ctx, options, im.width, im.height)
    requests = build_view_requests(client, ctx, views, render_views(im, views), batch=False)
    if pool is None or len(requests) == 1:
        results = [client.send(r) for r in requests]
    else:
        # The first request writes the prompt cache; the rest can only
        # read it once that response has started, so it goes alone.
        results = [client.send(requests[0]), *pool.map(client.send, requests[1:])]
    outcome = interpret(ctx, results, views, image_w=im.width, image_h=im.height)
    if options.double_check and not outcome.error:
        check_detections(client, ctx, options, im, outcome)
    return outcome


# Errors of a check request that say nothing about the boxes: the image
# is then retried as a whole rather than written unchecked.
_CHECK_RETRY_ERRORS = ("rate_limited", "provider_unreachable", "provider_error_")
# A box the second pass scores under this is not a logo and is dropped.
# The scale in the prompt puts "not a logo" at 0-39. Measured with the
# default check model: about half the wrong boxes go, about 2% of the
# real ones.
CHECK_REJECT_BELOW = 40


def check_detections(
    client: ProviderClient,
    ctx: RunContext,
    options: RunOptions,
    im: Image.Image,
    outcome: AssetOutcome,
) -> None:
    """The second pass: show the check model each box enlarged, drop
    the ones it scores as not a logo, and give the rest its score as
    their confidence. Changes ``outcome`` in place.

    The score replaces the detection's own confidence because it is the
    better number: it comes from a close look at that one box, and it is
    what the run's confidence threshold and the editor's filter then
    work on. A box the answer does not mention keeps what it had. If the
    answer cannot be read, the boxes are kept as they are: an unchecked
    box is better than a lost image.
    """
    hidden = [d for d in outcome.detections if d.visible < options.min_visible]
    candidates = [d for d in outcome.detections if d.visible >= options.min_visible]
    if not candidates:
        return
    checker = client.checker()
    check_model = ctx.check_model or ctx.model
    system_text = build_check_text(ctx.classes, options.check_instructions)
    schema = build_check_schema(numeric_bounds=ctx.provider.id == catalog.OPENAI)
    kept: list[Detection] = []
    for start in range(0, len(candidates), CHECK_MAX_TILES):
        chunk = candidates[start : start + CHECK_MAX_TILES]
        sheet = render_check_sheet(im, [(d.x1, d.y1, d.x2, d.y2) for d in chunk])
        result = checker.send(
            checker.build_check_request(
                sheet,
                build_check_request_text(len(chunk)),
                system_text=system_text,
                schema=schema,
            )
        )
        # Counted as cost, not as a request: the per-request figures the
        # estimate is built on are about detection requests.
        result.usage.requests = 0
        outcome.usage.add(result.usage)
        outcome.cost_usd = round(
            outcome.cost_usd
            + result.cost_usd(ctx.provider, check_model, batch=False, discounted=ctx.flex),
            6,
        )
        if result.discounted is False and ctx.flex:
            outcome.served_at_full_price += 1
        if result.error and result.error.startswith(_CHECK_RETRY_ERRORS):
            outcome.error = result.error
            return
        scores: dict[int, int] = {}
        try:
            for row in json.loads(result.text or "")["scores"]:
                scores[int(row[0])] = int(row[1])
        except (ValueError, TypeError, KeyError, IndexError):
            scores = {}
        for i, det in enumerate(chunk, start=1):
            score = scores.get(i)
            if score is None:
                kept.append(det)
            elif score < CHECK_REJECT_BELOW:
                outcome.rejected += 1
            else:
                kept.append(replace(det, confidence=min(max(score, 0), 100) / 100))
    outcome.detections = kept + hidden


def annotated_frame_ids(session: Session, task_id: uuid.UUID) -> set[uuid.UUID]:
    return set(
        session.execute(
            select(Annotation.frame_id)
            .where(Annotation.task_id == task_id, Annotation.frame_id.is_not(None))
            .distinct()
        ).scalars()
    )


def measured_output_per_request(
    session: Session, task_id: uuid.UUID, model_id: str, effort: str | None
) -> tuple[float, int] | None:
    """Average output tokens per request over this task's recent runs
    with the same model and effort, and how many requests that covers.

    Output (reasoning plus the answer) is most of a request's cost and
    depends on how logo-dense the images are, which only the task's own
    history knows. ``None`` when there is no such run yet.
    """
    from carve_api.logo_ai.models import (
        STATUS_COMPLETED,
        STATUS_COMPLETED_WITH_ERRORS,
        LogoAiJob,
    )

    usages = session.execute(
        select(LogoAiJob.usage)
        .where(
            LogoAiJob.task_id == task_id,
            LogoAiJob.model == model_id,
            LogoAiJob.effort.is_(None) if effort is None else LogoAiJob.effort == effort,
            LogoAiJob.status.in_([STATUS_COMPLETED, STATUS_COMPLETED_WITH_ERRORS]),
        )
        .order_by(LogoAiJob.created_at.desc())
        .limit(_HISTORY_RUNS)
    ).scalars()
    output = requests = 0
    for usage in usages:
        output += int((usage or {}).get("output_tokens", 0) or 0)
        requests += int((usage or {}).get("requests", 0) or 0)
    if requests == 0:
        return None
    return output / requests, requests


def estimate(session: Session, task: Task, options: RunOptions, assets: list[Asset]) -> dict:
    """Token and cost figures for a run, before spending anything.

    Image tokens follow the providers' published patch formulas and are
    close. Output tokens come from the task's own earlier runs when
    there are any; otherwise they are a planning figure, because
    reasoning is billed as output and its length is only known after
    the fact.
    """
    ctx = build_context(session, task, options)
    model, provider = ctx.model, ctx.provider
    patch = model.grid.patch

    requests = 0
    image_tokens = 0.0
    for asset in assets:
        # Dimensions are missing for assets uploaded before they were
        # recorded; assume a typical photo rather than skip the asset.
        w, h = asset.width or 1920, asset.height or 1080
        for v in views_for(ctx, options, w, h):
            requests += 1
            image_tokens += image_patches(v.out_w, v.out_h, patch) * model.image_token_multiplier

    ref_tokens = sum(
        image_patches(*Image.open(BytesIO(r.jpeg)).size, patch) * model.image_token_multiplier
        for r in ctx.references
    )
    prefix_tokens = int(len(ctx.system_text) * _TOKENS_PER_CHAR + ref_tokens)
    prefix_cached = prefix_tokens >= model.min_cache_tokens
    measured = measured_output_per_request(session, task.id, model.id, ctx.effort)
    per_request = (
        measured[0]
        if measured
        else catalog.estimated_output_tokens(ctx.effort) + _EST_ANSWER_TOKENS
    )
    output_tokens = int(requests * per_request)
    # The second pass: one more request per image to the check model, a
    # sheet of the image's boxes in and a short list of scores out.
    check = Usage()
    if options.double_check:
        check.input_tokens = len(assets) * _EST_CHECK_INPUT_TOKENS
        check.output_tokens = len(assets) * _EST_CHECK_OUTPUT_TOKENS
    check_model = ctx.check_model or model

    def cost(*, batch: bool, discounted: bool) -> float:
        usage = Usage(output_tokens=output_tokens)
        usage.input_tokens = int(image_tokens) + requests * 40
        if prefix_cached and requests > 0:
            usage.cache_write_tokens = prefix_tokens
            usage.cache_read_tokens = prefix_tokens * (requests - 1)
        else:
            usage.input_tokens += prefix_tokens * requests
        total = usage.cost_usd(provider, model, batch=batch, discounted=discounted)
        if not batch:  # a batch run has no second pass
            total += check.cost_usd(provider, check_model, batch=False, discounted=discounted)
        return round(total, 4)

    return {
        "assets": len(assets),
        "requests": requests,
        "image_tokens": int(image_tokens),
        "prefix_tokens": prefix_tokens,
        "prefix_cached": prefix_cached,
        "min_cache_tokens": model.min_cache_tokens,
        "output_tokens": output_tokens,
        # Requests of earlier runs the output figure is averaged over;
        # 0 means it is the built-in planning figure.
        "based_on_requests": measured[1] if measured else 0,
        "cost_realtime_usd": cost(batch=False, discounted=False),
        "cost_flex_usd": (
            cost(batch=False, discounted=True) if provider.supports_flex else None
        ),
        "cost_batch_usd": cost(batch=True, discounted=True),
    }
