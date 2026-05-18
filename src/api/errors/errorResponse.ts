import type { ApiFailure, ApiMeta } from "../response.js";
import { mapError } from "./errorMapper.js";

export function errorResponse(error: unknown, meta: ApiMeta): { statusCode: number; body: ApiFailure } {
  const mapped = mapError(error);
  return {
    statusCode: mapped.statusCode,
    body: {
      ok: false,
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details !== undefined ? { details: mapped.details } : {}),
        ...(mapped.retryable !== undefined ? { retryable: mapped.retryable } : {}),
      },
      meta,
    },
  };
}
