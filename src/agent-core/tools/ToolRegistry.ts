import type { ToolDefinition } from "./Tool.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  public register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  public registerMany(tools: ToolDefinition[]): void {
    for (const tool of tools) this.register(tool);
  }

  public get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  public listForAgent(agentName: string): ToolDefinition[] {
    return this.list().filter((tool) => tool.ownerAgent === agentName || tool.ownerAgent === "frontdesk");
  }
}
