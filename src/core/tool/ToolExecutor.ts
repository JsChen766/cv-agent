import { AgentRuntimeError } from "../errors/AgentRuntimeError.js";
import { toToolSchema } from "./ToolDefinition.js";
import type { ToolCall, ToolDefinition, ToolExecutionContext, ToolExecutionResult, ToolSchema } from "./types.js";

export class ToolExecutor {
  private readonly tools = new Map<string, ToolDefinition>();

  public register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new AgentRuntimeError(`Tool "${tool.name}" is already registered.`, { code: "TOOL_DUPLICATE" });
    }
    this.tools.set(tool.name, tool);
  }

  public get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new AgentRuntimeError(`Tool "${name}" was not found.`, { code: "TOOL_NOT_FOUND" });
    }
    return tool;
  }

  public list(): string[] {
    return [...this.tools.keys()];
  }

  public toToolSchemas(): ToolSchema[] {
    return [...this.tools.values()].map(toToolSchema);
  }

  public async executeToolCall(toolCall: ToolCall, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    const toolName = toolCall.function.name;

    try {
      const tool = this.get(toolName);
      const parsedArgs = this.parseArguments(toolCall.function.arguments);
      const args = tool.validate ? tool.validate(parsedArgs) : parsedArgs;
      const result = await tool.execute(args, context);
      return { ok: true, toolName, result };
    } catch (error) {
      return {
        ok: false,
        toolName,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private parseArguments(value: string): unknown {
    if (!value.trim()) {
      return {};
    }
    return JSON.parse(value) as unknown;
  }
}
