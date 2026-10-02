# Armin Mehri — mehri.armin@gmail.com
"""OpenAI adapter: Responses API (realtime / flex) + Batch API."""

from __future__ import annotations

import base64
import json
import logging
from collections.abc import Iterator
from datetime import UTC, datetime

from carve_api.logo_ai.prompt import (
    CHECK_SCHEMA_NAME,
    REFERENCE_INTRO,
    SCHEMA_NAME,
    reference_label,
)
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

log = logging.getLogger(__name__)

# Reasoning tokens count against this, so a low ceiling can end a
# response before any visible output is written.
_MAX_OUTPUT_TOKENS = 16000

_BATCH_ENDPOINT = "/v1/responses"
_BATCH_ENDED = frozenset({"completed", "expired", "cancelled", "failed"})
# The per-model cap on prompt tokens waiting in the batch queue. A batch
# over it fails validation: nothing in it runs and nothing is charged.
_QUEUE_FULL = "token_limit_exceeded"
# Statuses that are not a verdict on the request: sending it again can
# succeed.
_RETRYABLE_STATUS = frozenset({408, 409, 429})
# Response error codes that are the provider's trouble, not the request's.
_SERVER_SIDE = frozenset({"server_error", "rate_limit_exceeded"})
# Error-file codes for a request the batch never ran.
_UNANSWERED = frozenset({"batch_expired"})
# Batch metadata key holding the tag of the part (and attempt) it carries.
_TAG_KEY = "carve_part"
# A batch is searched for from a little before the part was recorded:
# the two clocks are not the same clock.
_FIND_SLACK_SECONDS = 300

# Marks the end of a reusable prompt prefix. Used with explicit-only
# caching: the default (implicit) breakpoint sits at the end of the
# request, after the image, which would bill a cache *write* for every
# unique image and never produce a hit.
_BREAKPOINT = {"mode": "explicit"}


def _image_part(jpeg: bytes) -> dict:
    b64 = base64.standard_b64encode(jpeg).decode("ascii")
    return {
        "type": "input_image",
        "image_url": f"data:image/jpeg;base64,{b64}",
        # Images arrive pre-sized inside the "high" budget (2048px,
        # 2,500 patches), which no current model resizes further.
        "detail": "high",
    }


class OpenAIClient(ProviderClient):
    def __init__(self, ctx: RunContext, api_key: str) -> None:
        super().__init__(ctx)
        self._api_key = api_key
        import openai

        self._sdk = openai
        # Flex trades latency for the batch price; give it time. A link
        # that has gone dead is noticed by the transport, not by this.
        self._client = openai.OpenAI(
            api_key=api_key,
            max_retries=4,
            timeout=openai.Timeout(900.0, connect=15.0),
            http_client=openai.DefaultHttpx2Client(transport=live_connection_transport()),
        )

    @property
    def _batches(self):  # noqa: ANN202 — SDK client
        """The client for batch bookkeeping (uploads, batch objects,
        result files). These answer quickly or not at all, and the run
        has its own way of waiting for the provider, so the SDK is not
        left to retry for long."""
        return self._client.with_options(
            max_retries=1, timeout=self._sdk.Timeout(300.0, connect=15.0)
        )

    def _with_context(self, ctx: RunContext) -> OpenAIClient:
        return OpenAIClient(ctx, self._api_key)

    def build_request(self, image_jpeg: bytes, request_text: str, *, batch: bool) -> dict:
        ctx = self.ctx
        developer = {
            "role": "developer",
            "content": [
                {
                    "type": "input_text",
                    "text": ctx.system_text,
                    "prompt_cache_breakpoint": _BREAKPOINT,
                }
            ],
        }
        content: list[dict] = []
        if ctx.references:
            content.append({"type": "input_text", "text": REFERENCE_INTRO})
            for ref in ctx.references:
                label = reference_label(ref.class_index + 1, ctx.classes[ref.class_index])
                content.append({"type": "input_text", "text": label})
                content.append(_image_part(ref.jpeg))
            content[-1]["prompt_cache_breakpoint"] = _BREAKPOINT
        content.append(_image_part(image_jpeg))
        content.append({"type": "input_text", "text": request_text})

        body: dict = {
            "model": ctx.model.id,
            "input": [developer, {"role": "user", "content": content}],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": SCHEMA_NAME,
                    "strict": True,
                    "schema": ctx.schema,
                }
            },
            "prompt_cache_options": {"mode": "explicit"},
            "max_output_tokens": _MAX_OUTPUT_TOKENS,
            # Nothing reads these responses back; don't keep customer
            # images in OpenAI's response store.
            "store": False,
        }
        if ctx.effort:
            body["reasoning"] = {"effort": ctx.effort}
        if ctx.flex and not batch:
            body["service_tier"] = "flex"
        return body

    def build_check_request(
        self, sheet_jpeg: bytes, request_text: str, *, system_text: str, schema: dict
    ) -> dict:
        ctx = self.ctx
        body: dict = {
            "model": ctx.model.id,
            "input": [
                {
                    "role": "developer",
                    "content": [
                        {
                            "type": "input_text",
                            "text": system_text,
                            "prompt_cache_breakpoint": _BREAKPOINT,
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        _image_part(sheet_jpeg),
                        {"type": "input_text", "text": request_text},
                    ],
                },
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": CHECK_SCHEMA_NAME,
                    "strict": True,
                    "schema": schema,
                }
            },
            # Explicit, as for detection: the default would bill a cache
            # write for every sheet and never read one back.
            "prompt_cache_options": {"mode": "explicit"},
            "max_output_tokens": _MAX_OUTPUT_TOKENS,
            "store": False,
        }
        if ctx.effort:
            body["reasoning"] = {"effort": ctx.effort}
        if ctx.flex:
            body["service_tier"] = "flex"
        return body

    def send(self, request: dict) -> ProviderResult:
        sdk = self._sdk
        try:
            # A Flex request OpenAI has no Flex capacity for comes back as
            # a rate limit (not charged). It is reported as such, never
            # sent again at the standard price: the run was priced at
            # Flex, and the run knows how to wait.
            response = self._client.responses.create(**request)
        except (sdk.AuthenticationError, sdk.PermissionDeniedError) as exc:
            raise ProviderFatal(
                f"OpenAI rejected the API key: {api_error_message(exc)}"
            ) from exc
        except sdk.NotFoundError as exc:
            raise ProviderFatal(
                f"OpenAI model not available: {api_error_message(exc)}"
            ) from exc
        except sdk.BadRequestError as exc:
            return ProviderResult(error=f"bad_request: {api_error_message(exc)}"[:300])
        except sdk.RateLimitError:
            return ProviderResult(error="rate_limited")
        except sdk.APIStatusError as exc:
            return ProviderResult(error=f"provider_error_{exc.status_code}")
        except sdk.APIConnectionError:
            return ProviderResult(error="provider_unreachable")
        return _parse_body(response.model_dump())

    def _refusal(self, exc: Exception) -> ProviderFatal | None:
        """The error as a refusal, or ``None`` if it is worth retrying."""
        sdk = self._sdk
        if isinstance(exc, sdk.AuthenticationError | sdk.PermissionDeniedError):
            return ProviderFatal(f"OpenAI rejected the API key: {api_error_message(exc)}")
        if isinstance(exc, sdk.APIStatusError) and not (
            exc.status_code >= 500 or exc.status_code in _RETRYABLE_STATUS
        ):
            return ProviderFatal(f"OpenAI rejected the batch: {api_error_message(exc)}")
        return None

    def _start_batch(self, file_id: str, tag: str):  # noqa: ANN202 — SDK Batch
        # No SDK retries here. Creating a batch is not idempotent: a
        # retry after an answer that got lost on the way back would make
        # a second batch, and both would be billed. The caller looks the
        # batch up by its tag before it tries again.
        return self._batches.with_options(max_retries=0).batches.create(
            input_file_id=file_id,
            endpoint=_BATCH_ENDPOINT,
            completion_window="24h",
            metadata={_TAG_KEY: tag},
        )

    def batch_create(
        self, requests: list[tuple[str, dict]], *, tag: str
    ) -> tuple[str, str | None]:
        lines = [
            json.dumps(
                {"custom_id": cid, "method": "POST", "url": _BATCH_ENDPOINT, "body": body},
                separators=(",", ":"),
            )
            for cid, body in requests
        ]
        payload = ("\n".join(lines) + "\n").encode("utf-8")
        uploaded = None
        try:
            uploaded = self._batches.files.create(
                file=(f"logo-ai-{tag}.jsonl", payload), purpose="batch"
            )
            batch = self._start_batch(uploaded.id, tag)
        except self._sdk.OpenAIError as exc:
            refusal = self._refusal(exc)
            if refusal is None:
                if uploaded is not None:
                    # The images are already over there. Say where, so
                    # the next attempt starts from that file instead of
                    # leaving it behind and uploading another.
                    exc.uploaded_file_id = uploaded.id  # type: ignore[attr-defined]
                raise
            raise refusal from exc
        return batch.id, uploaded.id

    def batch_create_from_file(self, file_id: str, *, tag: str) -> str | None:
        try:
            return self._start_batch(file_id, tag).id
        except (self._sdk.NotFoundError, self._sdk.BadRequestError):
            # The file is gone, or no longer accepted: upload it again.
            return None
        except self._sdk.OpenAIError as exc:
            refusal = self._refusal(exc)
            if refusal is None:
                raise
            raise refusal from exc

    def batch_find(
        self, tag: str, *, request_count: int, since: datetime, known: set[str]
    ) -> tuple[str, str | None] | None:
        oldest = since.timestamp() - _FIND_SLACK_SECONDS
        older = 0
        # The list comes newest first and the SDK fetches further pages
        # as the loop goes on. It stops a page's worth past the time the
        # part was recorded rather than at the first older batch, so it
        # does not depend on the order being exact.
        for batch in self._batches.batches.list(limit=100):
            if (batch.metadata or {}).get(_TAG_KEY) == tag:
                return batch.id, batch.input_file_id
            if batch.created_at < oldest:
                older += 1
                if older >= 100:
                    break
        return None

    def batch_state(self, batch_id: str) -> BatchState:
        try:
            batch = self._batches.batches.retrieve(batch_id)
        except self._sdk.NotFoundError as exc:
            raise BatchGone(api_error_message(exc)) from exc
        counts = batch.request_counts
        failed_reason = None
        queue_full = False
        if batch.status == "failed":
            errors = batch.errors.data if batch.errors and batch.errors.data else []
            failed_reason = "; ".join(e.message or e.code or "" for e in errors)[:400]
            failed_reason = failed_reason or "batch failed validation"
            queue_full = any(e.code == _QUEUE_FULL for e in errors)
            if queue_full:
                failed_reason = (
                    "OpenAI's batch queue for this model is full; nothing was "
                    f"charged for these images. ({failed_reason})"
                )
        return BatchState(
            ended=batch.status in _BATCH_ENDED,
            total=counts.total if counts else 0,
            finished=(counts.completed + counts.failed) if counts else 0,
            failed_reason=failed_reason,
            expires_at=(
                datetime.fromtimestamp(batch.expires_at, tz=UTC)
                if batch.expires_at
                else None
            ),
            queue_full=queue_full,
        )

    def batch_download(self, batch_id: str) -> bytes:
        try:
            batch = self._batches.batches.retrieve(batch_id)
            counts = batch.request_counts
            if counts and counts.completed > 0 and not batch.output_file_id:
                # Answers exist but their file is not attached yet. Reading
                # now would record them as missing, for good.
                raise RuntimeError("batch output file is not available yet")
            # Successful lines land in the output file; rejected, expired
            # and cancelled ones in the error file. Same line format.
            texts = [
                self._batches.files.content(file_id).text
                for file_id in (batch.output_file_id, batch.error_file_id)
                if file_id
            ]
        except self._sdk.NotFoundError as exc:
            raise BatchGone(api_error_message(exc)) from exc
        return "\n".join(t.strip("\n") for t in texts).encode("utf-8")

    def batch_parse(self, raw: bytes) -> Iterator[tuple[str, ProviderResult]]:
        for line in raw.decode("utf-8").splitlines():
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                custom_id = entry["custom_id"]
            except (ValueError, TypeError, KeyError):
                # One unreadable line must not cost the other answers of
                # the batch; its request is reported as unanswered.
                log.warning("logo_ai.openai.batch_line_unreadable")
                continue
            yield custom_id, _parse_batch_entry(entry)

    def batch_cancel(self, batch_id: str) -> None:
        try:
            self._batches.batches.cancel(batch_id)
        except self._sdk.APIStatusError:
            # Already finished — nothing left to cancel.
            pass

    def batch_cleanup(self, batch_id: str, file_id: str | None) -> None:
        # The input file holds every image of the part as base64.
        if not file_id:
            return
        try:
            self._batches.files.delete(file_id)
        except self._sdk.OpenAIError:
            pass


def _parse_batch_entry(entry: dict) -> ProviderResult:
    try:
        error = entry.get("error")
        if error:
            code = str(error.get("code") or "error")
            return ProviderResult(error=code, retryable=code in _UNANSWERED)
        response = entry.get("response") or {}
        body = response.get("body") or {}
        status = response.get("status_code")
        if status != 200:
            err = body.get("error") or {}
            detail = f"{err.get('code') or status}: {err.get('message', '')}"
            return ProviderResult(
                error=detail[:300],
                retryable=isinstance(status, int)
                and (status >= 500 or status in _RETRYABLE_STATUS),
            )
        return _parse_body(body)
    except (AttributeError, TypeError, ValueError):
        return ProviderResult(error="unreadable_result")


def _parse_body(body: dict) -> ProviderResult:
    """A Responses API response object, as a plain dict."""
    raw = body.get("usage") or {}
    details = raw.get("input_tokens_details") or {}
    cached = int(details.get("cached_tokens") or 0)
    written = int(details.get("cache_write_tokens") or 0)
    usage = Usage(
        # OpenAI's input_tokens includes the cached and cache-written
        # tokens; ours is what was billed at the plain rate.
        input_tokens=max(0, int(raw.get("input_tokens") or 0) - cached - written),
        cache_read_tokens=cached,
        cache_write_tokens=written,
        output_tokens=int(raw.get("output_tokens") or 0),
        reasoning_tokens=int(
            (raw.get("output_tokens_details") or {}).get("reasoning_tokens") or 0
        ),
        requests=1,
    )
    # The tier the request was actually served (and billed) at. A Flex
    # request OpenAI had no Flex capacity for is served as standard and
    # says so here; only "flex" earns the discount on the books.
    tier = body.get("service_tier")
    discounted = (tier == "flex") if tier else None
    status = body.get("status")
    if status == "incomplete":
        reason = (body.get("incomplete_details") or {}).get("reason") or "incomplete"
        return ProviderResult(
            usage=usage,
            error="max_tokens" if reason == "max_output_tokens" else reason,
            discounted=discounted,
        )
    if status == "failed":
        err = body.get("error") or {}
        code = str(err.get("code") or "failed")
        return ProviderResult(
            usage=usage, error=code, retryable=code in _SERVER_SIDE, discounted=discounted
        )

    texts: list[str] = []
    for item in body.get("output") or []:
        if item.get("type") != "message":
            continue
        for part in item.get("content") or []:
            if part.get("type") == "refusal":
                return ProviderResult(usage=usage, error="refusal", discounted=discounted)
            if part.get("type") == "output_text":
                texts.append(part.get("text") or "")
    if not texts:
        return ProviderResult(usage=usage, error="empty_answer", discounted=discounted)
    return ProviderResult(text="".join(texts), usage=usage, discounted=discounted)
