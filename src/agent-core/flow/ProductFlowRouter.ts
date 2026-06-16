import { ExplicitActionMapper, type ExplicitActionMapperInput } from "./ExplicitActionMapper.js";
import type { ExplicitActionMappingResult, FlowIntent } from "./FlowIntent.js";

export class ProductFlowRouter {
  public constructor(private readonly explicitActionMapper = new ExplicitActionMapper()) {}

  public intentForExplicitAction(input: ExplicitActionMapperInput): FlowIntent {
    return {
      kind: "explicit_action",
      actionType: input.request.action.type,
    };
  }

  public mapExplicitAction(input: ExplicitActionMapperInput): ExplicitActionMappingResult {
    return this.explicitActionMapper.map(input);
  }
}
