export type AgentErrorCode =
  | "MODEL_FAILED"
  | "INVALID_AGENT_OUTPUT"
  | "TOOL_NOT_FOUND"
  | "TOOL_VALIDATION_FAILED"
  | "TOOL_EXECUTION_FAILED"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_EXPIRED"
  | "PERMISSION_DENIED"
  | "PRODUCT_STATE_NOT_FOUND";

export class AgentError extends Error {
  public readonly code: AgentErrorCode;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  public constructor(code: AgentErrorCode, message: string, options: {
    statusCode?: number;
    details?: Record<string, unknown>;
    cause?: unknown;
  } = {}) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.statusCode = options.statusCode ?? 500;
    this.details = options.details;
    this.cause = options.cause;
  }

  public toUserMessage(): string {
    switch (this.code) {
      case "TOOL_VALIDATION_FAILED":
        return "I need a bit more information before I can safely do that.";
      case "TOOL_NOT_FOUND":
        return "That operation is not available yet.";
      case "CONFIRMATION_REQUIRED":
        return "Please confirm before I make that change.";
      case "CONFIRMATION_EXPIRED":
        return "This confirmation request has expired. Please ask me to prepare it again.";
      case "PERMISSION_DENIED":
        return "You do not have permission to perform that action.";
      case "PRODUCT_STATE_NOT_FOUND":
        return "I could not find the product item needed for that action.";
      default:
        return "I could not complete that request safely.";
    }
  }
}
