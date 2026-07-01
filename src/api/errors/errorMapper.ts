import { UserApiKeyStorageConfigurationError } from "../../auth/ApiKeyEncryptor.js";
import { AgentError } from "../../agent-core/runtime/AgentError.js";
import { ApiError } from "./ApiError.js";
import { ErrorCodes, normalizeErrorCode } from "./ErrorCode.js";

export type MappedApiError = {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
};

export function mapError(error: unknown): MappedApiError {
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      code: normalizeErrorCode(error.code),
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
      ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
    };
  }
  if (error instanceof AgentError) {
    const statusCode = error.statusCode ?? 500;
    return {
      statusCode,
      code: normalizeErrorCode(error.code),
      message: error.message,
      retryable: statusCode >= 500,
    };
  }
  if (error instanceof UserApiKeyStorageConfigurationError) {
    return {
      statusCode: 503,
      code: ErrorCodes.CONFIGURATION_REQUIRED,
      message: error.message,
      retryable: false,
    };
  }
  if (isProviderTimeout(error)) {
    return {
      statusCode: 504,
      code: ErrorCodes.PROVIDER_TIMEOUT,
      message: "The model provider timed out. Please retry shortly.",
      retryable: true,
    };
  }
  if (error instanceof Error && /provider|model|llm/i.test(error.message)) {
    return {
      statusCode: 502,
      code: ErrorCodes.PROVIDER_ERROR,
      message: "The model provider failed. Please retry shortly.",
      retryable: true,
    };
  }
  return {
    statusCode: 500,
    code: ErrorCodes.INTERNAL_ERROR,
    message: "Internal server error.",
  };
}

function isProviderTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const anyError = error as Error & { code?: string; name?: string };
  return anyError.code === "ETIMEDOUT" ||
    anyError.name === "TimeoutError" ||
    /timeout|timed out/i.test(error.message);
}
