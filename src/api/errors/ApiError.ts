import type { ErrorCode } from "./ErrorCode.js";

export type ApiErrorOptions = {
  details?: unknown;
  retryable?: boolean;
  cause?: unknown;
};

export class ApiError extends Error {
  public readonly details?: unknown;
  public readonly retryable?: boolean;

  public constructor(
    public readonly code: ErrorCode | string,
    message: string,
    public readonly statusCode = 400,
    options: ApiErrorOptions = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.details = options.details;
    this.retryable = options.retryable;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
