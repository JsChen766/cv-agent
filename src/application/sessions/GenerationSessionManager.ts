import { stableId } from "../../knowledge/keywordUtils.js";
import type { GeneratedArtifact } from "../../knowledge/types.js";
import type { GenerateResumeResponse } from "../../api-contracts/generation.js";
import type {
  GenerationSessionRepository,
} from "./InMemoryGenerationSessionRepository.js";
import {
  CreateGenerationSessionInputSchema,
  DecideArtifactInputSchema,
  DecideCoverageGapInputSchema,
  GenerateSupplementalArtifactDraftInputSchema,
} from "./schemas.js";
import type {
  ArtifactDecision,
  ArtifactDecisionType,
  CoverageGapDecision,
  CoverageGapDecisionType,
  GenerationSession,
  GenerationSessionSummary,
  SupplementalArtifactDraft,
} from "./types.js";

export type CreateGenerationSessionInput = {
  generation: GenerateResumeResponse;
};

export type DecideArtifactInput = {
  sessionId: string;
  artifactId: string;
  decision: Exclude<ArtifactDecisionType, "undecided">;
  note?: string;
};

export type DecideCoverageGapInput = {
  sessionId: string;
  requirementId: string;
  decision: Exclude<CoverageGapDecisionType, "undecided">;
  note?: string;
};

export type GenerateSupplementalArtifactDraftInput = {
  sessionId: string;
  requirementId: string;
};

export class GenerationSessionManager {
  constructor(private readonly repo: GenerationSessionRepository) {}

  async createSession(
    input: CreateGenerationSessionInput,
  ): Promise<GenerationSession> {
    CreateGenerationSessionInputSchema.parse(input);
    const now = new Date().toISOString();
    const session: GenerationSession = {
      id: stableId(
        "generation-session",
        `${input.generation.userId}:${input.generation.jdId}:${now}`,
      ),
      userId: input.generation.userId,
      jdId: input.generation.jdId,
      generation: input.generation,
      artifactDecisions: input.generation.artifacts.map((bundle) => ({
        artifactId: bundle.artifact.id,
        decision: "undecided",
        decidedAt: now,
      })),
      coverageGapDecisions: input.generation.coverageGapReport.items.map((item) => ({
        requirementId: item.requirement.id,
        decision: "undecided",
        decidedAt: now,
      })),
      supplementalArtifactDrafts: [],
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    await this.repo.save(session);
    return session;
  }

  async decideArtifact(input: DecideArtifactInput): Promise<GenerationSession> {
    DecideArtifactInputSchema.parse(input);
    const session = await this.requireSession(input.sessionId);
    if (!this.artifactExists(session, input.artifactId)) {
      throw new Error(
        `Cannot decide artifact: artifact ${input.artifactId} does not exist in session ${input.sessionId}.`,
      );
    }

    const now = new Date().toISOString();
    const decision: ArtifactDecision = {
      artifactId: input.artifactId,
      decision: input.decision,
      ...(input.note ? { note: input.note } : {}),
      decidedAt: now,
    };
    session.artifactDecisions = upsertById(
      session.artifactDecisions,
      decision,
      (item) => item.artifactId,
    );
    session.updatedAt = now;
    await this.repo.save(session);
    return session;
  }

  async decideCoverageGap(
    input: DecideCoverageGapInput,
  ): Promise<GenerationSession> {
    DecideCoverageGapInputSchema.parse(input);
    const session = await this.requireSession(input.sessionId);
    if (!this.coverageGapExists(session, input.requirementId)) {
      throw new Error(
        `Cannot decide coverage gap: requirement ${input.requirementId} does not exist in session ${input.sessionId}.`,
      );
    }

    this.setCoverageGapDecision(session, {
      requirementId: input.requirementId,
      decision: input.decision,
      ...(input.note ? { note: input.note } : {}),
      decidedAt: new Date().toISOString(),
    });
    await this.repo.save(session);
    return session;
  }

  async generateSupplementalArtifactDraft(
    input: GenerateSupplementalArtifactDraftInput,
  ): Promise<GenerationSession> {
    GenerateSupplementalArtifactDraftInputSchema.parse(input);
    const session = await this.requireSession(input.sessionId);
    const gap = session.generation.coverageGapReport.items.find(
      (item) => item.requirement.id === input.requirementId,
    );
    if (!gap) {
      throw new Error(
        `Cannot generate supplemental artifact draft: requirement ${input.requirementId} does not exist in session ${input.sessionId}.`,
      );
    }

    const existingDraft = session.supplementalArtifactDrafts.find(
      (draft) => draft.requirementId === input.requirementId,
    );
    const suggestion = gap.supplementalArtifactSuggestions[0];
    if (!existingDraft && !suggestion) {
      throw new Error(
        `Cannot generate supplemental artifact draft: coverage gap ${input.requirementId} has no supplemental artifact suggestion.`,
      );
    }

    const now = new Date().toISOString();
    this.setCoverageGapDecision(session, {
      requirementId: input.requirementId,
      decision: "generate_supplemental_artifact",
      decidedAt: now,
    });

    if (existingDraft) {
      await this.repo.save(session);
      return session;
    }

    const draftId = stableId(
      "supplemental-artifact",
      `${session.id}:${input.requirementId}:${suggestion.content}`,
    );
    const artifact: GeneratedArtifact = {
      id: draftId,
      userId: session.userId,
      type: suggestion.type,
      content: suggestion.content,
      sourceExperienceIds: suggestion.sourceExperienceIds,
      sourceEvidenceIds: suggestion.sourceEvidenceIds,
      matchedSkillIds: suggestion.matchedSkillIds,
      targetJDId: session.jdId,
      targetRequirementIds: suggestion.targetRequirementIds,
      targetRole: session.generation.targetRole,
      scores: {
        overall: suggestion.confidence,
        requirementMatch: suggestion.confidence,
        evidenceStrength: suggestion.confidence,
      },
      status: suggestion.riskLevel === "low" ? "ready" : "needs_review",
      createdAt: now,
      updatedAt: now,
    };
    const draft: SupplementalArtifactDraft = {
      id: draftId,
      requirementId: input.requirementId,
      sourceSuggestion: suggestion,
      artifact,
      status: "draft",
      createdAt: now,
    };
    session.supplementalArtifactDrafts = [
      ...session.supplementalArtifactDrafts,
      draft,
    ];
    session.updatedAt = now;
    await this.repo.save(session);
    return session;
  }

  async getSession(sessionId: string): Promise<GenerationSession | null> {
    return this.repo.getById(sessionId);
  }

  async getSummary(sessionId: string): Promise<GenerationSessionSummary> {
    const session = await this.requireSession(sessionId);
    const artifactDecisionCounts = this.countArtifactDecisions(session);
    const gapDecisionCounts = this.countCoverageGapDecisions(session);

    return {
      sessionId: session.id,
      userId: session.userId,
      jdId: session.jdId,
      totalArtifacts: session.generation.artifacts.length,
      acceptedArtifacts: artifactDecisionCounts.accepted,
      rejectedArtifacts: artifactDecisionCounts.rejected,
      needsRevisionArtifacts: artifactDecisionCounts.needs_revision,
      undecidedArtifacts: artifactDecisionCounts.undecided,
      totalCoverageGaps: session.generation.coverageGapReport.items.length,
      supplementalArtifactRequests:
        gapDecisionCounts.generate_supplemental_artifact,
      moreEvidenceRequests: gapDecisionCounts.request_more_evidence,
      ignoredGaps: gapDecisionCounts.ignore,
      notRelevantGaps: gapDecisionCounts.mark_not_relevant,
      undecidedGaps: gapDecisionCounts.undecided,
      supplementalDraftCount: session.supplementalArtifactDrafts.length,
      status: session.status,
      updatedAt: session.updatedAt,
    };
  }

  private async requireSession(sessionId: string): Promise<GenerationSession> {
    const session = await this.repo.getById(sessionId);
    if (!session) {
      throw new Error(`Generation session ${sessionId} does not exist.`);
    }
    return session;
  }

  private artifactExists(session: GenerationSession, artifactId: string): boolean {
    return session.generation.artifacts.some(
      (bundle) => bundle.artifact.id === artifactId,
    );
  }

  private coverageGapExists(
    session: GenerationSession,
    requirementId: string,
  ): boolean {
    return session.generation.coverageGapReport.items.some(
      (item) => item.requirement.id === requirementId,
    );
  }

  private setCoverageGapDecision(
    session: GenerationSession,
    decision: CoverageGapDecision,
  ): void {
    session.coverageGapDecisions = upsertById(
      session.coverageGapDecisions,
      decision,
      (item) => item.requirementId,
    );
    session.updatedAt = decision.decidedAt;
  }

  private countArtifactDecisions(session: GenerationSession) {
    const counts = {
      accepted: 0,
      rejected: 0,
      needs_revision: 0,
      undecided: 0,
    };
    const decisionByArtifactId = new Map(
      session.artifactDecisions.map((decision) => [
        decision.artifactId,
        decision.decision,
      ]),
    );
    for (const bundle of session.generation.artifacts) {
      counts[decisionByArtifactId.get(bundle.artifact.id) ?? "undecided"] += 1;
    }
    return counts;
  }

  private countCoverageGapDecisions(session: GenerationSession) {
    const counts = {
      generate_supplemental_artifact: 0,
      request_more_evidence: 0,
      ignore: 0,
      mark_not_relevant: 0,
      undecided: 0,
    };
    const decisionByRequirementId = new Map(
      session.coverageGapDecisions.map((decision) => [
        decision.requirementId,
        decision.decision,
      ]),
    );
    for (const item of session.generation.coverageGapReport.items) {
      counts[decisionByRequirementId.get(item.requirement.id) ?? "undecided"] += 1;
    }
    return counts;
  }
}

function upsertById<T>(
  items: T[],
  nextItem: T,
  getId: (item: T) => string,
): T[] {
  const nextId = getId(nextItem);
  const index = items.findIndex((item) => getId(item) === nextId);
  if (index === -1) {
    return [...items, nextItem];
  }
  return items.map((item, itemIndex) => (itemIndex === index ? nextItem : item));
}
