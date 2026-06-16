import type { AgentName } from "../validation/AgentOutputSchemas.js";

export type AgentManifest = {
  readonly name: AgentName;
  readonly domainId: string;
  readonly roleLabel?: Readonly<Record<string, string>>;
  readonly description?: string;
  readonly promptKey?: string;
  readonly allowedTools: readonly string[];
  readonly capabilities?: readonly string[];
  readonly intents?: readonly string[];
};
