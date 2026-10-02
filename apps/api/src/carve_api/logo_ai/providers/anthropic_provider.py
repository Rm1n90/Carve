# Armin Mehri — mehri.armin@gmail.com
"""Anthropic adapter: Messages API (realtime) + Message Batches API."""

from __future__ import annotations

import base64
import logging
from collections.abc import Iterator
from datetime import datetime, timedelta

from carve_api.logo_ai.prompt import REFERENCE_INTRO, reference_label
from carve_api.logo_ai.providers.base import (
    BatchGone,
    BatchState,
    ProviderClient,
    ProviderFatal,
    ProviderResult,
    RunContext,
    Usage,
    api_error_message,
    live_connection_transport,
)

# Thinking is billed against max_tokens too, so this leaves the answer
# room at high effort while staying under the SDK's non-streaming limit.
_MAX_TOKENS = 16000

# Re-runs a request on Anthropic's recommended substitute model when the
# requested one declines it for policy reasons. Realtime only: the
# Batches API rejects the parameter.
_FALLBACK_BETA = "server-side-fallback-2026-07-01"

# Statuses that are not a verdict on the request: sending it again can
# succeed.
_RETRYABLE_STATUS = frozenset({408, 409, 429})
# Per-request error types that are the provider's trouble, not the request's.
_SERVER_SIDE = frozenset({"overloaded_error", "api_error", "rate_limit_error", "timeout_error"})
# A batch is searched for from a little before the part was recorded:
# the two clocks are not the same clock.
_FIND_SLACK_SECONDS = 300

log = logging.getLogger(__name__)


def _image_block(jpeg: bytes) -> dict:
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": base64.standard_b64encode(jpeg).decode("ascii"),
        },
    }


class AnthropicClient(ProviderClient):
    def __init__(self, ctx: RunContext, api_key: str) -> None:
        super().__init__(ctx)
        self._api_key = api_key
        import anthropic

        self._sdk = anthropic
        # A link that has gone dead is noticed by the transport rather
        # than by waiting out the read timeout.
        self._client = anthropic.Anthropic(
            api_key=api_key,
            max_retries=4,
            timeout=anthropic.Timeout(600.0, connect=15.0),
            http_client=anthropic.DefaultHttpxClient(transport=live_connection_transport()),
        )

    @property
    def _batches(self):  # noqa: ANN202 — SDK resource
        """Batch bookkeeping. The run has its own way of waiting for the
        provider, so the SDK is not left to retry for long."""
        return self._client.with_options(max_retries=1).messages.batches

    def _with_context(self, ctx: RunContext) -> AnthropicClient:
        return AnthropicClient(ctx, self._api_key)

    def build_request(self, image_jpeg: bytes, request_text: str, *, batch: bool) -> dict:
        ctx = self.ctx
        # A batch can sit queued for longer than the default 5 minutes,
        # so its prefix is cached for an hour instead.
        cache = {"type": "ephemeral", "ttl": "1h"} if batch else {"type": "ephemeral"}

        content: list[dict] = []
        if ctx.references:
            content.append({"type": "text", "text": REFERENCE_INTRO})
            for ref in ctx.references:
                label = reference_label(ref.class_index + 1, ctx.classes[ref.class_index])
                content.append({"type": "text", "text": label})
                content.append(_image_block(ref.jpeg))
            content[-1]["cache_control"] = cache

        target = _image_block(image_jpeg)
        # The image is already sized to the model's grid. If that ever
        # stops being true, fail loudly rather than let the API resize
        # it and shift every returned coordinate.
        target["transformations"] = {"oversized_image": "error"}
        content.append(target)
        content.append({"type": "text", "text": request_text})

        output_config: dict = {
            "format": {"type": "json_schema", "schema": ctx.schema}
        }
        if ctx.effort:
            output_config["effort"] = ctx.effort
        return {
            "model": ctx.model.id,
            "max_tokens": _MAX_TOKENS,
            "system": [
                {"type": "text", "text": ctx.system_text, "cache_control": cache}
            ],
            "messages": [{"role": "user", "content": content}],
            "output_config": output_config,
        }

    def build_check_request(
        self, sheet_jpeg: bytes, request_text: str, *, system_text: str, schema: dict
    ) -> dict:
        ctx = self.ctx
        output_config: dict = {"format": {"type": "json_schema", "schema": schema}}
        if ctx.effort:
            output_config["effort"] = ctx.effort
        return {
            "model": ctx.model.id,
            "max_tokens": _MAX_TOKENS,
            "system": [
                {"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}
            ],
            "messages": [
                {
                    "role": "user",
                    "content": [_image_block(sheet_jpeg), {"type": "text", "text": request_text}],
                }
            ],
            "output_config": output_config,
        }

    def send(self, request: dict) -> ProviderResult:
        sdk = self._sdk
        try:
            if self.ctx.model.supports_fallbacks:
                message = self._client.beta.messages.create(
                    **request, betas=[_FALLBACK_BETA], fallbacks="default"
                )
            else:
                message = self._client.messages.create(**request)
        except (sdk.AuthenticationError, sdk.PermissionDeniedError) as exc:
            raise ProviderFatal(
                f"Anthropic rejected the API key: {api_error_message(exc)}"
            ) from exc
        except sdk.NotFoundError as exc:
            raise ProviderFatal(
                f"Anthropic model not available: {api_error_message(exc)}"
            ) from exc
        except sdk.BadRequestError as exc:
            return ProviderResult(error=f"bad_request: {api_error_message(exc)}"[:300])
        except sdk.RateLimitError:
            return ProviderResult(error="rate_limited")
        except sdk.APIStatusError as exc:
            return ProviderResult(error=f"provider_error_{exc.status_code}")
        except sdk.APIConnectionError:
            return ProviderResult(error="provider_unreachable")
        return _parse_message(message)

    def batch_create(
        self, requests: list[tuple[str, dict]], *, tag: str
    ) -> tuple[str, str | None]:
        from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
        from anthropic.types.messages.batch_create_params import Request

        sdk = self._sdk
        try:
            # No SDK retries: a retry after an answer lost on the way
            # back would make, and bill, a second batch. The caller
            # looks for the first one before it tries again.
            batch = self._client.with_options(max_retries=0).messages.batches.create(
                requests=[
                    Request(custom_id=cid, params=MessageCreateParamsNonStreaming(**params))
                    for cid, params in requests
                ]
            )
        except (sdk.AuthenticationError, sdk.PermissionDeniedError) as exc:
            raise ProviderFatal(
                f"Anthropic rejected the API key: {api_error_message(exc)}"
            ) from exc
        except sdk.APIStatusError as exc:
            if exc.status_code >= 500 or exc.status_code in _RETRYABLE_STATUS:
                raise
            raise ProviderFatal(
                f"Anthropic rejected the batch: {api_error_message(exc)}"
            ) from exc
        return batch.id, None

    def batch_find(
        self, tag: str, *, request_count: int, since: datetime, known: set[str]
    ) -> tuple[str, str | None] | None:
        # A Message Batch carries no label of ours, so the match is by
        # elimination: a batch made after the part was recorded, of the
        # same size, that no part on record owns. Its custom ids start
        # with the part's id and are checked when the results are read,
        # so a wrong guess costs a delay, never a wrong box.
        oldest = since - timedelta(seconds=_FIND_SLACK_SECONDS)
        older = 0
        for batch in self._batches.list(limit=100):
            if batch.created_at < oldest:
                older += 1
                if older >= 100:
                    break
                continue
            c = batch.request_counts
            total = c.processing + c.succeeded + c.errored + c.canceled + c.expired
            if batch.id not in known and total == request_count:
                return batch.id, None
        return None

    def batch_state(self, batch_id: str) -> BatchState:
        try:
            batch = self._batches.retrieve(batch_id)
        except self._sdk.NotFoundError as exc:
            raise BatchGone(api_error_message(exc)) from exc
        c = batch.request_counts
        total = c.processing + c.succeeded + c.errored + c.canceled + c.expired
        return BatchState(
            ended=batch.processing_status == "ended",
            total=total,
            # Anthropic only fills the per-outcome counts once the whole
            # batch has ended, so this stays 0 until then.
            finished=total - c.processing,
            expires_at=batch.expires_at,
        )

    def batch_download(self, batch_id: str) -> bytes:
        try:
            # One JSON line per request, as the SDK decoded it.
            lines = [
                entry.model_dump_json()
                for entry in self._batches.results(batch_id)
            ]
        except self._sdk.NotFoundError as exc:
            raise BatchGone(api_error_message(exc)) from exc
        return "\n".join(lines).encode("utf-8")

    def batch_parse(self, raw: bytes) -> Iterator[tuple[str, ProviderResult]]:
        from anthropic.types.messages import MessageBatchIndividualResponse

        for line in raw.decode("utf-8").splitlines():
            if not line.strip():
                continue
            try:
                entry = MessageBatchIndividualResponse.model_validate_json(line)
            except ValueError:
                # One unreadable line must not cost the other answers of
                # the batch; its request is reported as unanswered.
                log.warning("logo_ai.anthropic.batch_line_unreadable")
                continue
            result = entry.result
            if result.type == "succeeded":
                yield entry.custom_id, _parse_message(result.message)
            elif result.type == "errored":
                kind = result.error.error.type
                yield entry.custom_id, ProviderResult(
                    error=f"{kind}: {result.error.error.message}"[:300],
                    retryable=kind in _SERVER_SIDE,
                )
            else:  # canceled | expired
                yield entry.custom_id, ProviderResult(
                    error=result.type, retryable=result.type == "expired"
                )

    def batch_cancel(self, batch_id: str) -> None:
        try:
            self._batches.cancel(batch_id)
        except self._sdk.APIStatusError:
            # Already ended — nothing left to cancel.
            pass


def _parse_message(message) -> ProviderResult:  # noqa: ANN001 — SDK Message
    u = message.usage
    usage = Usage(
        input_tokens=u.input_tokens or 0,
        cache_read_tokens=u.cache_read_input_tokens or 0,
        cache_write_tokens=u.cache_creation_input_tokens or 0,
        output_tokens=u.output_tokens or 0,
        requests=1,
    )
    # A refusal or a truncated answer is not guaranteed to match the
    # schema, so neither is parsed.
    if message.stop_reason == "refusal":
        return ProviderResult(usage=usage, error="refusal")
    if message.stop_reason == "max_tokens":
        return ProviderResult(usage=usage, error="max_tokens")
    text = next((b.text for b in message.content if b.type == "text"), None)
    if text is None:
        return ProviderResult(usage=usage, error="empty_answer")
    return ProviderResult(text=text, usage=usage)
