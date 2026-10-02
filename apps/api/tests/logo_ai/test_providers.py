# Armin Mehri — mehri.armin@gmail.com
"""Provider adapters, driven through the real SDKs over a mock transport.

No network: each SDK client is given an ``httpx2.MockTransport``, so
these assert what actually goes on the wire — that the SDK accepts our
parameters and where they land — and that responses, refusals and
errors come back as the right ``ProviderResult``.
"""

import json
from datetime import UTC, datetime

import anthropic
import httpx2
import openai
import pytest

from carve_api.logo_ai import catalog
from carve_api.logo_ai.prompt import TargetClass, build_schema, build_system_text
from carve_api.logo_ai.providers.anthropic_provider import AnthropicClient
from carve_api.logo_ai.providers.base import (
    BatchGone,
    ProviderFatal,
    Reference,
    RunContext,
    Usage,
)
from carve_api.logo_ai.providers.openai_provider import OpenAIClient

_CLASSES = [TargetClass("c1", "Acme", "red circle wordmark")]
_JPEG = b"\xff\xd8\xff\xe0fakejpeg"
_ANSWER = '{"detections":[[1,2,30,40,90,100]]}'


def _ctx(provider_id: str, model_id: str, *, effort="medium", refs=False, flex=False) -> RunContext:
    provider = catalog.get_provider(provider_id)
    model = catalog.get_model(provider_id, model_id)
    return RunContext(
        provider=provider,
        model=model,
        effort=catalog.resolve_effort(model, effort),
        classes=_CLASSES,
        references=[Reference(0, _JPEG)] if refs else [],
        system_text=build_system_text(_CLASSES, provider.coords),
        schema=build_schema(1, provider.coords, numeric_bounds=provider_id == "openai"),
        flex=flex,
        coords=provider.coords,
    )


class _Wire:
    """Records requests and replays canned responses by (method, path)."""

    def __init__(self, routes: dict) -> None:
        self.routes = routes
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        reply = self.routes[(request.method, request.url.path)]
        if isinstance(reply, list):
            reply = reply.pop(0)
        status, body = reply
        if isinstance(body, str | bytes):
            return httpx2.Response(status, content=body)
        return httpx2.Response(status, json=body)

    def body(self, i: int = -1) -> dict:
        return json.loads(self.requests[i].content)


# --- Anthropic -------------------------------------------------------------


def _message(text=_ANSWER, stop_reason="end_turn") -> dict:
    return {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "claude-opus-5-5",
        "content": [{"type": "text", "text": text}],
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {
            "input_tokens": 1800,
            "cache_read_input_tokens": 900,
            "cache_creation_input_tokens": 0,
            "output_tokens": 60,
        },
    }


def _anthropic(ctx: RunContext, wire: _Wire) -> AnthropicClient:
    client = AnthropicClient(ctx, "sk-ant-test")
    client._client = anthropic.Anthropic(
        api_key="sk-ant-test",
        max_retries=0,
        http_client=anthropic.DefaultHttpxClient(transport=httpx2.MockTransport(wire)),
    )
    return client


def test_anthropic_request_shape_and_result() -> None:
    wire = _Wire({("POST", "/v1/messages"): (200, _message())})
    client = _anthropic(_ctx("anthropic", "claude-opus-5-5", refs=True), wire)
    result = client.send(client.build_request(_JPEG, "The image is 56x28.", batch=False))

    assert result.error is None and result.text == _ANSWER
    assert result.usage == Usage(
        input_tokens=1800, cache_read_tokens=900, cache_write_tokens=0, output_tokens=60,
        requests=1,
    )

    body = wire.body()
    request = wire.requests[-1]
    # Refusal fallback: beta header + body parameter.
    assert "server-side-fallback-2026-07-01" in request.headers["anthropic-beta"]
    assert body["fallbacks"] == "default"
    # Strict JSON schema + effort live in output_config.
    assert body["output_config"]["format"]["type"] == "json_schema"
    assert body["output_config"]["format"]["schema"]["additionalProperties"] is False
    assert body["output_config"]["effort"] == "medium"
    # Thinking is adaptive by default on this model; nothing to send, and
    # sampling parameters are rejected by it.
    for key in ("thinking", "temperature", "top_p", "tool_choice"):
        assert key not in body

    # Cached prefix: the rubric, then the reference crops.
    assert body["system"][0]["cache_control"] == {"type": "ephemeral"}
    content = body["messages"][0]["content"]
    assert [b["type"] for b in content] == ["text", "text", "image", "image", "text"]
    assert content[2]["cache_control"] == {"type": "ephemeral"}
    # Per-request suffix: the target image (never resized server-side)
    # and the size line, neither of them cached.
    assert content[3]["transformations"] == {"oversized_image": "error"}
    assert "cache_control" not in content[3] and "cache_control" not in content[4]
    assert content[4]["text"] == "The image is 56x28."


def test_anthropic_prefix_is_identical_across_requests() -> None:
    client = AnthropicClient(_ctx("anthropic", "claude-opus-5-5", refs=True), "k")
    a = client.build_request(b"image-one", "size A", batch=False)
    b = client.build_request(b"image-two", "size B", batch=False)
    assert a["system"] == b["system"]
    assert a["messages"][0]["content"][:3] == b["messages"][0]["content"][:3]
    assert a["output_config"] == b["output_config"]


def test_anthropic_haiku_gets_no_effort_and_no_fallback() -> None:
    wire = _Wire({("POST", "/v1/messages"): (200, _message())})
    client = _anthropic(_ctx("anthropic", "claude-haiku-4-5"), wire)
    client.send(client.build_request(_JPEG, "x", batch=False))
    body = wire.body()
    assert "effort" not in body["output_config"]
    assert "fallbacks" not in body
    assert "anthropic-beta" not in wire.requests[-1].headers


@pytest.mark.parametrize("stop_reason", ["refusal", "max_tokens"])
def test_anthropic_unusable_answers_are_errors_but_still_billed(stop_reason) -> None:
    wire = _Wire({("POST", "/v1/messages"): (200, _message("{", stop_reason))})
    client = _anthropic(_ctx("anthropic", "claude-opus-5-5"), wire)
    result = client.send(client.build_request(_JPEG, "x", batch=False))
    assert result.text is None and result.error == stop_reason
    assert result.usage.output_tokens == 60


def _api_error(kind: str) -> dict:
    return {"type": "error", "error": {"type": kind, "message": "nope"}}


def test_anthropic_error_mapping() -> None:
    def send(status: int, kind: str):
        wire = _Wire({("POST", "/v1/messages"): (status, _api_error(kind))})
        client = _anthropic(_ctx("anthropic", "claude-opus-5-5"), wire)
        return client.send(client.build_request(_JPEG, "x", batch=False))

    # The provider's own message, not the SDK's status-line-and-body dump.
    assert send(400, "invalid_request_error").error == "bad_request: nope"
    assert send(429, "rate_limit_error").error == "rate_limited"
    assert send(529, "overloaded_error").error == "provider_error_529"
    # A bad key or unknown model repeats for every request: stop the run.
    with pytest.raises(ProviderFatal) as excinfo:
        send(401, "authentication_error")
    assert excinfo.value.message == "Anthropic rejected the API key: nope"
    with pytest.raises(ProviderFatal):
        send(404, "not_found_error")


def _batch(status: str, **counts) -> dict:
    base = {"processing": 0, "succeeded": 0, "errored": 0, "canceled": 0, "expired": 0}
    return {
        "id": "msgbatch_1",
        "type": "message_batch",
        "processing_status": status,
        "request_counts": {**base, **counts},
        "created_at": "2026-09-30T10:00:00Z",
        "expires_at": "2026-10-01T10:00:00Z",
        "ended_at": None,
        "archived_at": None,
        "cancel_initiated_at": None,
        "results_url": "https://api.anthropic.com/v1/messages/batches/msgbatch_1/results",
    }


def test_anthropic_batch_roundtrip() -> None:
    results = "\n".join(
        json.dumps(line)
        for line in [
            {"custom_id": "0_0", "result": {"type": "succeeded", "message": _message()}},
            {
                "custom_id": "1_0",
                "result": {"type": "errored", "error": _api_error("invalid_request_error")},
            },
            {"custom_id": "2_0", "result": {"type": "expired"}},
        ]
    )
    wire = _Wire(
        {
            ("POST", "/v1/messages/batches"): (200, _batch("in_progress", processing=3)),
            ("GET", "/v1/messages/batches/msgbatch_1"): [
                (200, _batch("in_progress", processing=3)),
                (200, _batch("ended", succeeded=1, errored=1, expired=1)),
                (200, _batch("ended", succeeded=1, errored=1, expired=1)),
            ],
            ("GET", "/v1/messages/batches/msgbatch_1/results"): (200, results),
            ("POST", "/v1/messages/batches/msgbatch_1/cancel"): (200, _batch("canceling")),
        }
    )
    client = _anthropic(_ctx("anthropic", "claude-opus-5-5"), wire)
    requests = [
        (f"{i}_0", client.build_request(_JPEG, "x", batch=True)) for i in range(3)
    ]
    batch_id, file_id = client.batch_create(requests, tag="part-1")
    assert (batch_id, file_id) == ("msgbatch_1", None)

    sent = wire.body(0)["requests"]
    assert [r["custom_id"] for r in sent] == ["0_0", "1_0", "2_0"]
    params = sent[0]["params"]
    # A batch can queue past 5 minutes: the prefix is cached for an hour.
    assert params["system"][0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    # The Batches API rejects the fallback parameter.
    assert "fallbacks" not in params and "betas" not in params
    assert "stream" not in params

    running = client.batch_state(batch_id)
    assert (running.ended, running.total, running.finished) == (False, 3, 0)
    done = client.batch_state(batch_id)
    assert (done.ended, done.total, done.finished) == (True, 3, 3)
    assert done.expires_at is not None

    got = dict(client.batch_results(batch_id))
    assert got["0_0"].text == _ANSWER
    assert got["1_0"].error.startswith("invalid_request_error")
    assert got["2_0"].error == "expired"
    # A request the batch never ran can be sent again; a refused one cannot.
    assert got["2_0"].retryable and not got["1_0"].retryable and not got["0_0"].retryable

    client.batch_cancel(batch_id)
    assert wire.requests[-1].url.path.endswith("/cancel")


# --- OpenAI ----------------------------------------------------------------


def _response(text=_ANSWER, status="completed", **extra) -> dict:
    return {
        "id": "resp_1",
        "object": "response",
        "created_at": 0,
        "status": status,
        "model": "gpt-6.1-sol",
        "output": [
            {
                "type": "message",
                "id": "msg_1",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
            }
        ],
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        "usage": {
            "input_tokens": 3000,
            "input_tokens_details": {"cached_tokens": 1100, "cache_write_tokens": 0},
            "output_tokens": 80,
            "output_tokens_details": {"reasoning_tokens": 40},
            "total_tokens": 3080,
        },
        **extra,
    }


def _openai(ctx: RunContext, wire: _Wire) -> OpenAIClient:
    client = OpenAIClient(ctx, "sk-test")
    client._client = openai.OpenAI(
        api_key="sk-test",
        max_retries=0,
        http_client=openai.DefaultHttpx2Client(transport=httpx2.MockTransport(wire)),
    )
    return client


def test_openai_request_shape_and_result() -> None:
    wire = _Wire({("POST", "/v1/responses"): (200, _response())})
    client = _openai(_ctx("openai", "gpt-6.1-sol", refs=True), wire)
    result = client.send(client.build_request(_JPEG, "annotate", batch=False))

    assert result.error is None and result.text == _ANSWER
    # OpenAI's input_tokens includes cached ones; ours must not.
    assert result.usage == Usage(
        input_tokens=1900, cache_read_tokens=1100, cache_write_tokens=0, output_tokens=80,
        reasoning_tokens=40, requests=1,
    )

    body = wire.body()
    fmt = body["text"]["format"]
    assert (fmt["type"], fmt["strict"], fmt["name"]) == ("json_schema", True, "logo_detections")
    row = fmt["schema"]["properties"]["detections"]["items"]
    assert (row["minItems"], row["maxItems"], row["items"]["maximum"]) == (6, 6, 999)
    assert body["reasoning"] == {"effort": "medium"}
    assert body["store"] is False
    assert "service_tier" not in body

    # Explicit-only caching: breakpoints end the stable prefix, so the
    # unique image after them is never written to the cache.
    assert body["prompt_cache_options"] == {"mode": "explicit"}
    developer, user = body["input"]
    assert developer["role"] == "developer"
    assert developer["content"][0]["prompt_cache_breakpoint"] == {"mode": "explicit"}
    parts = user["content"]
    assert [p["type"] for p in parts] == [
        "input_text", "input_text", "input_image", "input_image", "input_text",
    ]
    assert parts[2]["prompt_cache_breakpoint"] == {"mode": "explicit"}
    assert "prompt_cache_breakpoint" not in parts[3]
    assert parts[3]["detail"] == "high"
    assert parts[3]["image_url"].startswith("data:image/jpeg;base64,")


def test_openai_flex_is_never_retried_at_the_standard_price() -> None:
    busy = {"error": {"message": "Resource unavailable", "type": "rate_limit", "code": "x"}}
    wire = _Wire({("POST", "/v1/responses"): [(429, busy), (200, _response())]})
    client = _openai(_ctx("openai", "gpt-6.1-sol", flex=True), wire)
    result = client.send(client.build_request(_JPEG, "annotate", batch=False))
    # No Flex capacity: reported as a rate limit for the run to wait out,
    # not quietly bought at full price.
    assert result.error == "rate_limited"
    assert len(wire.requests) == 1 and wire.body(0)["service_tier"] == "flex"


def test_a_request_is_priced_at_the_tier_it_was_served_at() -> None:
    ctx = _ctx("openai", "gpt-6.1-sol", flex=True)
    client = _openai(ctx, _Wire({("POST", "/v1/responses"): (200, _response(service_tier="flex"))}))
    served_flex = client.send(client.build_request(_JPEG, "annotate", batch=False))
    client = _openai(ctx, _Wire({("POST", "/v1/responses"): (200, _response(service_tier="default"))}))
    served_standard = client.send(client.build_request(_JPEG, "annotate", batch=False))
    client = _openai(ctx, _Wire({("POST", "/v1/responses"): (200, _response())}))
    unsaid = client.send(client.build_request(_JPEG, "annotate", batch=False))

    assert (served_flex.discounted, served_standard.discounted, unsaid.discounted) == (True, False, None)
    full = unsaid.usage.cost_usd(ctx.provider, ctx.model, batch=False, discounted=False)
    half = unsaid.usage.cost_usd(ctx.provider, ctx.model, batch=False, discounted=True)
    assert half == pytest.approx(full / 2)
    # Asked for Flex: the discount is only booked when OpenAI says it
    # served the request as Flex; a fallback to standard is billed in full.
    assert served_flex.cost_usd(ctx.provider, ctx.model, batch=False, discounted=True) == pytest.approx(half)
    assert served_standard.cost_usd(ctx.provider, ctx.model, batch=False, discounted=True) == pytest.approx(full)
    assert unsaid.cost_usd(ctx.provider, ctx.model, batch=False, discounted=True) == pytest.approx(half)


def test_openai_luna_can_turn_reasoning_off() -> None:
    client = OpenAIClient(_ctx("openai", "gpt-6-luna", effort="none"), "k")
    assert client.build_request(_JPEG, "x", batch=False)["reasoning"] == {"effort": "none"}
    # Sol does not accept "none": the model's default is sent instead.
    client = OpenAIClient(_ctx("openai", "gpt-6.1-sol", effort="none"), "k")
    assert client.build_request(_JPEG, "x", batch=False)["reasoning"] == {"effort": "low"}


def test_openai_refusal_and_truncation_are_errors() -> None:
    refusal = _response()
    refusal["output"][0]["content"] = [{"type": "refusal", "refusal": "no"}]
    wire = _Wire(
        {
            ("POST", "/v1/responses"): [
                (200, refusal),
                (
                    200,
                    _response(
                        status="incomplete",
                        incomplete_details={"reason": "max_output_tokens"},
                    ),
                ),
            ]
        }
    )
    client = _openai(_ctx("openai", "gpt-6.1-sol"), wire)
    request = client.build_request(_JPEG, "x", batch=False)
    assert client.send(request).error == "refusal"
    assert client.send(request).error == "max_tokens"


def test_openai_batch_roundtrip() -> None:
    def batch(status: str, **extra) -> dict:
        return {
            "id": "batch_1",
            "object": "batch",
            "endpoint": "/v1/responses",
            "input_file_id": "file-in",
            "completion_window": "24h",
            "status": status,
            "created_at": 1790000000,
            "expires_at": 1790086400,
            **extra,
        }

    output = json.dumps(
        {"custom_id": "0_0", "response": {"status_code": 200, "body": _response()}, "error": None}
    )
    errors = json.dumps(
        {"custom_id": "1_0", "response": None, "error": {"code": "batch_expired", "message": "x"}}
    )
    file_obj = {
        "id": "file-in", "object": "file", "bytes": 1, "created_at": 0,
        "filename": "logo-ai-batch.jsonl", "purpose": "batch", "status": "processed",
    }
    wire = _Wire(
        {
            ("POST", "/v1/files"): (200, file_obj),
            ("POST", "/v1/batches"): (200, batch("validating")),
            ("GET", "/v1/batches/batch_1"): [
                (200, batch("in_progress", request_counts={"total": 2, "completed": 1, "failed": 0})),
                (
                    200,
                    batch(
                        "completed",
                        request_counts={"total": 2, "completed": 1, "failed": 1},
                        output_file_id="file-out",
                        error_file_id="file-err",
                    ),
                ),
            ],
            ("GET", "/v1/files/file-out/content"): (200, output),
            ("GET", "/v1/files/file-err/content"): (200, errors),
            ("DELETE", "/v1/files/file-in"): (200, {"id": "file-in", "object": "file", "deleted": True}),
        }
    )
    client = _openai(_ctx("openai", "gpt-6.1-sol", flex=True), wire)
    requests = [
        (f"{i}_0", client.build_request(_JPEG, "x", batch=True)) for i in range(2)
    ]
    assert client.batch_create(requests, tag="part-1") == ("batch_1", "file-in")

    upload = wire.requests[0].content
    line = json.loads(upload[upload.index(b'{"custom_id"') :].split(b"\n")[0])
    assert (line["custom_id"], line["method"], line["url"]) == ("0_0", "POST", "/v1/responses")
    # Flex is a realtime tier; a batch line must not carry it.
    assert "service_tier" not in line["body"]
    create = wire.body(1)
    # The tag travels with the batch, so it can be found again by it.
    assert create == {
        "input_file_id": "file-in", "endpoint": "/v1/responses", "completion_window": "24h",
        "metadata": {"carve_part": "part-1"},
    }
    assert b'filename="logo-ai-part-1.jsonl"' in upload

    # OpenAI reports per-request progress while the batch is running.
    running = client.batch_state("batch_1")
    assert (running.ended, running.total, running.finished) == (False, 2, 1)

    got = dict(client.batch_results("batch_1"))
    assert got["0_0"].text == _ANSWER
    assert got["1_0"].error == "batch_expired" and got["1_0"].retryable
    assert not got["0_0"].retryable

    client.batch_cleanup("batch_1", "file-in")
    assert wire.requests[-1].method == "DELETE"


def test_openai_failed_batch_reports_why() -> None:
    failed = {
        "id": "batch_1", "object": "batch", "endpoint": "/v1/responses",
        "input_file_id": "f", "completion_window": "24h", "status": "failed",
        "created_at": 0,
        "errors": {"object": "list", "data": [{"code": "token_limit_exceeded", "message": "Enqueued token limit reached"}]},
    }
    wire = _Wire({("GET", "/v1/batches/batch_1"): (200, failed)})
    state = _openai(_ctx("openai", "gpt-6.1-sol"), wire).batch_state("batch_1")
    assert state.ended
    # Says what to do about it, and keeps OpenAI's own words.
    assert "batch queue for this model is full" in state.failed_reason
    assert "nothing was charged" in state.failed_reason
    assert state.failed_reason.endswith("(Enqueued token limit reached)")
    # Flagged, so the run offers the part again instead of failing it.
    assert state.queue_full


def _openai_error(message: str, code: str | None = None) -> dict:
    return {"error": {"message": message, "type": "invalid_request_error", "code": code}}


def _openai_batch(status: str, **extra) -> dict:
    return {
        "id": "batch_1", "object": "batch", "endpoint": "/v1/responses",
        "input_file_id": "file-in", "completion_window": "24h", "status": status,
        "created_at": 1790000000, **extra,
    }


_FILE = {
    "id": "file-in", "object": "file", "bytes": 1, "created_at": 0,
    "filename": "logo-ai-batch.jsonl", "purpose": "batch", "status": "processed",
}


def test_openai_batch_create_tells_a_refusal_from_an_outage() -> None:
    def create(files_reply, batches_reply=None):
        batches_reply = batches_reply or (200, _openai_batch("validating"))
        wire = _Wire({("POST", "/v1/files"): files_reply, ("POST", "/v1/batches"): batches_reply})
        client = _openai(_ctx("openai", "gpt-6.1-sol"), wire)
        return client.batch_create(
            [("0_0", client.build_request(_JPEG, "x", batch=True))], tag="part-1"
        )

    # Refused: the same batch would be refused again, so the run stops
    # with OpenAI's own reason.
    with pytest.raises(ProviderFatal) as excinfo:
        create((200, _FILE), (400, _openai_error("Billing hard limit has been reached")))
    assert excinfo.value.message == "OpenAI rejected the batch: Billing hard limit has been reached"
    with pytest.raises(ProviderFatal) as excinfo:
        create((413, _openai_error("File is too large")))
    assert "File is too large" in excinfo.value.message
    with pytest.raises(ProviderFatal) as excinfo:
        create((401, _openai_error("Incorrect API key provided")))
    assert excinfo.value.message.startswith("OpenAI rejected the API key")

    # An outage or a rate limit is not a refusal: the caller tries again.
    with pytest.raises(openai.InternalServerError):
        create((503, _openai_error("overloaded")))
    with pytest.raises(openai.RateLimitError):
        create((200, _FILE), (429, _openai_error("slow down")))


def test_openai_batch_that_no_longer_exists_is_reported_as_gone() -> None:
    wire = _Wire({("GET", "/v1/batches/batch_1"): (404, _openai_error("No batch found"))})
    client = _openai(_ctx("openai", "gpt-6.1-sol"), wire)
    with pytest.raises(BatchGone):
        client.batch_state("batch_1")

    # The batch is still listed but its output file aged out (30 days).
    wire = _Wire(
        {
            ("GET", "/v1/batches/batch_1"): (
                200,
                _openai_batch(
                    "completed",
                    request_counts={"total": 1, "completed": 1, "failed": 0},
                    output_file_id="file-out",
                ),
            ),
            ("GET", "/v1/files/file-out/content"): (404, _openai_error("No such File object")),
        }
    )
    client = _openai(_ctx("openai", "gpt-6.1-sol"), wire)
    with pytest.raises(BatchGone):
        dict(client.batch_results("batch_1"))


def test_openai_batch_results_are_not_read_before_the_output_file_exists() -> None:
    wire = _Wire(
        {
            ("GET", "/v1/batches/batch_1"): (
                200,
                _openai_batch(
                    "completed", request_counts={"total": 2, "completed": 2, "failed": 0}
                ),
            ),
        }
    )
    client = _openai(_ctx("openai", "gpt-6.1-sol"), wire)
    # Reading now would record two paid answers as missing.
    with pytest.raises(RuntimeError, match="not available yet"):
        dict(client.batch_results("batch_1"))


def test_openai_one_unreadable_result_line_does_not_cost_the_others() -> None:
    good = json.dumps(
        {"custom_id": "0_0", "response": {"status_code": 200, "body": _response()}, "error": None}
    )
    odd = json.dumps({"custom_id": "2_0", "response": "???", "error": None})
    output = "\n".join([good, "{not json", json.dumps({"no": "custom id"}), odd, ""])
    wire = _Wire(
        {
            ("GET", "/v1/batches/batch_1"): (
                200,
                _openai_batch(
                    "completed",
                    request_counts={"total": 4, "completed": 4, "failed": 0},
                    output_file_id="file-out",
                ),
            ),
            ("GET", "/v1/files/file-out/content"): (200, output),
        }
    )
    got = dict(_openai(_ctx("openai", "gpt-6.1-sol"), wire).batch_results("batch_1"))
    assert set(got) == {"0_0", "2_0"}
    assert got["0_0"].text == _ANSWER
    assert got["2_0"].error == "unreadable_result"


def test_openai_cancelled_batch_keeps_what_had_finished() -> None:
    output = json.dumps(
        {"custom_id": "0_0", "response": {"status_code": 200, "body": _response()}, "error": None}
    )
    wire = _Wire(
        {
            ("GET", "/v1/batches/batch_1"): (
                200,
                _openai_batch(
                    "cancelled",
                    request_counts={"total": 3, "completed": 1, "failed": 0},
                    output_file_id="file-out",
                ),
            ),
            ("GET", "/v1/files/file-out/content"): (200, output),
        }
    )
    client = _openai(_ctx("openai", "gpt-6.1-sol"), wire)
    assert client.batch_state("batch_1").ended
    # The two that never ran are simply absent; ingestion marks them failed.
    assert set(dict(client.batch_results("batch_1"))) == {"0_0"}


def test_anthropic_batch_errors_are_sorted_the_same_way() -> None:
    def client_for(routes):
        return _anthropic(_ctx("anthropic", "claude-opus-5-5"), _Wire(routes))

    rejected = (400, _api_error("invalid_request_error"))
    client = client_for({("POST", "/v1/messages/batches"): rejected})
    with pytest.raises(ProviderFatal) as excinfo:
        client.batch_create([("0_0", client.build_request(_JPEG, "x", batch=True))], tag="t")
    assert excinfo.value.message == "Anthropic rejected the batch: nope"

    client = client_for({("POST", "/v1/messages/batches"): (529, _api_error("overloaded_error"))})
    with pytest.raises(anthropic.APIStatusError):
        client.batch_create([("0_0", client.build_request(_JPEG, "x", batch=True))], tag="t")

    gone = (404, _api_error("not_found_error"))
    client = client_for(
        {
            ("GET", "/v1/messages/batches/msgbatch_1"): [gone, (200, _batch("ended", succeeded=1))],
            ("GET", "/v1/messages/batches/msgbatch_1/results"): gone,
        }
    )
    with pytest.raises(BatchGone):
        client.batch_state("msgbatch_1")
    with pytest.raises(BatchGone):
        dict(client.batch_results("msgbatch_1"))


# --- cost ------------------------------------------------------------------


def test_cost_counts_each_token_once_at_its_own_rate() -> None:
    provider = catalog.get_provider("anthropic")
    opus = catalog.get_model("anthropic", "claude-opus-5-5")
    usage = Usage(
        input_tokens=1_000_000, cache_read_tokens=1_000_000,
        cache_write_tokens=1_000_000, output_tokens=1_000_000,
    )
    # $4 in + $0.20 read + $4 x 1.25 write + $20 out
    assert usage.cost_usd(provider, opus, batch=False, discounted=False) == pytest.approx(29.2)
    # Batch: 1h cache writes cost 2x, then everything is half price.
    assert usage.cost_usd(provider, opus, batch=True, discounted=True) == pytest.approx(16.1)


# --- finding a batch again, and sending one again ----------------------------


def test_openai_finds_the_batch_an_interrupted_create_left_behind() -> None:
    since = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)
    ts = int(since.timestamp())
    listing = {
        "object": "list",
        "has_more": False,
        "data": [
            _openai_batch("in_progress", id="batch_other", created_at=ts + 50),
            _openai_batch(
                "validating", id="batch_ours", created_at=ts + 2,
                metadata={"carve_part": "abc-1"},
            ),
            _openai_batch(
                "failed", id="batch_old_try", created_at=ts - 10,
                metadata={"carve_part": "abc-0"},
            ),
        ],
    }
    client = _openai(_ctx("openai", "gpt-6.1-sol"), _Wire({("GET", "/v1/batches"): (200, listing)}))
    find = lambda tag: client.batch_find(tag, request_count=3, since=since, known=set())  # noqa: E731

    assert find("abc-1") == ("batch_ours", "file-in")
    # An earlier attempt at the same part has a tag of its own.
    assert find("abc-2") is None


def test_openai_sends_a_part_again_from_the_file_already_uploaded() -> None:
    wire = _Wire({("POST", "/v1/batches"): (200, _openai_batch("validating"))})
    client = _openai(_ctx("openai", "gpt-6.1-sol"), wire)
    assert client.batch_create_from_file("file-in", tag="abc-2") == "batch_1"
    assert wire.body() == {
        "input_file_id": "file-in", "endpoint": "/v1/responses", "completion_window": "24h",
        "metadata": {"carve_part": "abc-2"},
    }
    # Only a batch was created: the images were not uploaded again.
    assert [r.url.path for r in wire.requests] == ["/v1/batches"]

    # The file is gone: say so, and the caller uploads it again.
    gone = _Wire({("POST", "/v1/batches"): (404, _openai_error("No such File object"))})
    assert _openai(_ctx("openai", "gpt-6.1-sol"), gone).batch_create_from_file(
        "file-in", tag="abc-2"
    ) is None
    # The queue or the network is not "gone": that is for later.
    busy = _Wire({("POST", "/v1/batches"): (429, _openai_error("slow down"))})
    with pytest.raises(openai.RateLimitError):
        _openai(_ctx("openai", "gpt-6.1-sol"), busy).batch_create_from_file("file-in", tag="t")


def test_openai_results_survive_being_stored_and_read_back() -> None:
    output = json.dumps(
        {"custom_id": "0_0", "response": {"status_code": 200, "body": _response()}, "error": None}
    )
    errors = "\n".join(
        json.dumps(line)
        for line in [
            {"custom_id": "1_0", "response": None, "error": {"code": "batch_expired"}},
            {
                "custom_id": "2_0",
                "response": {"status_code": 500, "body": {"error": {"code": "server_error", "message": "x"}}},
                "error": None,
            },
            {
                "custom_id": "3_0",
                "response": {"status_code": 400, "body": {"error": {"code": "invalid_image", "message": "x"}}},
                "error": None,
            },
        ]
    )
    wire = _Wire(
        {
            ("GET", "/v1/batches/batch_1"): (
                200,
                _openai_batch(
                    "expired",
                    request_counts={"total": 4, "completed": 1, "failed": 3},
                    output_file_id="file-out",
                    error_file_id="file-err",
                ),
            ),
            ("GET", "/v1/files/file-out/content"): (200, output + "\n"),
            ("GET", "/v1/files/file-err/content"): (200, errors),
        }
    )
    client = _openai(_ctx("openai", "gpt-6.1-sol"), wire)
    raw = client.batch_download("batch_1")
    requests_made = len(wire.requests)

    # Parsing needs nothing but the bytes: no provider, any time later.
    got = dict(client.batch_parse(raw))
    assert len(wire.requests) == requests_made
    assert got["0_0"].text == _ANSWER and got["0_0"].usage.requests == 1
    assert (got["1_0"].error, got["1_0"].retryable) == ("batch_expired", True)
    assert got["2_0"].retryable and got["2_0"].error.startswith("server_error")
    assert not got["3_0"].retryable and got["3_0"].error.startswith("invalid_image")


def test_anthropic_results_survive_being_stored_and_read_back() -> None:
    results = "\n".join(
        json.dumps(line)
        for line in [
            {"custom_id": "0_0", "result": {"type": "succeeded", "message": _message()}},
            {"custom_id": "1_0", "result": {"type": "errored", "error": _api_error("overloaded_error")}},
            {"custom_id": "2_0", "result": {"type": "canceled"}},
        ]
    )
    wire = _Wire(
        {
            ("GET", "/v1/messages/batches/msgbatch_1"): (200, _batch("ended", succeeded=1, errored=1, canceled=1)),
            ("GET", "/v1/messages/batches/msgbatch_1/results"): (200, results),
        }
    )
    client = _anthropic(_ctx("anthropic", "claude-opus-5-5"), wire)
    raw = client.batch_download("msgbatch_1")
    requests_made = len(wire.requests)

    got = dict(client.batch_parse(raw + b"\n{broken line"))
    assert len(wire.requests) == requests_made
    assert got["0_0"].text == _ANSWER and got["0_0"].usage.requests == 1
    assert got["1_0"].retryable and got["1_0"].error.startswith("overloaded_error")
    assert (got["2_0"].error, got["2_0"].retryable) == ("canceled", False)


def test_anthropic_finds_an_unrecorded_batch_by_elimination() -> None:
    since = datetime(2026, 9, 30, 10, 0, tzinfo=UTC)

    def batch(batch_id: str, created: str, n: int) -> dict:
        return {**_batch("in_progress", processing=n), "id": batch_id, "created_at": created}

    listing = {
        "data": [
            batch("msgbatch_known", "2026-09-30T10:00:03Z", 3),
            batch("msgbatch_other_size", "2026-09-30T10:00:02Z", 7),
            batch("msgbatch_ours", "2026-09-30T10:00:01Z", 3),
            batch("msgbatch_yesterday", "2026-09-29T10:00:00Z", 3),
        ],
        "has_more": False,
        "first_id": "msgbatch_known",
        "last_id": "msgbatch_yesterday",
    }
    client = _anthropic(
        _ctx("anthropic", "claude-opus-5-5"),
        _Wire({("GET", "/v1/messages/batches"): (200, listing)}),
    )
    found = client.batch_find("t", request_count=3, since=since, known={"msgbatch_known"})
    assert found == ("msgbatch_ours", None)
    assert client.batch_find(
        "t", request_count=3, since=since, known={"msgbatch_known", "msgbatch_ours"}
    ) is None


def test_creating_a_batch_is_never_retried_by_the_sdk() -> None:
    # The provider took the batch and its answer was lost. An SDK retry
    # would make a second batch, and both would be billed: the call must
    # fail once, so the run can look the first one up by its tag.
    lost = (500, _openai_error("upstream timeout"))
    wire = _Wire({("POST", "/v1/files"): (200, _FILE), ("POST", "/v1/batches"): [lost, lost, lost]})
    client = OpenAIClient(_ctx("openai", "gpt-6.1-sol"), "sk-test")
    client._client = openai.OpenAI(
        api_key="sk-test",
        max_retries=4,
        http_client=openai.DefaultHttpx2Client(transport=httpx2.MockTransport(wire)),
    )
    with pytest.raises(openai.InternalServerError) as excinfo:
        client.batch_create([("0_0", client.build_request(_JPEG, "x", batch=True))], tag="t")
    assert [r.url.path for r in wire.requests].count("/v1/batches") == 1
    # The upload did get through: the error says which file, so the next
    # attempt starts from it rather than uploading the images again.
    assert excinfo.value.uploaded_file_id == "file-in"

    lost = (500, _api_error("api_error"))
    wire = _Wire({("POST", "/v1/messages/batches"): [lost, lost, lost]})
    client = AnthropicClient(_ctx("anthropic", "claude-opus-5-5"), "sk-ant-test")
    client._client = anthropic.Anthropic(
        api_key="sk-ant-test",
        max_retries=4,
        http_client=anthropic.DefaultHttpxClient(transport=httpx2.MockTransport(wire)),
    )
    with pytest.raises(anthropic.APIStatusError):
        client.batch_create([("0_0", client.build_request(_JPEG, "x", batch=True))], tag="t")
    assert len(wire.requests) == 1


def test_clients_notice_a_dead_link_without_waiting_out_the_read_timeout() -> None:
    import socket

    for client in (
        OpenAIClient(_ctx("openai", "gpt-6.1-sol"), "sk-test")._client,
        AnthropicClient(_ctx("anthropic", "claude-opus-5-5"), "sk-ant-test")._client,
    ):
        # Long enough for a slow answer, short for a connection attempt.
        assert client.timeout.read >= 600 and client.timeout.connect <= 15
        pool = client._client._transport._pool
        options = {(level, name): value for level, name, value in pool._socket_options}
        assert options[(socket.SOL_SOCKET, socket.SO_KEEPALIVE)] == 1
        assert options[(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE)] == 30
        assert options[(socket.IPPROTO_TCP, socket.TCP_USER_TIMEOUT)] == 60_000


def test_a_model_can_ask_for_its_own_coordinate_system() -> None:
    from carve_api.logo_ai.service import RunOptions, build_context

    # GPT-6 Sol answers in pixels of the sent image, not on OpenAI's
    # usual 0..999 grid; the prompt, the schema and the read-back agree.
    sol6 = catalog.get_model("openai", "gpt-6-sol")
    assert sol6.coords == catalog.COORDS_PIXEL
    assert catalog.get_model("openai", "gpt-6.1-sol").coords is None


def test_check_requests_carry_the_sheet_and_a_strict_schema() -> None:
    from carve_api.logo_ai.prompt import build_check_schema, build_check_text

    text = build_check_text(_CLASSES)
    scores = '{"scores":[[1,95],[2,10]]}'

    wire = _Wire({("POST", "/v1/responses"): (200, _response(text=scores, service_tier="flex"))})
    client = _openai(_ctx("openai", "gpt-6.1-sol", effort="low", flex=True), wire)
    request = client.build_check_request(
        _JPEG, "The sheet has 2 tiles, numbered 1 to 2.",
        system_text=text, schema=build_check_schema(numeric_bounds=True),
    )
    result = client.send(request)
    assert result.text == scores and result.discounted is True
    body = wire.body()
    assert body["service_tier"] == "flex" and body["store"] is False
    assert body["prompt_cache_options"] == {"mode": "explicit"}
    assert body["text"]["format"]["strict"] is True
    assert body["text"]["format"]["schema"]["properties"]["scores"]["items"]["maxItems"] == 2
    assert body["input"][0]["content"][0]["text"] == text
    assert body["input"][1]["content"][0]["type"] == "input_image"

    wire = _Wire({("POST", "/v1/messages"): (200, _message(text=scores))})
    client = _anthropic(_ctx("anthropic", "claude-opus-5-5"), wire)
    request = client.build_check_request(
        _JPEG, "The sheet has 2 tiles, numbered 1 to 2.",
        system_text=text, schema=build_check_schema(numeric_bounds=False),
    )
    assert client.send(request).text == scores
    body = wire.body()
    assert body["system"][0]["text"] == text
    assert "minItems" not in json.dumps(body["output_config"]["format"]["schema"])


def test_the_check_goes_to_the_check_model_with_its_own_effort() -> None:
    import dataclasses

    ctx = _ctx("openai", "gpt-6.1-sol", effort="high", flex=True)
    same = OpenAIClient(ctx, "sk-test")
    assert same.checker() is same  # no check model: the run's own client

    ctx = dataclasses.replace(
        ctx, check_model=catalog.get_model("openai", "gpt-6-sol"), check_effort="low"
    )
    client = OpenAIClient(ctx, "sk-test")
    checker = client.checker()
    assert checker is not client and client.checker() is checker  # made once
    body = checker.build_check_request(_JPEG, "x", system_text="s", schema={})
    assert body["model"] == "gpt-6-sol" and body["reasoning"] == {"effort": "low"}
    assert body["service_tier"] == "flex"
    # Detection is untouched.
    assert client.build_request(_JPEG, "x", batch=False)["model"] == "gpt-6.1-sol"


def test_the_check_prompt_is_long_enough_to_be_cached() -> None:
    from carve_api.logo_ai.prompt import build_check_text

    # OpenAI caches a prefix of 1,024 tokens or more. Measured: this text
    # with a one-word class is about 1,170 tokens (3.96 characters per
    # token). Under the minimum, every check request of a run pays for
    # the whole prompt at the full input price.
    shortest = build_check_text([TargetClass("c1", "Logo", "")])
    assert len(shortest) / 3.96 > 1024 * 1.1
