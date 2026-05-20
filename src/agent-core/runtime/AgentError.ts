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
      case "MODEL_FAILED":
        return "Agent 模型暂时不可用，我已切换到基础规则模式。请再试一次或补充更具体的信息。";
      case "INVALID_AGENT_OUTPUT":
        return "我理解了你的请求，但刚才没有生成可执行计划。请稍微换种说法，或者告诉我是要查看、保存、修改还是生成。";
      case "TOOL_VALIDATION_FAILED":
        return "这个操作还缺少必要信息。";
      case "TOOL_NOT_FOUND":
        return "这个操作目前还没有对应工具。";
      case "TOOL_EXECUTION_FAILED":
        return "工具执行失败，请稍后重试。";
      case "CONFIRMATION_REQUIRED":
        return "请在确认后我再执行这个操作。";
      case "CONFIRMATION_EXPIRED":
        return "这个确认请求已经过期，请重新操作。";
      case "PERMISSION_DENIED":
        return "你没有执行这个操作的权限。";
      case "PRODUCT_STATE_NOT_FOUND":
        return "找不到操作所需的产品数据。";
      default:
        return "处理你的请求时遇到了问题，请换个说法再试一次。";
    }
  }
}
