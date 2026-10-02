# Armin Mehri — mehri.armin@gmail.com
"""Providers, models, effort levels, prices and vision geometry.

Everything vendor-specific that is *data* lives here so the rest of the
package can stay provider-neutral. Figures were read from the vendors'
published docs on 2026-09-30; prices drift, so the UI labels every
dollar amount derived from them as an estimate and the job row stores
the token counts it was computed from.
"""

from __future__ import annotations

from dataclasses import dataclass

from carve_api.logo_ai.imaging import GridSpec

ANTHROPIC = "anthropic"
OPENAI = "openai"

# "pixel"   — absolute pixel coordinates in the image as sent. What
#             Anthropic documents Claude to be best at.
# "grid999" — integers on a fixed 0..999 grid per axis. What OpenAI's
#             vision cookbook prescribes for GPT localization.
COORDS_PIXEL = "pixel"
COORDS_GRID999 = "grid999"


@dataclass(frozen=True)
class ModelSpec:
    id: str
    label: str
    provider: str
    blurb: str
    # Accepted effort values, cheapest first. Empty = the model has no
    # effort control and the selector is disabled.
    efforts: tuple[str, ...]
    default_effort: str | None
    # USD per 1M tokens at the realtime rate.
    input_usd: float
    output_usd: float
    cache_read_usd: float
    grid: GridSpec
    # Billed tokens per image patch.
    image_token_multiplier: float = 1.0
    # Shortest prompt prefix the provider will cache at all.
    min_cache_tokens: int = 1024
    # Anthropic only: whether the server-side refusal fallback applies.
    supports_fallbacks: bool = False
    # Whether the provider's batch API takes this model. Checked against
    # the API itself, not the model pages: on 2026-10-01 OpenAI's page
    # for GPT-6.1 Sol said "Supported" and the Batch API refused it.
    supports_batch: bool = True
    # The coordinate system this model is asked for, when it is not the
    # provider's usual one.
    coords: str | None = None


@dataclass(frozen=True)
class ProviderSpec:
    id: str
    label: str
    env_var: str
    coords: str
    # Multiplier applied to realtime prices by the 24h batch API.
    batch_discount: float
    # Cache-write surcharge over the input price (realtime / batch TTLs).
    cache_write_mult: float
    cache_write_mult_batch: float
    # OpenAI only: near-realtime processing at the batch price.
    supports_flex: bool
    default_model: str
    models: tuple[ModelSpec, ...]
    # The model (and effort) the second pass uses unless the run names
    # another. ``None``: the run's own detection model and effort.
    default_check_model: str | None = None
    default_check_effort: str | None = None


_ALL_EFFORTS = ("low", "medium", "high", "xhigh", "max")

# Anthropic bills one token per 28px patch. Models from Claude 4.7 on
# take 2576px / 4784 patches; earlier ones 1568px / 1568 patches.
_CLAUDE_HIGH_RES = GridSpec(patch=28, max_edge=2576, max_patches=4784)
_CLAUDE_STANDARD = GridSpec(patch=28, max_edge=1568, max_patches=1568)

# OpenAI bills 32px patches times a per-model multiplier. 2048px / 2500
# patches is the ``detail: "high"`` budget, which every current model
# leaves untouched — so an image pre-sized to it is never resized.
_GPT_HIGH = GridSpec(patch=32, max_edge=2048, max_patches=2500)

_ANTHROPIC = ProviderSpec(
    id=ANTHROPIC,
    label="Anthropic",
    env_var="ANTHROPIC_API_KEY",
    coords=COORDS_PIXEL,
    batch_discount=0.5,
    cache_write_mult=1.25,        # 5-minute TTL
    cache_write_mult_batch=2.0,   # 1-hour TTL, outlives a batch's queue time
    supports_flex=False,
    default_model="claude-opus-5-5",
    models=(
        ModelSpec(
            id="claude-opus-5-5",
            label="Claude Opus 5.5",
            provider=ANTHROPIC,
            blurb="Best accuracy for the price. Recommended.",
            efforts=_ALL_EFFORTS,
            default_effort="medium",
            input_usd=4.0, output_usd=20.0, cache_read_usd=0.20,
            grid=_CLAUDE_HIGH_RES,
            min_cache_tokens=512,
            supports_fallbacks=True,
        ),
        ModelSpec(
            id="claude-sonnet-5-5",
            label="Claude Sonnet 5.5",
            provider=ANTHROPIC,
            blurb="Half the price of Opus; good on clear, mid-size logos.",
            efforts=_ALL_EFFORTS,
            default_effort="medium",
            input_usd=2.0, output_usd=10.0, cache_read_usd=0.20,
            grid=_CLAUDE_HIGH_RES,
            min_cache_tokens=512,
            supports_fallbacks=True,
        ),
        ModelSpec(
            id="claude-haiku-4-5",
            label="Claude Haiku 4.5",
            provider=ANTHROPIC,
            blurb="Cheapest Claude. Lower resolution cap; misses small logos.",
            efforts=(),
            default_effort=None,
            input_usd=1.0, output_usd=5.0, cache_read_usd=0.10,
            grid=_CLAUDE_STANDARD,
            min_cache_tokens=4096,
        ),
        ModelSpec(
            id="claude-fable-5-1",
            label="Claude Fable 5.1",
            provider=ANTHROPIC,
            blurb="Most capable, 2.5× Opus pricing. For the hardest sets.",
            efforts=_ALL_EFFORTS,
            default_effort="medium",
            input_usd=10.0, output_usd=50.0, cache_read_usd=0.25,
            grid=_CLAUDE_HIGH_RES,
            min_cache_tokens=512,
            supports_fallbacks=True,
        ),
    ),
)

_OPENAI = ProviderSpec(
    id=OPENAI,
    label="OpenAI",
    env_var="OPENAI_API_KEY",
    coords=COORDS_GRID999,
    batch_discount=0.5,
    cache_write_mult=1.25,
    cache_write_mult_batch=1.25,
    supports_flex=True,
    default_model="gpt-6.1-sol",
    # Measured on 2026-10-02 on 278 detected boxes (31 clearly wrong, 219
    # real), each model scoring the same check sheets, rejecting under 40:
    #   GPT-6 Sol low     removed 16-17 wrong, lost 3-5 real
    #   GPT-6.1 Sol low   removed 7, lost 1 (too lenient)
    #   GPT-6 Luna low    removed 17-21, lost 4-8, unstable between runs
    #   GPT-6 Luna none   removed 26, lost 25
    # More effort did not help any of them.
    default_check_model="gpt-6-sol",
    default_check_effort="low",
    models=(
        ModelSpec(
            id="gpt-6.1-sol",
            label="GPT-6.1 Sol",
            provider=OPENAI,
            blurb="Balanced accuracy and price. Recommended for realtime and Flex; "
                  "OpenAI's Batch API does not take it yet.",
            efforts=_ALL_EFFORTS,
            # Measured on a dense sponsor-logo photo (40 logos): low found
            # the same logos as high in an eighth of the time at a quarter
            # of the cost; medium added false positives.
            default_effort="low",
            input_usd=2.0, output_usd=10.0, cache_read_usd=0.10,
            grid=_GPT_HIGH,
            image_token_multiplier=1.2,
            supports_batch=False,
        ),
        ModelSpec(
            id="gpt-6-sol",
            label="GPT-6 Sol",
            provider=OPENAI,
            blurb="The previous Sol, same price; takes Batch. Finds fewer small "
                  "logos than 6.1 Sol (26 vs 40 on a dense test photo).",
            efforts=("none", *_ALL_EFFORTS),
            default_effort="low",
            input_usd=2.0, output_usd=10.0, cache_read_usd=0.20,
            grid=_GPT_HIGH,
            image_token_multiplier=1.2,
            # Measured on 2026-10-01: asked for the 0..999 grid it put
            # boxes in the wrong place (y scaled by about 0.73); asked
            # for pixels it placed them tightly.
            coords=COORDS_PIXEL,
        ),
        ModelSpec(
            id="gpt-6-astra",
            label="GPT-6 Astra",
            provider=OPENAI,
            blurb="Flagship, 5× Sol pricing. For the hardest sets.",
            efforts=_ALL_EFFORTS,
            default_effort="medium",
            input_usd=10.0, output_usd=50.0, cache_read_usd=1.0,
            grid=_GPT_HIGH,
            image_token_multiplier=1.2,
        ),
        ModelSpec(
            id="gpt-6-luna",
            label="GPT-6 Luna",
            provider=OPENAI,
            blurb="Very cheap. Fine for large, obvious logos.",
            efforts=("none", *_ALL_EFFORTS),
            default_effort="medium",
            input_usd=0.10, output_usd=0.50, cache_read_usd=0.01,
            grid=_GPT_HIGH,
            image_token_multiplier=1.2,
        ),
    ),
)

PROVIDERS: dict[str, ProviderSpec] = {p.id: p for p in (_ANTHROPIC, _OPENAI)}

# Megapixels sent per view; "max" is whatever the chosen model accepts
# without resizing. A budget only ever shrinks an image: one already
# under it is sent at its own size.
#
# The default is "standard". Measured on a 1080x1920 photo with 30+
# sponsor logos, 1.2 MP found the same logos as full size with equally
# tight boxes (it lost three marks under ~30px) for 43% fewer image
# tokens. Going down to 0.6 MP visibly loosened the boxes on small
# logos, so "low" is left as an explicit choice.
DETAIL_MEGAPIXELS: dict[str, float | None] = {
    "low": 0.6,
    "standard": 1.2,
    "high": 2.4,
    "max": None,
}
DEFAULT_DETAIL = "standard"

# Tiling → most tiles per image side. 0 sends the full frame only.
TILING_MAX_PER_SIDE: dict[str, int] = {"off": 0, "auto": 2, "fine": 3}
DEFAULT_TILING = "off"

# Reasoning/thinking tokens are billed as output and dominate the cost
# of a request above low effort, but how many a model spends is only
# known afterwards. These are planning figures for the pre-run estimate
# when the task has no earlier run to go by: low/medium/high as measured
# on GPT-6.1 Sol with a logo-dense photo, the rest extrapolated.
_EST_OUTPUT_TOKENS: dict[str | None, int] = {
    None: 0, "none": 0, "low": 350, "medium": 2000,
    "high": 6000, "xhigh": 12000, "max": 20000,
}


def get_provider(provider_id: str) -> ProviderSpec:
    try:
        return PROVIDERS[provider_id]
    except KeyError:
        raise ValueError(f"unknown provider: {provider_id}") from None


def get_model(provider_id: str, model_id: str) -> ModelSpec:
    for m in get_provider(provider_id).models:
        if m.id == model_id:
            return m
    raise ValueError(f"unknown model for {provider_id}: {model_id}")


def resolve_effort(model: ModelSpec, effort: str | None) -> str | None:
    """The effort to send: the request's if the model accepts it, else
    the model's default. ``None`` for models with no effort control."""
    if not model.efforts:
        return None
    if effort in model.efforts:
        return effort
    return model.default_effort


def grid_for(model: ModelSpec, detail: str) -> GridSpec:
    """The model's grid, with the patch budget lowered to ``detail``."""
    megapixels = DETAIL_MEGAPIXELS.get(detail, DETAIL_MEGAPIXELS[DEFAULT_DETAIL])
    grid = model.grid
    if megapixels is None:
        return grid
    budget = int(megapixels * 1_000_000 / (grid.patch * grid.patch))
    return GridSpec(
        patch=grid.patch,
        max_edge=grid.max_edge,
        max_patches=max(1, min(grid.max_patches, budget)),
    )


def estimated_output_tokens(effort: str | None) -> int:
    return _EST_OUTPUT_TOKENS.get(effort, _EST_OUTPUT_TOKENS["medium"])
