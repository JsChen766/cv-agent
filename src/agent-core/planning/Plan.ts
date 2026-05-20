import type { PlanStep } from "../validation/AgentOutputSchemas.js";

export type Plan = {
  steps: PlanStep[];
};
