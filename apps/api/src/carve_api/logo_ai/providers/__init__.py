# Armin Mehri — mehri.armin@gmail.com
"""Vendor adapters. The SDKs are imported lazily, inside each adapter,
so importing this package never requires either of them."""

from __future__ import annotations

from carve_api.config import get_settings
from carve_api.logo_ai.catalog import ANTHROPIC, OPENAI
from carve_api.logo_ai.providers.base import (
    LogoAiNotConfigured,
    ProviderClient,
    RunContext,
)


def api_key_for(provider_id: str) -> str:
    s = get_settings()
    return {ANTHROPIC: s.anthropic_api_key, OPENAI: s.openai_api_key}.get(provider_id, "")


def is_configured(provider_id: str) -> bool:
    return bool(api_key_for(provider_id))


def make_client(ctx: RunContext) -> ProviderClient:
    key = api_key_for(ctx.provider.id)
    if not key:
        raise LogoAiNotConfigured(f"{ctx.provider.env_var} is not set")
    if ctx.provider.id == ANTHROPIC:
        from carve_api.logo_ai.providers.anthropic_provider import AnthropicClient

        return AnthropicClient(ctx, key)
    from carve_api.logo_ai.providers.openai_provider import OpenAIClient

    return OpenAIClient(ctx, key)
