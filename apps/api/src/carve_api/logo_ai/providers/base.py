# Armin Mehri — mehri.armin@gmail.com
"""Provider-neutral types shared by the vendor adapters."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass, field, replace
from datetime import datetime

from carve_api.errors import AppError
from carve_api.logo_ai.catalog import ModelSpec, ProviderSpec
from carve_api.logo_ai.prompt import TargetClass


class LogoAiNotConfigured(AppError):
    """The chosen provider has no API key on this deployment."""

    http_status = 400
    code = "logo_ai_not_configured"


class ProviderFatal(AppError):
    """A failure that will repeat for every request of the run — bad
    key, unknown model, rejected parameters. Stops the run instead of
    failing each asset in turn."""

    http_status = 502
    code = "logo_ai_provider_error"


def live_connection_transport():  # noqa: ANN201 — httpx2.HTTPTransport
    """An HTTP transport that notices a dead link within about a minute.

    A request to a vision model may rightly take many minutes, so the
    read timeout has to be long. Without this, a network that goes away
    mid-request leaves the call hanging for that whole timeout (and the
    worker with it), times the SDK's retries. TCP keepalive tells a slow
    answer from a peer that is no longer there, and the user timeout
    does the same for an upload whose data is no longer being taken.
    """
    import socket

    import httpx2

    options = [(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)]
    for name, value in (
        ("TCP_KEEPIDLE", 30),    # seconds of silence before probing
        ("TCP_KEEPINTVL", 10),   # seconds between probes
        ("TCP_KEEPCNT", 3),      # unanswered probes before giving up
        ("TCP_USER_TIMEOUT", 60_000),  # ms sent data may stay unacknowledged
    ):
        if hasattr(socket, name):
            options.append((socket.IPPROTO_TCP, getattr(socket, name), value))
    return httpx2.HTTPTransport(
        socket_options=options,
        limits=httpx2.Limits(max_connections=100, max_keepalive_connections=20),
    )


class BatchGone(Exception):
    """The provider no longer has this batch, or its result files: it
    was deleted or aged out of the provider's retention. Asking again
    cannot bring it back, unlike every other failure to read a batch."""


def api_error_message(exc: Exception) -> str:
    """The provider's own words for an SDK error, without the status
    line and body dump the SDKs wrap around it.

    Both SDKs expose the decoded error body: Anthropic as
    ``{"error": {"message": ...}}``, OpenAI as ``{"message": ...}``.
    """
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        inner = body.get("error") if isinstance(body.get("error"), dict) else body
        message = inner.get("message")
        if message:
            return str(message)
    return str(getattr(exc, "message", "") or exc)


@dataclass
class Usage:
    """Billed tokens, normalised across providers.

    ``input_tokens`` is input billed at the full rate only — cache reads
    and writes are counted in their own fields, never twice.
    """

    input_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    output_tokens: int = 0
    # The part of ``output_tokens`` spent reasoning before the answer.
    # Already counted (and billed) in ``output_tokens``; kept apart only
    # to show where a run's cost went. 0 where the provider does not
    # report it.
    reasoning_tokens: int = 0
    # Requests the provider answered (and billed). Lets a later estimate
    # work from what a request really cost in this task.
    requests: int = 0

    def add(self, other: Usage) -> None:
        self.input_tokens += other.input_tokens
        self.cache_read_tokens += other.cache_read_tokens
        self.cache_write_tokens += other.cache_write_tokens
        self.output_tokens += other.output_tokens
        self.reasoning_tokens += other.reasoning_tokens
        self.requests += other.requests

    def to_dict(self) -> dict[str, int]:
        return {
            "input_tokens": self.input_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "output_tokens": self.output_tokens,
            "reasoning_tokens": self.reasoning_tokens,
            "requests": self.requests,
        }

    @classmethod
    def from_dict(cls, raw: dict | None) -> Usage:
        raw = raw or {}
        return cls(
            input_tokens=int(raw.get("input_tokens", 0) or 0),
            cache_read_tokens=int(raw.get("cache_read_tokens", 0) or 0),
            cache_write_tokens=int(raw.get("cache_write_tokens", 0) or 0),
            output_tokens=int(raw.get("output_tokens", 0) or 0),
            reasoning_tokens=int(raw.get("reasoning_tokens", 0) or 0),
            requests=int(raw.get("requests", 0) or 0),
        )

    def cost_usd(
        self, provider: ProviderSpec, model: ModelSpec, *, batch: bool, discounted: bool
    ) -> float:
        """``batch`` picks the cache-write surcharge (it follows the TTL
        the request used); ``discounted`` applies the batch/flex rate."""
        write_mult = (
            provider.cache_write_mult_batch if batch else provider.cache_write_mult
        )
        usd = (
            self.input_tokens * model.input_usd
            + self.cache_read_tokens * model.cache_read_usd
            + self.cache_write_tokens * model.input_usd * write_mult
            + self.output_tokens * model.output_usd
        ) / 1_000_000
        return usd * (provider.batch_discount if discounted else 1.0)


@dataclass
class ProviderResult:
    """One request's outcome. ``text`` is the JSON answer on success;
    on failure ``error`` is a short code safe to show next to a filename."""

    text: str | None = None
    usage: Usage = field(default_factory=Usage)
    error: str | None = None
    # A batch request the provider never got to (its window ran out) or
    # dropped for a reason of its own (overloaded, rate limited). It was
    # not charged and sending it again can succeed.
    retryable: bool = False
    # Whether the provider says it served the request at its discounted
    # rate (OpenAI's response carries the tier it actually used; a Flex
    # request can come back served as standard). ``None`` when the
    # provider does not say, and the request's own setting decides.
    discounted: bool | None = None

    def cost_usd(
        self, provider: ProviderSpec, model: ModelSpec, *, batch: bool, discounted: bool
    ) -> float:
        """What this request cost, by what the provider said it did
        where it said; ``discounted`` is the fallback."""
        served_discounted = self.discounted if self.discounted is not None else discounted
        return self.usage.cost_usd(provider, model, batch=batch, discounted=served_discounted)


@dataclass
class BatchState:
    ended: bool
    total: int
    finished: int  # requests that already have a final result
    # Set when the provider rejected the batch as a whole.
    failed_reason: str | None = None
    expires_at: datetime | None = None
    # The batch was turned away because the provider's queue for the
    # model was full. Nothing ran; it can be sent again once there is room.
    queue_full: bool = False


@dataclass(frozen=True)
class Reference:
    """An exemplar crop of a target logo, shown in the cached prefix."""

    class_index: int  # 0-based into RunContext.classes
    jpeg: bytes


@dataclass(frozen=True)
class RunContext:
    """Everything that is constant across the requests of one run."""

    provider: ProviderSpec
    model: ModelSpec
    effort: str | None
    classes: list[TargetClass]
    references: list[Reference]
    system_text: str
    schema: dict
    flex: bool = False
    # The coordinate system the model is asked for and answers in: the
    # provider's usual one unless the model needs another.
    coords: str = ""
    # The model and effort of the second pass, when the run has one.
    check_model: ModelSpec | None = None
    check_effort: str | None = None


class ProviderClient(ABC):
    """One vendor SDK behind a common request/batch surface."""

    _checker: ProviderClient | None = None

    def __init__(self, ctx: RunContext) -> None:
        self.ctx = ctx

    def checker(self) -> ProviderClient:
        """The client the second pass is sent with: this one, or one of
        the same provider set to the run's check model and effort."""
        ctx = self.ctx
        if ctx.check_model is None or (
            ctx.check_model.id == ctx.model.id and ctx.check_effort == ctx.effort
        ):
            return self
        if self._checker is None:
            self._checker = self._with_context(
                replace(ctx, model=ctx.check_model, effort=ctx.check_effort)
            )
        return self._checker

    def _with_context(self, ctx: RunContext) -> ProviderClient:
        """A client like this one for another context. Adapters that
        hold credentials override it."""
        return self

    @abstractmethod
    def build_request(self, image_jpeg: bytes, request_text: str, *, batch: bool) -> dict:
        """Request params for one view. JSON-serialisable."""

    @abstractmethod
    def build_check_request(
        self, sheet_jpeg: bytes, request_text: str, *, system_text: str, schema: dict
    ) -> dict:
        """Request params for the second pass over one check sheet (see
        ``imaging.render_check_sheet``). Sent with :meth:`send`."""

    @abstractmethod
    def send(self, request: dict) -> ProviderResult:
        """Run one request now. Raises :class:`ProviderFatal` for
        failures that would repeat on every request."""

    @abstractmethod
    def batch_create(
        self, requests: list[tuple[str, dict]], *, tag: str
    ) -> tuple[str, str | None]:
        """Submit ``(custom_id, request)`` pairs. Returns the provider's
        batch id and, where one exists, the uploaded input file's id.

        ``tag`` names this attempt at sending the part. Where the
        provider can store it, :meth:`batch_find` looks a batch up by it.

        Raises :class:`ProviderFatal` when the provider refuses the
        batch; anything else it raises is taken to be temporary.
        """

    def batch_create_from_file(self, file_id: str, *, tag: str) -> str | None:
        """Start a batch from an input file uploaded earlier, sparing a
        second upload. ``None`` if the provider has no such thing or no
        longer has the file."""
        return None

    def batch_find(
        self, tag: str, *, request_count: int, since: datetime, known: set[str]
    ) -> tuple[str, str | None] | None:
        """The batch an earlier, interrupted ``batch_create`` with this
        ``tag`` left at the provider, as ``(batch_id, file_id)``.

        Asked before a part is sent a second time: sending it twice
        would pay for it twice. ``known`` holds the batch ids already on
        record, ``since`` the time the part was written down.
        """
        return None

    @abstractmethod
    def batch_state(self, batch_id: str) -> BatchState: ...

    @abstractmethod
    def batch_download(self, batch_id: str) -> bytes:
        """Everything the provider has for a finished batch, as it came.
        Kept on our side before it is parsed, so answers that were paid
        for do not depend on the provider keeping them."""

    @abstractmethod
    def batch_parse(self, raw: bytes) -> Iterator[tuple[str, ProviderResult]]:
        """``(custom_id, result)`` from :meth:`batch_download`'s bytes,
        in no particular order."""

    def batch_results(self, batch_id: str) -> Iterator[tuple[str, ProviderResult]]:
        return self.batch_parse(self.batch_download(batch_id))

    @abstractmethod
    def batch_cancel(self, batch_id: str) -> None: ...

    def batch_cleanup(self, batch_id: str, file_id: str | None) -> None:  # noqa: B027
        """Delete what the provider stored for an ingested batch.

        Optional hook, best-effort; the default keeps nothing to delete.
        """
