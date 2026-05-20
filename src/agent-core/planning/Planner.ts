import type { Agent } from "../agents/BaseAgent.js";
import type { AgentContext } from "../runtime/AgentContext.js";
import type { AgentName, PlanStep } from "../validation/AgentOutputSchemas.js";
import { PlanValidator } from "./PlanValidator.js";

export class Planner {
  public constructor(private readonly validator: PlanValidator) {}

  public async plan(agent: Agent, context: AgentContext, routeHint?: AgentName): Promise<PlanStep[]> {
    const decision = await agent.decide({ context, routeHint });
    return this.validator.validate(decision.plan, agent.name, agent.allowedTools);
  }
}
