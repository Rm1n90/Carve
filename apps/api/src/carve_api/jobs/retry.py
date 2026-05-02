# Armin Mehri — mehri.armin@gmail.com
"""Retry helper for transient model-service failures (plan-09 task-09).

Wrap a single model-service call (e.g. ``yolo_load``, ``yolo_predict``,
``yolo_train``) with :func:`run_with_retry` to absorb transient
``model_service_unreachable`` (HTTP 503) blips — typically a model
service that is still warming up.

Backoff is intentionally **linear** (``backoff_s * attempt``). Model
warmup lives on the order of seconds, so an exponential schedule would
oversleep without buying anything; linear keeps the worst-case wait
bounded and predictable.

The ``time`` module is imported lazily inside :func:`run_with_retry` so
tests can patch ``time.sleep`` (or supply ``backoff_s=0``) without
monkey-patching the module on import.
"""

from __future__ import annotations

import logging
from typing import Callable, TypeVar

from carve_api.inference.model_client import ModelServiceError


T = TypeVar("T")

log = logging.getLogger(__name__)


def _default_is_transient(exc: BaseException) -> bool:
    """503 from the model service (model_service_unreachable) is transient."""
    return (
        isinstance(exc, ModelServiceError)
        and getattr(exc, "status_code", None) == 503
    )


def _make_predicate(
    transient: (
        tuple[type[BaseException], ...]
        | Callable[[BaseException], bool]
        | None
    ),
) -> Callable[[BaseException], bool]:
    if transient is None:
        return _default_is_transient
    if isinstance(transient, tuple):
        types = transient
        return lambda exc: isinstance(exc, types)
    if callable(transient):
        return transient
    raise TypeError(
        "transient must be a tuple of exception types, a predicate, or None"
    )


def run_with_retry(
    fn: Callable[..., T],
    *args,
    attempts: int = 3,
    backoff_s: float = 10.0,
    transient: (
        tuple[type[BaseException], ...]
        | Callable[[BaseException], bool]
        | None
    ) = None,
    **kwargs,
) -> T:
    """Call ``fn(*args, **kwargs)`` retrying transient failures.

    :param attempts: Total attempts (default 3). After ``attempts``
        transient failures, the last exception is re-raised.
    :param backoff_s: Linear sleep base in seconds. Sleep before the
        next attempt (1-indexed) is ``backoff_s * attempt``.
    :param transient: Either a tuple of exception types or a
        ``Callable[[BaseException], bool]`` predicate. Default predicate
        matches ``ModelServiceError`` with ``status_code == 503``
        (i.e. ``model_service_unreachable``).

    Non-transient exceptions are re-raised immediately on the first
    attempt — they will not benefit from retry (e.g. 4xx, ValueError).
    """
    import time  # lazy so tests can patch easily

    is_transient = _make_predicate(transient)
    last_exc: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fn(*args, **kwargs)
        except BaseException as exc:  # noqa: BLE001
            if not is_transient(exc):
                raise
            last_exc = exc
            log.warning(
                "run_with_retry: transient failure on attempt %d/%d: %r",
                attempt,
                attempts,
                exc,
            )
            if attempt >= attempts:
                break
            time.sleep(backoff_s * attempt)
    assert last_exc is not None  # for type-checkers
    raise last_exc
