import { FrontDeskAgent } from "../../agents/FrontDeskAgent.js";
import { DeterministicArtifactCritic } from "../../application/critique/DeterministicArtifactCritic.js";
import { LLMArtifactCritic } from "../../application/critique/LLMArtifactCritic.js";
import type { ArtifactCritic } from "../../application/critique/types.js";
import { DeterministicArtifactGenerator } from "../../application/generators/DeterministicArtifactGenerator.js";
import { LLMArtifactGenerator } from "../../application/generators/LLMArtifactGenerator.js";
import type { ArtifactGenerator } from "../../application/generators/ArtifactGenerator.js";
import {
  DeterministicArtifactRevisionAgent,
  LLMArtifactRevisionAgent,
  type ArtifactRevisionAgent,
} from "../../application/revision/index.js";
import { ModelClient } from "../../core/model/ModelClient.js";
import { LLMExperienceExtractor } from "../../knowledge/ingestion/LLMExperienceExtractor.js";
import { DeterministicExperienceExtractor } from "../../knowledge/ingestion/extractors/DeterministicExperienceExtractor.js";
import type { ExperienceExtractor } from "../../knowledge/ingestion/extractors/types.js";
import { MockProvider } from "../../providers/MockProvider.js";
import {
  AgentProviderFactory,
} from "../../providers/factory/index.js";

export type CreatedFrontDeskModelClient = {
  modelClient: ModelClient;
  warnings: string[];
};

export type CreatedExperienceExtractor = {
  extractor: ExperienceExtractor;
  warnings: string[];
};

export type CreatedArtifactGenerator = {
  generator: ArtifactGenerator;
  warnings: string[];
};

export type CreatedArtifactCritic = {
  critic: ArtifactCritic;
  warnings: string[];
};

export type CreatedArtifactRevisionAgent = {
  agent: ArtifactRevisionAgent;
  warnings: string[];
};

export function createFrontDeskModelClient(input: {
  mode: "mock" | "fake" | "llm";
}): CreatedFrontDeskModelClient {
  if (input.mode === "mock" || input.mode === "fake") {
    return {
      modelClient: new ModelClient({
        provider: new MockProvider(),
        defaultModel: "mock",
        maxRetries: 0,
      }),
      warnings: [],
    };
  }

  const agentProvider = AgentProviderFactory.create(AgentProviderFactory.fromEnv());
  return {
    modelClient: agentProvider.modelClient,
    warnings: agentProvider.warnings,
  };
}

export function createFrontDeskAgent(input: {
  modelClient: ModelClient;
}): FrontDeskAgent {
  return new FrontDeskAgent({
    modelClient: input.modelClient,
  });
}

export function createExperienceExtractor(input: {
  mode: "deterministic" | "llm";
}): CreatedExperienceExtractor {
  if (input.mode === "deterministic") {
    return {
      extractor: new DeterministicExperienceExtractor(),
      warnings: [],
    };
  }

  const agentProvider = AgentProviderFactory.create(AgentProviderFactory.fromEnv());
  return {
    extractor: new LLMExperienceExtractor({
      modelClient: agentProvider.modelClient,
    }),
    warnings: agentProvider.warnings,
  };
}

export function createArtifactGenerator(input: {
  mode: "deterministic" | "llm";
}): CreatedArtifactGenerator {
  if (input.mode === "deterministic") {
    return {
      generator: new DeterministicArtifactGenerator(),
      warnings: [],
    };
  }

  const agentProvider = AgentProviderFactory.create(AgentProviderFactory.fromEnv());
  return {
    generator: new LLMArtifactGenerator({
      modelClient: agentProvider.modelClient,
    }),
    warnings: agentProvider.warnings,
  };
}

export function createArtifactCritic(input: {
  mode: "deterministic" | "llm";
}): CreatedArtifactCritic {
  if (input.mode === "deterministic") {
    return {
      critic: new DeterministicArtifactCritic(),
      warnings: [],
    };
  }

  const agentProvider = AgentProviderFactory.create(AgentProviderFactory.fromEnv());
  return {
    critic: new LLMArtifactCritic({
      modelClient: agentProvider.modelClient,
    }),
    warnings: agentProvider.warnings,
  };
}

export function createArtifactRevisionAgent(input: {
  mode: "deterministic" | "llm";
}): CreatedArtifactRevisionAgent {
  if (input.mode === "deterministic") {
    return {
      agent: new DeterministicArtifactRevisionAgent(),
      warnings: [],
    };
  }

  const agentProvider = AgentProviderFactory.create(AgentProviderFactory.fromEnv());
  return {
    agent: new LLMArtifactRevisionAgent({
      modelClient: agentProvider.modelClient,
    }),
    warnings: agentProvider.warnings,
  };
}

export function uniqueWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings));
}
