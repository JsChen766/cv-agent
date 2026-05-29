/**
 * Controls whether deterministic (non-LLM) fallbacks are allowed to run.
 * These fallbacks (rule-based extraction, template generation, regex claim check)
 * MUST only be used in test environments.
 *
 * In development or production, the absence of a working LLM client should
 * result in a clear error (needs_input / LLM_PROVIDER_NOT_CONFIGURED), not
 * silently degraded output.
 */
export function isDeterministicFallbackAllowed(): boolean {
  return process.env.NODE_ENV === "test";
}

/** Standard error codes for LLM-not-available scenarios. */
export const LLM_NOT_AVAILABLE_REASON = "llm_not_available" as const;
export const LLM_PROVIDER_NOT_CONFIGURED_REASON = "model_not_available" as const;

export function llmNotAvailableResult(
  actionType: string,
  detail?: string,
): { status: "needs_input"; message: string; visibility: "error_user_visible"; actionResult: { status: "needs_input"; actionType: string; reason: string; message: string } } {
  const message = detail ?? "当前 AI 模型服务未配置，无法完成智能处理。请检查 API Key 配置。";
  return {
    status: "needs_input",
    message,
    visibility: "error_user_visible",
    actionResult: {
      status: "needs_input",
      actionType,
      reason: LLM_PROVIDER_NOT_CONFIGURED_REASON,
      message,
    },
  };
}
