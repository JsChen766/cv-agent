export type AgentRuntimeErrorOptions = {
  code?: string;
  statusCode?: number;
  retryable?: boolean;
  cause?: unknown;
};

export class AgentRuntimeError extends Error {
  public readonly code?: string;
  public readonly statusCode?: number;
  public readonly retryable: boolean;
  public readonly cause?: unknown;

  public constructor(message: string, options: AgentRuntimeErrorOptions = {}) {
    super(message);
    this.name = "AgentRuntimeError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }
}
