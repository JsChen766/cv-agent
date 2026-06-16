import type { EvidencePack } from "./evidence/index.js";
import type { InstructionPack } from "./guideline/index.js";

export type GroundingRequirementPlan = {
  requirementId: string;
  text: string;
  importance: string;
  evidenceStatus: "supported" | "partial" | "missing";
  action: "emphasize" | "conservative_wording" | "ask_user" | "omit" | "alternative_angle";
  claimIds: string[];
  experienceIds: string[];
};

export type GroundingContext = {
  version: "dual-rag-v1";
  instructionPack?: InstructionPack;
  evidencePack?: EvidencePack;
  requirementPlan: GroundingRequirementPlan[];
  executionRules: string[];
  coverageSummary: {
    totalRequirements: number;
    supportedRequirements: number;
    partiallySupportedRequirements: number;
    missingRequirements: number;
    criticalCoverageRate: number;
  };
  diagnostics: {
    guidelineStatus?: string;
    evidenceQuality?: string;
    warnings: string[];
  };
};
