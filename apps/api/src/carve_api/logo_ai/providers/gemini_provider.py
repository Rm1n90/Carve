# Armin Mehri — mehri.armin@gmail.com
"""Google Gemini adapter: generateContent (realtime / flex) + Batch API.

Spoken to over the Gemini REST API rather than Google's SDK, so that
every retry is this module's own decision: nothing resends a request
that was already paid for behind our back, a Flex request is only ever
sent again as Flex, and creating a batch (which is not idempotent) is
tried exactly once. The transport is the same dead-link-aware one the
other adapters use.

Gemini specifics, read from Google's docs on 2026-10-23:

* Boxes are asked for in Gemini's own convention, ``[ymin, xmin, ymax,
  xmax]`` normalised to 0..1000 (``catalog.COORDS_BOX1000``).
* An image is billed a fixed number of tokens set by the media
  resolution it is sent with (per part), not by its pixel size.
* Caching is implicit only: a request whose prefix (system instruction,
  reference crops) matches a recent one is billed the cached rate for it,
  with no charge to write the cache, from 4,096 prompt tokens on. The
  prefix is kept byte-identical across a run and the target image goes
  after it.
* Flex is ``"service_tier": "flex"`` on a realtime request, at the batch
  price. Google never upgrades a Flex request to standard; with no Flex
  capacity it answers 503 (or 429) and the run waits. The response's
  ``usageMetadata.serviceTier`` says the tier that served it.
* A batch is a JSONL file uploaded to the Files API, started with
  ``batchGenerateContent``. Its ``display_name`` carries the part's tag,
  so an interrupted create is found again instead of being sent twice.
  It ends within 48 hours or expires unrun (and uncharged).
"""

from __future__ import annotations

import base64
import json
import logging
import random
import time
from collections.abc import Iterator
from datetime import datetime, timedelta

from carve_api.logo_ai import catalog
from carve_api.logo_ai.prompt import REFERENCE_INTRO, reference_label
from carve_api.logo_ai.providers.base import (
    OUT_OF_CREDIT,
    BatchGone,
    BatchState,
    ProviderClient,
    ProviderFatal,
    ProviderResult,
    RunContext,
    Usage,
    api_error_message,
    is_out_of_credit,
    live_connection_transport,
)

log = logging.getLogger(__name__)

_BASE = "https://generativelanguage.googleapis.com"
_API = f"{_BASE}/v1beta"
_UPLOAD = f"{_BASE}/upload/v1beta/files"
_DOWNLOAD = f"{_BASE}/download/v1beta"

# Thinking counts against this, so a low ceiling can end a response
# before any visible output is written. Only what is generated is billed.
_MAX_OUTPUT_TOKENS = 32768
# Realtime and Flex: Flex may queue for minutes, and Google asks for
# client timeouts of 10 minutes or more. Batch bookkeeping answers
# quickly or not at all.
_READ_TIMEOUT = 900.0
_BOOKKEEPING_TIMEOUT = 300.0
_CONNECT_TIMEOUT = 15.0
# Resends of a realtime request, as the other adapters' SDKs do.
_SEND_RETRIES = 4
_BOOKKEEPING_RETRIES = 1
# Statuses that are not a verdict on the request: sending it again can
# succeed.
_RETRYABLE_STATUS = frozenset({408, 409, 429, 500, 502, 503, 504})
# google.rpc status names of the same kind, as batch result lines carry.
_RETRYABLE_RPC = frozenset(
    {"RESOURCE_EXHAUSTED", "UNAVAILABLE", "INTERNAL", "DEADLINE_EXCEEDED", "ABORTED"}
)
_RETRYABLE_RPC_CODES = frozenset({4, 8, 10, 13, 14})
# A batch that has finished one way or another.
_BATCH_ENDED = frozenset({"SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"})
# A batch not finished within this is expired by Google, unrun.
_BATCH_LIFETIME = timedelta(hours=48)
# A batch is searched for from a little before the part was recorded:
# the two clocks are not the same clock.
_FIND_SLACK_SECONDS = 300
# The answer ended for a reason that is a verdict on the content.
_REFUSED = frozenset(
    {
        "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
        "BLOCKED", "CONTENT_FILTER", "IMAGE_SAFETY", "LANGUAGE",
    }
)


class APIError(Exception):
    """An error answer from the Gemini API, shaped like the vendor SDKs'
    errors (``status_code``, decoded ``body``, ``code``) so the run's own
    handling reads it the same way."""

    def __init__(self, status_code: int, body: dict | str) -> None:
        self.status_code = status_code
        self.body = body if isinstance(body, dict) else {"error": {"message": str(body)[:500]}}
        inner = self.body.get("error") if isinstance(self.body.get("error"), dict) else {}
        # The google.rpc status name, e.g. RESOURCE_EXHAUSTED.
        self.code = inner.get("status")
        self.message = str(inner.get("message") or "")
        super().__init__(f"{status_code} {self.code or ''}: {self.message}".strip())

    @property
    def reasons(self) -> set[str]:
        inner = self.body.get("error") or {}
        return {
            str(d.get("reason"))
            for d in inner.get("details") or []
            if isinstance(d, dict) and d.get("reason")
        }


class APIConnectionError(Exception):
    """No answer came at all. Named as in the vendor SDKs: the run takes
    an error of this name for a provider that cannot be reached."""


class APITimeoutError(APIConnectionError):
    """The answer did not come within the timeout."""


def _image_part(jpeg: bytes, level: str) -> dict:
    return {
        "inlineData": {
            "mimeType": "image/jpeg",
            "data": base64.standard_b64encode(jpeg).decode("ascii"),
        },
        "mediaResolution": {"level": level},
    }


def _generation_config(schema: dict, effort: str | None) -> dict:
    config: dict = {
        "responseMimeType": "application/json",
        "responseJsonSchema": schema,
        "maxOutputTokens": _MAX_OUTPUT_TOKENS,
    }
    if effort:
        config["thinkingConfig"] = {"thinkingLevel": effort}
    return config


def _batch_state_name(op: dict) -> str:
    """JOB_STATE_SUCCEEDED / BATCH_STATE_SUCCEEDED → SUCCEEDED."""
    meta = op.get("metadata") or {}
    state = str(meta.get("state") or op.get("state") or "")
    for prefix in ("JOB_STATE_", "BATCH_STATE_"):
        if state.startswith(prefix):
            return state[len(prefix):]
    return state


def _time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


class GeminiClient(ProviderClient):
    def __init__(self, ctx: RunContext, api_key: str) -> None:
        super().__init__(ctx)
        self._api_key = api_key
        import httpx2

        self._httpx = httpx2
        self._http = httpx2.Client(
            timeout=httpx2.Timeout(_READ_TIMEOUT, connect=_CONNECT_TIMEOUT),
            transport=live_connection_transport(),
            headers={"x-goog-api-key": api_key},
        )
        self._sleep = time.sleep

    def _with_context(self, ctx: RunContext) -> GeminiClient:
        return GeminiClient(ctx, self._api_key)

    # --- HTTP -----------------------------------------------------------

    def _call(
        self,
        method: str,
        url: str,
        *,
        retries: int,
        timeout: float | None = None,
        **kwargs,
    ):  # noqa: ANN202 — httpx2.Response
        """One request, sent again up to ``retries`` times while the
        answer says it can succeed later. Raises :class:`APIError` for an
        error answer, :class:`APIConnectionError` when none came."""
        httpx2 = self._httpx
        if timeout is not None:
            kwargs["timeout"] = httpx2.Timeout(timeout, connect=_CONNECT_TIMEOUT)
        attempt = 0
        while True:
            wait = None
            try:
                response = self._http.request(method, url, **kwargs)
            except httpx2.TimeoutException as exc:
                error: Exception = APITimeoutError(str(exc) or "timed out")
            except httpx2.TransportError as exc:
                error = APIConnectionError(str(exc) or type(exc).__name__)
            else:
                if response.status_code < 400:
                    return response
                try:
                    body = response.json()
                except ValueError:
                    body = response.text
                error = APIError(response.status_code, body)
                # Out of credit clears only when credit is added: asking
                # again now changes nothing.
                if response.status_code not in _RETRYABLE_STATUS or is_out_of_credit(error):
                    raise error
                retry_after = response.headers.get("retry-after")
                if retry_after and retry_after.isdigit():
                    wait = min(float(retry_after), 60.0)
            if attempt >= retries:
                raise error
            if wait is None:
                # Jitter, not secrecy.
                jitter = 0.75 + random.random() / 2  # noqa: S311
                wait = min(8.0, 0.5 * 2**attempt) * jitter
            self._sleep(wait)
            attempt += 1

    # --- requests -------------------------------------------------------

    def build_request(self, image_jpeg: bytes, request_text: str, *, batch: bool) -> dict:
        ctx = self.ctx
        level = catalog.GEMINI_MEDIA_RESOLUTION.get(
            ctx.detail, catalog.GEMINI_MEDIA_RESOLUTION[catalog.DEFAULT_DETAIL]
        )[0]
        # The system instruction and the reference crops are the cached
        # prefix: identical in every request of the run, ahead of the one
        # part that is new each time.
        parts: list[dict] = []
        if ctx.references:
            ref_level = catalog.GEMINI_REFERENCE_RESOLUTION[0]
            parts.append({"text": REFERENCE_INTRO})
            for ref in ctx.references:
                label = reference_label(ref.class_index + 1, ctx.classes[ref.class_index])
                parts.append({"text": label})
                parts.append(_image_part(ref.jpeg, ref_level))
        parts.append(_image_part(image_jpeg, level))
        parts.append({"text": request_text})
        body: dict = {
            "systemInstruction": {"parts": [{"text": ctx.system_text}]},
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": _generation_config(ctx.schema, ctx.effort),
        }
        if ctx.flex and not batch:
            body["service_tier"] = "flex"
        return body

    def build_check_request(
        self, sheet_jpeg: bytes, request_text: str, *, system_text: str, schema: dict
    ) -> dict:
        ctx = self.ctx
        body: dict = {
            "systemInstruction": {"parts": [{"text": system_text}]},
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        _image_part(sheet_jpeg, catalog.GEMINI_MEDIA_RESOLUTION["standard"][0]),
                        {"text": request_text},
                    ],
                }
            ],
            "generationConfig": _generation_config(schema, ctx.effort),
        }
        if ctx.flex:
            body["service_tier"] = "flex"
        return body

    def send(self, request: dict) -> ProviderResult:
        flex = request.get("service_tier") == "flex"
        url = f"{_API}/models/{self.ctx.model.id}:generateContent"
        try:
            # A Flex request Google has no Flex capacity for comes back
            # 503 or 429, uncharged. It is sent again as Flex only, never
            # at the standard price: the run was priced at Flex, and the
            # run knows how to wait.
            response = self._call("POST", url, json=request, retries=_SEND_RETRIES)
        except APIError as exc:
            if is_out_of_credit(exc):
                return ProviderResult(error=OUT_OF_CREDIT)
            fatal = self._fatal(exc)
            if fatal is not None:
                raise fatal from exc
            if exc.status_code == 400:
                return ProviderResult(error=f"bad_request: {api_error_message(exc)}"[:300])
            if exc.status_code == 429 or (flex and exc.status_code == 503):
                return ProviderResult(error="rate_limited")
            return ProviderResult(error=f"provider_error_{exc.status_code}")
        except APIConnectionError:
            return ProviderResult(error="provider_unreachable")
        try:
            body = response.json()
        except ValueError:
            return ProviderResult(error="unreadable_result")
        return _parse_body(body)

    def _fatal(self, exc: APIError) -> ProviderFatal | None:
        """The error as one every request of the run would get, or
        ``None``."""
        message = api_error_message(exc)
        if (
            exc.status_code in (401, 403)
            or "API_KEY_INVALID" in exc.reasons
            or "api key not valid" in message.lower()
        ):
            return ProviderFatal(f"Google rejected the API key: {message}")
        if exc.status_code == 404:
            return ProviderFatal(f"Gemini model not available: {message}")
        if exc.code == "FAILED_PRECONDITION":
            # e.g. billing not enabled, or the API not offered where the
            # server is.
            return ProviderFatal(f"Google refused the request: {message}")
        return None

    # --- batch ----------------------------------------------------------

    def _refusal(self, exc: Exception) -> ProviderFatal | None:
        """A batch-call error as a refusal, or ``None`` if it is worth
        trying again."""
        if not isinstance(exc, APIError) or is_out_of_credit(exc):
            return None  # the same batch is fine once the account can pay
        fatal = self._fatal(exc)
        if fatal is not None:
            return fatal
        if exc.status_code not in _RETRYABLE_STATUS:
            return ProviderFatal(f"Google rejected the batch: {api_error_message(exc)}")
        return None

    def _upload(self, payload: bytes, tag: str) -> str:
        """The batch input file, uploaded; its name (``files/...``)."""
        start = self._call(
            "POST",
            _UPLOAD,
            retries=_BOOKKEEPING_RETRIES,
            timeout=_BOOKKEEPING_TIMEOUT,
            headers={
                "X-Goog-Upload-Protocol": "resumable",
                "X-Goog-Upload-Command": "start",
                "X-Goog-Upload-Header-Content-Length": str(len(payload)),
                "X-Goog-Upload-Header-Content-Type": "application/jsonl",
            },
            json={"file": {"display_name": f"logo-ai-{tag}"}},
        )
        upload_url = start.headers.get("x-goog-upload-url")
        if not upload_url:
            raise APIConnectionError("the Files API gave no upload URL")
        done = self._call(
            "POST",
            upload_url,
            retries=_BOOKKEEPING_RETRIES,
            timeout=_BOOKKEEPING_TIMEOUT,
            headers={"X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize"},
            content=payload,
        )
        return str(done.json()["file"]["name"])

    def _start_batch(self, file_name: str, tag: str) -> str:
        # Not retried. Creating a batch is not idempotent: a retry after
        # an answer that got lost on the way back would make a second
        # batch, and both would be billed. The caller looks the batch up
        # by its tag (the display name) before it tries again.
        response = self._call(
            "POST",
            f"{_API}/models/{self.ctx.model.id}:batchGenerateContent",
            retries=0,
            timeout=_BOOKKEEPING_TIMEOUT,
            json={"batch": {"display_name": tag, "input_config": {"file_name": file_name}}},
        )
        return str(response.json()["name"])

    def batch_create(
        self, requests: list[tuple[str, dict]], *, tag: str
    ) -> tuple[str, str | None]:
        lines = [
            json.dumps({"key": cid, "request": body}, separators=(",", ":"))
            for cid, body in requests
        ]
        payload = ("\n".join(lines) + "\n").encode("utf-8")
        uploaded = None
        try:
            uploaded = self._upload(payload, tag)
            batch_id = self._start_batch(uploaded, tag)
        except (APIError, APIConnectionError) as exc:
            refusal = self._refusal(exc)
            if refusal is None:
                if uploaded is not None:
                    # The images are already over there. Say where, so
                    # the next attempt starts from that file instead of
                    # leaving it behind and uploading another.
                    exc.uploaded_file_id = uploaded  # type: ignore[attr-defined]
                raise
            raise refusal from exc
        return batch_id, uploaded

    def batch_create_from_file(self, file_id: str, *, tag: str) -> str | None:
        try:
            return self._start_batch(file_id, tag)
        except APIError as exc:
            if exc.status_code == 404 or (exc.status_code == 400 and self._fatal(exc) is None):
                # Uploaded files live 48 hours: gone, or no longer
                # accepted. Upload it again (a model that is really gone
                # is refused then, on a fresh create).
                return None
            refusal = self._refusal(exc)
            if refusal is None:
                raise
            raise refusal from exc

    def batch_find(
        self, tag: str, *, request_count: int, since: datetime, known: set[str]
    ) -> tuple[str, str | None] | None:
        oldest = since.timestamp() - _FIND_SLACK_SECONDS
        older = 0
        token = None
        # Newest first. It stops a page's worth past the time the part
        # was recorded rather than at the first older batch, so it does
        # not depend on the order being exact.
        while True:
            params = {"pageSize": 100}
            if token:
                params["pageToken"] = token
            page = self._call(
                "GET", f"{_API}/batches", retries=_BOOKKEEPING_RETRIES,
                timeout=_BOOKKEEPING_TIMEOUT, params=params,
            ).json()
            for op in page.get("operations") or page.get("batches") or []:
                meta = op.get("metadata") or op
                if (meta.get("displayName") or meta.get("display_name")) == tag:
                    source = meta.get("inputConfig") or meta.get("input_config") or {}
                    return str(op["name"]), source.get("fileName") or source.get("file_name")
                created = _time(meta.get("createTime"))
                if created is not None and created.timestamp() < oldest:
                    older += 1
                    if older >= 100:
                        return None
            token = page.get("nextPageToken")
            if not token:
                return None

    def _batch(self, batch_id: str) -> dict:
        try:
            return self._call(
                "GET", f"{_API}/{batch_id}", retries=_BOOKKEEPING_RETRIES,
                timeout=_BOOKKEEPING_TIMEOUT,
            ).json()
        except APIError as exc:
            if exc.status_code == 404:
                raise BatchGone(api_error_message(exc)) from exc
            raise

    def batch_state(self, batch_id: str) -> BatchState:
        op = self._batch(batch_id)
        meta = op.get("metadata") or {}
        state = _batch_state_name(op)
        stats = meta.get("batchStats") or {}
        total = int(stats.get("requestCount") or 0)
        succeeded = int(stats.get("successfulRequestCount") or 0)
        failed = int(stats.get("failedRequestCount") or 0)
        failed_reason = None
        queue_full = False
        if state in ("FAILED", "EXPIRED") and succeeded == 0:
            err = op.get("error") or {}
            detail = str(err.get("message") or "")
            exhausted = (
                err.get("code") == 8
                or "RESOURCE_EXHAUSTED" in detail
                or "quota" in detail.lower()
            )
            if state == "EXPIRED" or exhausted:
                # Nothing ran: the queue had no room, or the 48 hours ran
                # out first. Nothing was charged; it can go again.
                queue_full = True
                failed_reason = (
                    "Google did not run this batch (its queue for the model was "
                    "full, or the batch expired); nothing was charged for these "
                    f"images.{f' ({detail})' if detail else ''}"
                )
            else:
                failed_reason = detail or "batch failed"
        created = _time(meta.get("createTime"))
        return BatchState(
            ended=state in _BATCH_ENDED,
            total=total,
            finished=succeeded + failed,
            failed_reason=failed_reason[:400] if failed_reason else None,
            expires_at=created + _BATCH_LIFETIME if created else None,
            queue_full=queue_full,
        )

    def batch_download(self, batch_id: str) -> bytes:
        op = self._batch(batch_id)
        meta = op.get("metadata") or {}
        output = meta.get("output") or op.get("response") or {}
        file_name = output.get("responsesFile") or output.get("responses_file")
        if not file_name:
            inlined = output.get("inlinedResponses") or {}
            entries = inlined.get("inlinedResponses") if isinstance(inlined, dict) else inlined
            if entries:
                return "\n".join(
                    json.dumps(e, separators=(",", ":")) for e in entries
                ).encode("utf-8")
            stats = meta.get("batchStats") or {}
            if int(stats.get("successfulRequestCount") or 0) > 0:
                # Answers exist but their file is not attached yet.
                # Reading now would record them as missing, for good.
                raise RuntimeError("batch output file is not available yet")
            return b""
        try:
            return self._call(
                "GET", f"{_DOWNLOAD}/{file_name}:download", retries=_BOOKKEEPING_RETRIES,
                timeout=_BOOKKEEPING_TIMEOUT, params={"alt": "media"},
            ).content
        except APIError as exc:
            if exc.status_code == 404:
                raise BatchGone(api_error_message(exc)) from exc
            raise

    def batch_parse(self, raw: bytes) -> Iterator[tuple[str, ProviderResult]]:
        for line in raw.decode("utf-8").splitlines():
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                key = str(entry.get("key") or (entry.get("metadata") or {}).get("key"))
                if key == "None":
                    raise KeyError("key")
            except (ValueError, TypeError, KeyError, AttributeError):
                # One unreadable line must not cost the other answers of
                # the batch; its request is reported as unanswered.
                log.warning("logo_ai.gemini.batch_line_unreadable")
                continue
            yield key, _parse_batch_entry(entry)

    def batch_cancel(self, batch_id: str) -> None:
        try:
            self._call(
                "POST", f"{_API}/{batch_id}:cancel", retries=_BOOKKEEPING_RETRIES,
                timeout=_BOOKKEEPING_TIMEOUT,
            )
        except APIError:
            # Already finished — nothing left to cancel.
            pass

    def batch_cleanup(self, batch_id: str, file_id: str | None) -> None:
        # The input file holds every image of the part as base64.
        if not file_id:
            return
        try:
            self._call(
                "DELETE", f"{_API}/{file_id}", retries=0, timeout=_BOOKKEEPING_TIMEOUT
            )
        except (APIError, APIConnectionError):
            pass


def _parse_batch_entry(entry: dict) -> ProviderResult:
    try:
        error = entry.get("error") or entry.get("status")
        response = entry.get("response")
        if error and not response:
            code = error.get("code")
            status = str(error.get("status") or "")
            message = str(error.get("message") or "")
            out_of_credit = any(
                w in message.lower() for w in ("prepayment", "prepaid", "credits are depleted")
            )
            return ProviderResult(
                error=f"{status or code or 'error'}: {message}"[:300],
                retryable=out_of_credit
                or status in _RETRYABLE_RPC
                or code in _RETRYABLE_RPC_CODES
                or (isinstance(code, int) and code in _RETRYABLE_STATUS),
            )
        # Billed at the batch rate whatever tier the line names.
        return _parse_body(response or {}, served_tier=False)
    except (AttributeError, TypeError, ValueError):
        return ProviderResult(error="unreadable_result")


def _parse_body(body: dict, *, served_tier: bool = True) -> ProviderResult:
    """A generateContent response, as a plain dict. ``served_tier``:
    whether the tier it names decides the price (realtime and Flex)."""
    meta = body.get("usageMetadata") or {}
    prompt = int(meta.get("promptTokenCount") or 0) + int(meta.get("toolUsePromptTokenCount") or 0)
    cached = int(meta.get("cachedContentTokenCount") or 0)
    thoughts = int(meta.get("thoughtsTokenCount") or 0)
    usage = Usage(
        # promptTokenCount includes the cached part; ours is what was
        # billed at the plain rate. Thinking is billed as output.
        input_tokens=max(0, prompt - cached),
        cache_read_tokens=cached,
        output_tokens=int(meta.get("candidatesTokenCount") or 0) + thoughts,
        reasoning_tokens=thoughts,
        requests=1,
    )
    # The tier the request was actually served (and billed) at; only
    # Flex earns the discount on the books.
    discounted = None
    if served_tier:
        tier = str(meta.get("serviceTier") or body.get("serviceTier") or "").lower()
        if "flex" in tier:
            discounted = True
        elif "standard" in tier or "priority" in tier:
            discounted = False

    feedback = body.get("promptFeedback") or {}
    if feedback.get("blockReason"):
        return ProviderResult(usage=usage, error="refusal", discounted=discounted)
    candidates = body.get("candidates") or []
    if not candidates:
        return ProviderResult(usage=usage, error="empty_answer", discounted=discounted)
    candidate = candidates[0]
    finish = str(candidate.get("finishReason") or "")
    texts = [
        str(part.get("text") or "")
        for part in (candidate.get("content") or {}).get("parts") or []
        if part.get("text") and not part.get("thought")
    ]
    if finish == "MAX_TOKENS":
        return ProviderResult(usage=usage, error="max_tokens", discounted=discounted)
    if finish in _REFUSED:
        return ProviderResult(usage=usage, error="refusal", discounted=discounted)
    if not texts:
        reason = f"finish_{finish.lower()}" if finish and finish != "STOP" else "empty_answer"
        return ProviderResult(usage=usage, error=reason, discounted=discounted)
    return ProviderResult(text="".join(texts), usage=usage, discounted=discounted)
