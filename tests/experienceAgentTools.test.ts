import { describe, expect, it } from "vitest";
import { createExperienceAgentTools } from "../src/agent-tools/experience/index.js";
import { AgentTraceRecorder } from "../src/agent-core/runtime/AgentTrace.js";
import { ToolExecutor } from "../src/agent-core/tools/ToolExecutor.js";
import { ToolRegistry } from "../src/agent-core/tools/ToolRegistry.js";
import { createP12Kernel, testContext } from "./p12Helpers.js";

describe("P12 experience tools", () => {
  it("lists, searches, gets, saves, updates, and deletes real experiences", async () => {
    const kernel = await createP12Kernel();
    const registry = new ToolRegistry();
    registry.registerMany(createExperienceAgentTools());
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    for (const name of ["save_experience_from_text", "update_experience", "delete_experience"]) {
      expect(registry.get(name)?.requiresConfirmation).toBe(true);
    }

    const initial = await executor.execute("list_experiences", {}, context);
    expect((initial.data as { count: number }).count).toBe(0);

    const saved = await executor.execute("save_experience_from_text", { text: "WEEX data analysis dashboard with SQL." }, context);
    const experienceId = (saved.data as { experienceId: string }).experienceId;
    expect(experienceId).toMatch(/^pexp-/);
    expect((await kernel.productServices.experienceService.listExperiences("user-1")).length).toBe(1);

    expect((await executor.execute("search_experiences", { query: "WEEX" }, context)).status).toBe("success");
    expect((await executor.execute("get_experience", { id: experienceId }, context)).status).toBe("success");
    expect((await executor.execute("update_experience", { experienceId, patch: { title: "WEEX analytics" }, content: "Updated content" }, context)).status).toBe("success");
    expect((await executor.execute("delete_experience", { experienceId }, context)).status).toBe("success");
    expect((await kernel.productServices.experienceService.listExperiences("user-1")).length).toBe(0);
    await kernel.close();
  });
});
