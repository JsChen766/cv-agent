import type { ApiKernel } from "../../api/types.js";
import type {
  AgentToolDefinition,
  AgentToolExecutionContext,
  AgentToolResult,
  AgentToolSchema,
} from "./AgentToolTypes.js";
import { createDecisionTools } from "./kernel/decisionTools.js";
import { createEvidenceTools } from "./kernel/evidenceTools.js";
import { createGenerationTools } from "./kernel/generationTools.js";
import { createRevisionTools } from "./kernel/revisionTools.js";
import { createDashboardTools } from "./product/dashboardTools.js";
import { createExperienceTools } from "./product/experienceTools.js";
import { createImportTools } from "./product/importTools.js";
import { createJDTools } from "./product/jdTools.js";
import { createResumeTools } from "./product/resumeTools.js";

export class AgentToolRegistry {
  private readonly tools: Map<string, AgentToolDefinition>;

  public constructor(kernel: ApiKernel) {
    const definitions: AgentToolDefinition[] = [
      ...createExperienceTools(kernel),
      ...createImportTools(kernel),
      ...createJDTools(kernel),
      ...createResumeTools(kernel),
      ...createDashboardTools(kernel),
      ...createGenerationTools(kernel),
      ...createRevisionTools(kernel),
      ...createEvidenceTools(),
      ...createDecisionTools(kernel),
    ];
    this.tools = new Map(definitions.map((tool) => [tool.name, tool]));
  }

  public hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  public getToolSchemas(): AgentToolSchema[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.jsonSchema,
    }));
  }

  public async execute(name: string, args: unknown, context: AgentToolExecutionContext): Promise<AgentToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        status: "failed",
        assistantMessage: "I cannot safely perform that operation yet.",
      };
    }
    const parsed = tool.schema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        status: "needs_input",
        assistantMessage: "I need a bit more information before I can do that.",
      };
    }
    try {
      return await tool.execute(parsed.data, context);
    } catch (error) {
      return {
        status: "failed",
        assistantMessage: error instanceof Error ? error.message : "The tool failed.",
      };
    }
  }
}

export type {
  AgentToolDefinition,
  AgentToolExecutionContext,
  AgentToolResult,
  AgentToolSchema,
  AgentToolStatus,
} from "./AgentToolTypes.js";
