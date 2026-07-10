from __future__ import annotations

"""
Application-level error hierarchy.

All errors carry an HTTP status code so the global error handler
can convert them to consistent JSON responses without extra logic.
"""


class AppError(Exception):
    """Base class for all application errors."""

    code: str = "internal_error"
    message: str = "An unexpected error occurred"
    http_status: int = 500
    retryable: bool = False

    def __init__(
        self,
        message: str | None = None,
        *,
        code: str | None = None,
        retryable: bool | None = None,
    ) -> None:
        self.message = message or self.__class__.message
        if code is not None:
            self.code = code
        if retryable is not None:
            self.retryable = retryable
        super().__init__(self.message)

    def to_dict(self) -> dict[str, str | bool]:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }


class NotFoundError(AppError):
    code = "not_found"
    message = "Resource not found"
    http_status = 404


class ForbiddenError(AppError):
    code = "forbidden"
    message = "You do not have permission to access this resource"
    http_status = 403


class UnauthorizedError(AppError):
    code = "unauthorized"
    message = "Authentication required"
    http_status = 401


class ValidationError(AppError):
    code = "validation_error"
    message = "Invalid input"
    http_status = 422


class FileParseTimeoutError(AppError):
    code = "file_parse_timeout"
    message = "File parsing timed out"
    http_status = 408
    retryable = True


class ConflictError(AppError):
    code = "conflict"
    message = "Resource already exists"
    http_status = 409


class ScopeViolationError(AppError):
    """Raised when an action is not allowed in the current workspace scope."""

    code = "scope_violation"
    message = "Action not allowed in this context"
    http_status = 422


class RateLimitError(AppError):
    code = "rate_limited"
    message = "Too many requests"
    http_status = 429
    retryable = True


class ExternalServiceError(AppError):
    """Raised when an upstream LLM or external service fails."""

    code = "external_service_error"
    message = "External service error"
    http_status = 502
    retryable = True


class IdempotencyConflictError(AppError):
    """Raised when an idempotency key is reused with different parameters."""

    code = "idempotency_conflict"
    message = "Idempotency key already used with different parameters"
    http_status = 422


class GraphInterruptError(AppError):
    """Raised to signal that the graph has paused and awaits user confirmation."""

    code = "graph_interrupt"
    message = "Graph interrupted, awaiting user input"
    http_status = 200  # Not actually an HTTP error; handled specially
