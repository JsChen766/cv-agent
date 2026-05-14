import type { GenerateResumeResult } from "../ResumeGenerationService.js";
import type {
  GeneratedArtifactBundle,
  GenerateResumeResponse,
} from "../../api-contracts/generation.js";

export function toGenerateResumeResponse(
  result: GenerateResumeResult,
): GenerateResumeResponse {
  if (
    result.artifacts.length !== result.evidenceChains.length ||
    result.artifacts.length !== result.graphViews.length
  ) {
    throw new Error(
      `Cannot map GenerateResumeResult: artifacts (${result.artifacts.length}), evidenceChains (${result.evidenceChains.length}), and graphViews (${result.graphViews.length}) must have the same length.`,
    );
  }

  const artifacts: GeneratedArtifactBundle[] = result.artifacts.map(
    (artifact, index) => ({
      artifact,
      evidenceChain: result.evidenceChains[index],
      graphView: result.graphViews[index],
    }),
  );

  return {
    userId: result.userId,
    jdId: result.jdId,
    jdText: result.jdText,
    targetRole: result.targetRole,
    requirements: result.requirements,
    retrievedExperiences: result.retrievedExperiences,
    artifacts,
    coverageReport: result.coverageReport,
    coverageGapReport: result.coverageGapReport,
    critiqueReport: result.critiqueReport,
    createdAt: result.createdAt,
  };
}
