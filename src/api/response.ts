import { ApiError } from "./errors.js";

export type ApiMeta = {
  requestId: string;
  traceId?: string;
  mode: "postgres" | "in_memory";
  warnings?: string[];
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
  if (error instanceof ApiError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
      },
      meta,
    };
  }
  if (error instanceof Error) {
    return {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error.",
      },
      meta,
    };
  }
  return {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error.",
    },
    meta,
  };
}
