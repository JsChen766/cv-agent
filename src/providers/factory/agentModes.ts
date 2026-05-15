export type AgentExecutionMode = "mock" | "deterministic" | "llm";

export type AgentModeConfig = {
  frontDeskAgentMode: "mock" | "llm";
  experienceExtractorMode: "deterministic" | "llm";
  artifactGeneratorMode: "deterministic" | "llm";
  criticAgentMode: "deterministic" | "llm";
  revisionAgentMode: "deterministic" | "llm";
};

export function readAgentModeConfig(env: NodeJS.ProcessEnv = process.env): AgentModeConfig {
  return {
    frontDeskAgentMode: readMode(
      env.FRONTDESK_AGENT_MODE,
      "FRONTDESK_AGENT_MODE",
      ["mock", "llm"],
      "mock",
    ),
    experienceExtractorMode: readMode(
      env.EXPERIENCE_EXTRACTOR_MODE,
      "EXPERIENCE_EXTRACTOR_MODE",
      ["deterministic", "llm"],
      "deterministic",
    ),
    artifactGeneratorMode: readMode(
      env.ARTIFACT_GENERATOR_MODE,
      "ARTIFACT_GENERATOR_MODE",
      ["deterministic", "llm"],
      "deterministic",
    ),
    criticAgentMode: readMode(
      env.CRITIC_AGENT_MODE,
      "CRITIC_AGENT_MODE",
      ["deterministic", "llm"],
      "deterministic",
    ),
    revisionAgentMode: readMode(
      env.REVISION_AGENT_MODE,
      "REVISION_AGENT_MODE",
      ["deterministic", "llm"],
      "deterministic",
    ),
  };
}

function readMode<const TMode extends AgentExecutionMode>(
  value: string | undefined,
  name: string,
  allowed: readonly TMode[],
  defaultValue: TMode,
): TMode {
  const trimmed = value?.trim();
  if (!trimmed) {
    return defaultValue;
  }
  const mode = allowed.find((item) => item === trimmed);
  if (!mode) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return mode;
}
