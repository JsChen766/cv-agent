import type { ModelClient } from "../model/ModelClient.js";
import type { PromptRegistry } from "../prompts/PromptRegistry.js";
import { BaseAgent } from "./BaseAgent.js";

export class FrontDeskAgent extends BaseAgent {
  public readonly name = "frontdesk" as const;
  public readonly allowedTools: string[] = [];

  public constructor(deps: { modelClient?: ModelClient; promptRegistry: PromptRegistry }) {
    super(deps);
  }
}
