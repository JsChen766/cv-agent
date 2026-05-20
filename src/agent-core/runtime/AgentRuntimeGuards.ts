import type { AgentModeConfig } from "../../providers/factory/agentModes.js";
import { readRuntimeMode } from "./AgentRuntimeConfig.js";

export const DETERMINISTIC_RUNTIME_WARNING =
  "Deterministic runtime is enabled. This should not be used for product-quality LLM behavior.";

export function readAllowDeterministicRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = readBoolean(env.ALLOW_DETERMINISTIC_RUNTIME);
  if (explicit !== undefined) return explicit;
  return readRuntimeMode(env.NODE_ENV) === "test";
}

export function validateDeterministicKernelAgentModes(
  agentModes: AgentModeConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const runtimeMode = readRuntimeMode(env.NODE_ENV);
  const deterministicRuntimeAllowed = readAllowDeterministicRuntime(env);
  const nonLlmModes = [
    ["experienceExtractorMode", agentModes.experienceExtractorMode],
    ["artifactGeneratorMode", agentModes.artifactGeneratorMode],
    ["criticAgentMode", agentModes.criticAgentMode],
    ["revisionAgentMode", agentModes.revisionAgentMode],
    ["legacyFrontDeskAgentMode", agentModes.frontDeskAgentMode],
  ].filter(([, mode]) => mode !== "llm");

  if (runtimeMode !== "test" && nonLlmModes.length > 0 && !deterministicRuntimeAllowed) {
    const modes = nonLlmModes.map(([name, mode]) => `${name}=${mode}`).join(", ");
    throw new Error(
      `Deterministic kernel agent mode is not allowed in development/production. Set ALLOW_DETERMINISTIC_RUNTIME=true only for local debugging. Offending modes: ${modes}.`,
    );
  }

  if (runtimeMode !== "test" && nonLlmModes.length > 0 && deterministicRuntimeAllowed) {
    return [DETERMINISTIC_RUNTIME_WARNING];
  }
  return [];
}

function readBoolean(value: string | undefined): boolean | undefined {
  const text = value?.trim().toLowerCase();
  if (!text) return undefined;
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  throw new Error("Boolean env values must be true, false, 1, or 0.");
}
