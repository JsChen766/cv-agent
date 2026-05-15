export type JSONSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

export type ToolExecutionContext = {
  sessionId?: string;
  metadata?: Record<string, unknown>;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JSONSchema;
  strict?: boolean;
  validate?: (args: unknown) => unknown;
  execute: (args: unknown, context?: ToolExecutionContext) => Promise<unknown>;
};

export type ToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
    strict?: boolean;
  };
};

export type ToolCall = {
  id?: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  raw?: unknown;
};

export type ToolExecutionResult = {
  ok: boolean;
  toolName: string;
  result?: unknown;
  error?: string;
};
