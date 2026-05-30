import { mapError } from "./errors.js";

export type ApiMeta = {
  requestId: string;
  traceId?: string;
  mode: "postgres" | "in_memory";
  warnings?: string[];
  /** Set on /copilot/pending-actions/:id/confirm to signal completed confirmation. */
  confirmStatus?: "completed";
  /** The confirmed pending action ID. */
  pendingActionId?: string;
};

export type ApiSuccess<T> = {
  ok: true;
  data: T;
  meta: ApiMeta;
};

export type ApiFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
  };
  meta: ApiMeta;
};

export function success<T>(data: T, meta: ApiMeta): ApiSuccess<T> {
  return {
    ok: true,
    data,
    meta,
  };
}

export function failure(error: unknown, meta: ApiMeta): ApiFailure {
  const mapped = mapError(error);
  return {
    ok: false,
    error: {
      code: mapped.code,
      message: mapped.message,
      ...(mapped.details !== undefined ? { details: mapped.details } : {}),
      ...(mapped.retryable !== undefined ? { retryable: mapped.retryable } : {}),
    },
    meta,
  };
}
