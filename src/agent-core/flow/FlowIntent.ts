import type { ProductActionType } from "../../copilot/types.js";
import type { PlanStep } from "../validation/AgentOutputSchemas.js";

export type FlowIntent =
  | {
      kind: "explicit_action";
      actionType: ProductActionType;
    }
  | {
      kind: "chat";
      source: "user_message";
    };

export type ExplicitActionMappingResult =
  | { kind: "step"; step: PlanStep }
  | { kind: "needs_input"; missingInputs: string[]; message: string }
  | { kind: "unsupported" };
