"""Explicit, observable retry policy for provider transport calls."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

_RETRYABLE_STATUS_CODES = {408, 409, 429}


@dataclass(slots=True)
class RetryStats:
    attempts: int = 0
    retries: int = 0


def status_code_from_exception(exc: BaseException) -> int | None:
    direct = getattr(exc, "status_code", None)
    if isinstance(direct, int):
        return direct
    response = getattr(exc, "response", None)
    response_status = getattr(response, "status_code", None)
    if isinstance(response_status, int):
        return response_status
    cause = exc.__cause__ or exc.__context__
    return status_code_from_exception(cause) if cause is not None and cause is not exc else None


def is_retryable_transport_error(exc: BaseException) -> bool:
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError, ConnectionError)):
        return True
    status_code = status_code_from_exception(exc)
    if status_code is not None:
        return status_code in _RETRYABLE_STATUS_CODES or status_code >= 500
    name = exc.__class__.__name__.lower()
    return any(marker in name for marker in ("timeout", "connection", "ratelimit"))


async def run_with_transport_retries[T](
    call: Callable[[], Awaitable[T]],
    *,
    max_retries: int,
    stats: RetryStats | None = None,
    on_attempt: Callable[[int, str, str | None], None] | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> T:
    """Run ``call`` with bounded retries, never swallowing cancellation."""
    observed = stats or RetryStats()
    for attempt in range(1, max_retries + 2):
        observed.attempts += 1
        try:
            result = await call()
        except asyncio.CancelledError:
            if on_attempt:
                on_attempt(attempt, "cancelled", "CancelledError")
            raise
        except Exception as exc:
            if on_attempt:
                on_attempt(attempt, "failed", exc.__class__.__name__)
            if attempt > max_retries or not is_retryable_transport_error(exc):
                raise
            observed.retries += 1
            await sleep(min(0.25 * (2 ** (attempt - 1)), 2.0))
        else:
            if on_attempt:
                on_attempt(attempt, "completed", None)
            return result
    raise RuntimeError("unreachable retry state")
