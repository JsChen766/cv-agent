import type { AgentContext } from "../runtime/AgentContext.js";
import { AgentError } from "../runtime/AgentError.js";
import type { AgentTraceRecorder } from "../runtime/AgentTrace.js";
import type { ToolDefinition } from "./Tool.js";
import type { ToolRegistry } from "./ToolRegistry.js";
import type { ToolResult } from "./ToolResult.js";

export class ToolExecutor {
  public constructor(
    private readonly registry: ToolRegistry,
    private readonly trace: AgentTraceRecorder,
  ) {}

  public async execute(toolName: string, args: Record<string, unknown>, context: AgentContext): Promise<ToolResult> {
    const tool = this.registry.get(toolName);
    if (!tool) {
      this.trace.add({
        agentName: "ToolExecutor",
        type: "error",
        summary: `Tool not found: ${toolName}`,
        toolName,
        status: "failed",
        completedAt: new Date().toISOString(),
      });
      throw new AgentError("TOOL_NOT_FOUND", "Tool not found.", { statusCode: 404 });
    }
    return this.executeDefinition(tool, args, context);
  }

  public async executeDefinition(tool: ToolDefinition, args: Record<string, unknown>, context: AgentContext): Promise<ToolResult> {
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      this.trace.add({
        agentName: "ToolExecutor",
        type: "error",
        summary: `Invalid input for ${tool.name}`,
        toolName: tool.name,
        status: "failed",
        completedAt: new Date().toISOString(),
      });
      throw new AgentError("TOOL_VALIDATION_FAILED", "Invalid tool input.", { statusCode: 400 });
    }

    const step = this.trace.add({
      agentName: tool.ownerAgent,
      type: "tool_call",
      summary: `Executing ${tool.name}`,
      toolName: tool.name,
      status: "running",
    });
    try {
      const result = await tool.execute(parsed.data as Record<string, unknown>, context);
      const output = tool.outputSchema.safeParse(result);
      if (!output.success) {
        throw new AgentError("TOOL_EXECUTION_FAILED", "Tool returned invalid output.", { statusCode: 500 });
      }
      this.trace.complete(step, result.status === "failed" ? "failed" : "success", { status: result.status });
      this.trace.add({
        agentName: tool.ownerAgent,
        type: "tool_result",
        summary: result.message ?? `${tool.name} completed`,
        toolName: tool.name,
        status: result.status === "failed" ? "failed" : "success",
        completedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      this.trace.complete(step, "failed");
      if (error instanceof AgentError) throw error;
      throw new AgentError("TOOL_EXECUTION_FAILED", "Tool execution failed.", { cause: error });
    }
  }
}
