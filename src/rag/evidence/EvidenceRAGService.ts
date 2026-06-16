import { randomUUID } from "node:crypto";
import type { ProductGeneratedVariant } from "../../product/types.js";
import type { ExperienceService } from "../../product/services/index.js";
import type {
  EvidenceLongTermMemory,
  EvidenceOutcomeFeedback,
  EvidencePack,
  EvidenceReindexReport,
  EvidenceUsageRecord,
  JDRequirement,
} from "./types.js";
import { JDRequirementParser } from "./JDRequirementParser.js";
import { RequirementQueryPlanner } from "./RequirementQueryPlanner.js";
import { ExperienceRetriever } from "./ExperienceRetriever.js";
import { ExperienceClaimExtractor } from "./ExperienceClaimExtractor.js";
import { EvidencePackBuilder } from "./EvidencePackBuilder.js";
import { ClaimSupportVerifier } from "./ClaimSupportVerifier.js";
import { RetrievalEvaluator } from "./RetrievalEvaluator.js";
import type { LLMEvidenceService } from "./LLMEvidenceService.js";
import type { ClaimGraphRepository } from "./ClaimGraphRepository.js";
import { PersistentClaimRetriever } from "./PersistentClaimRetriever.js";
import type { EvidenceIndexMaintenanceService } from "./EvidenceIndexMaintenanceService.js";

export class EvidenceRAGService {
  private readonly jdRequirementParser: JDRequirementParser;
  private readonly queryPlanner = new RequirementQueryPlanner();
  private readonly experienceRetriever: ExperienceRetriever;
  private readonly persistentClaimRetriever?: PersistentClaimRetriever;
  private readonly evidencePackBuilder: EvidencePackBuilder;
  private readonly claimSupportVerifier = new ClaimSupportVerifier();
  private readonly retrievalEvaluator = new RetrievalEvaluator();
  private readonly claimGraphRepository?: ClaimGraphRepository;

  public constructor(input: {
    experienceService: ExperienceService;
    llmEvidenceService?: LLMEvidenceService;
    claimGraphRepository?: ClaimGraphRepository;
    indexMaintenanceService?: EvidenceIndexMaintenanceService;
  }) {
    this.jdRequirementParser = new JDRequirementParser(input.llmEvidenceService);
    this.experienceRetriever = new ExperienceRetriever(input.experienceService);
    this.persistentClaimRetriever = input.claimGraphRepository ? new PersistentClaimRetriever(input.claimGraphRepository) : undefined;
    this.evidencePackBuilder = new EvidencePackBuilder(new ExperienceClaimExtractor(input.llmEvidenceService));
    this.claimGraphRepository = input.claimGraphRepository;
    this.indexMaintenanceService = input.indexMaintenanceService;
  }

  private readonly indexMaintenanceService?: EvidenceIndexMaintenanceService;

  public async buildEvidencePack(input: {
    userId: string;
    jdText: string;
    targetRole?: string;
    roleFamily?: string;
    limit?: number;
  }): Promise<EvidencePack> {
    const requirements = await this.jdRequirementParser.parse({ jdText: input.jdText, targetRole: input.targetRole });
    const queryPlans = this.queryPlanner.buildPlans(requirements);
    const claimLimit = Math.max((input.limit ?? 12) * 3, 30);
    const experienceLimit = input.limit ?? 12;

    const [persistentClaims, rawExperiences] = await Promise.all([
      this.persistentClaimRetriever
        ? this.persistentClaimRetriever.retrieve({
            userId: input.userId,
            requirements,
            queryPlans,
            limit: claimLimit,
            mode: "initial",
            roleFamily: input.roleFamily,
          })
        : Promise.resolve([]),
      this.experienceRetriever.retrieve({
        userId: input.userId,
        requirements,
        queryPlans,
        limit: experienceLimit,
        mode: "initial",
      }),
    ]);

    const persistentPack = persistentClaims.length > 0
      ? this.evidencePackBuilder.buildFromPersistentClaims({ requirements, retrievedClaims: persistentClaims })
      : undefined;
    const dynamicPack = rawExperiences.length > 0
      ? await this.evidencePackBuilder.build({ requirements, retrieved: rawExperiences })
      : undefined;

    let pack = mergeOptionalPacks(this.evidencePackBuilder, persistentPack, dynamicPack, requirements);
    let evaluation = this.retrievalEvaluator.evaluate(pack);
    let correctionRounds = 0;

    if (evaluation.correctionNeeded) {
      const correctiveRequirements = selectCorrectiveRequirements(requirements, pack);
      if (correctiveRequirements.length > 0) {
        const correctivePlans = this.queryPlanner.buildPlans(correctiveRequirements);
        const [extraClaims, extraExperiences] = await Promise.all([
          this.persistentClaimRetriever
            ? this.persistentClaimRetriever.retrieve({
                userId: input.userId,
                requirements: correctiveRequirements,
                queryPlans: correctivePlans,
                limit: claimLimit,
                mode: "corrective",
                roleFamily: input.roleFamily,
                excludeClaimIds: persistentClaims.map((item) => item.claim.id),
              })
            : Promise.resolve([]),
          this.experienceRetriever.retrieve({
            userId: input.userId,
            requirements: correctiveRequirements,
            queryPlans: correctivePlans,
            limit: experienceLimit,
            mode: "corrective",
            excludeExperienceIds: rawExperiences.map((item) => item.experience.id),
          }),
        ]);
        const correctivePersistentPack = extraClaims.length > 0
          ? this.evidencePackBuilder.buildFromPersistentClaims({ requirements, retrievedClaims: extraClaims })
          : undefined;
        const correctiveDynamicPack = extraExperiences.length > 0
          ? await this.evidencePackBuilder.build({ requirements, retrieved: extraExperiences })
          : undefined;
        if (correctivePersistentPack) pack = this.evidencePackBuilder.mergePacks(pack, correctivePersistentPack);
        if (correctiveDynamicPack) pack = this.evidencePackBuilder.mergePacks(pack, correctiveDynamicPack);
        correctionRounds = extraClaims.length > 0 || extraExperiences.length > 0 ? 1 : 0;
        evaluation = this.retrievalEvaluator.evaluate(pack);
      }
    }

    const withDiagnostics: EvidencePack = {
      ...pack,
      version: "evidence-rag-v5",
      diagnostics: {
        queryPlans,
        retrievalEvaluation: evaluation,
        correctionRounds,
        persistentClaimHits: pack.retrievalTrace.filter((item) => item.source === "persistent_claim").length,
        dynamicExperienceHits: pack.retrievalTrace.filter((item) => item.source === "raw_experience").length,
        warnings: buildDiagnosticsWarnings(pack, evaluation),
      },
    };

    return this.enrichWithLongTermMemory(input.userId, withDiagnostics, input.roleFamily);
  }

  public verifyGeneratedVariants(variants: ProductGeneratedVariant[], evidencePack: EvidencePack): ProductGeneratedVariant[] {
    return this.claimSupportVerifier.verifyVariants(variants, evidencePack);
  }

  public async reindexUserExperiences(input: { userId: string; limit?: number }): Promise<EvidenceReindexReport | undefined> {
    return this.indexMaintenanceService?.reindexUserExperiences(input);
  }

  public async recordGenerationUsage(input: {
    userId: string;
    generationId: string;
    jdId?: string;
    targetRole?: string;
    roleFamily?: string;
    evidencePack?: EvidencePack;
    variants: ProductGeneratedVariant[];
  }): Promise<void> {
    if (!this.claimGraphRepository || !input.evidencePack) return;
    const now = new Date().toISOString();
    const records: EvidenceUsageRecord[] = [];
    for (const variant of input.variants) {
      const selectedClaimIds = new Set(variant.sourceEvidenceIds ?? []);
      const selectedExperienceIds = new Set(variant.sourceExperienceIds ?? []);
      let candidateClaims = input.evidencePack.allowedClaims.filter((claim) => {
        const claimId = claim.claimId ?? claim.id;
        if (selectedClaimIds.size > 0) return selectedClaimIds.has(claimId) || selectedClaimIds.has(claim.id);
        if (selectedExperienceIds.size > 0) return selectedExperienceIds.has(claim.experienceId);
        return false;
      });
      if (candidateClaims.length === 0 && selectedClaimIds.size === 0 && selectedExperienceIds.size === 0) {
        candidateClaims = input.evidencePack.allowedClaims.slice(0, 8);
      }
      for (const claim of candidateClaims.slice(0, 24)) {
        for (const requirementId of claim.requirementIds.length > 0 ? claim.requirementIds : ["unknown-requirement"]) {
          records.push({
            id: `eusage-${randomUUID()}`,
            userId: input.userId,
            generationId: input.generationId,
            variantId: variant.id,
            jdId: input.jdId,
            targetRole: input.targetRole,
            roleFamily: input.roleFamily,
            requirementId,
            claimId: claim.claimId ?? claim.id,
            experienceId: claim.experienceId,
            evidenceText: claim.evidenceText,
            generatedText: variant.content,
            action: "generated",
            metadata: {
              source: "evidence_rag_v5_generation_usage",
              allowedClaimId: claim.id,
              confidence: claim.confidence,
              riskLevel: claim.riskLevel,
            },
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    }
    if (records.length > 0) await this.claimGraphRepository.recordEvidenceUsage(records);
  }

  public async recordVariantDecision(input: {
    userId: string;
    generationId: string;
    variantId: string;
    action: "accepted" | "edited" | "rejected" | "ignored";
    finalText?: string;
    claimIds?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.claimGraphRepository) return;
    await this.claimGraphRepository.appendEvidenceUsageDecision({
      userId: input.userId,
      generationId: input.generationId,
      variantId: input.variantId,
      claimIds: input.claimIds,
      action: input.action,
      finalText: input.finalText,
      metadata: input.metadata,
      decisionIdPrefix: `eusage-decision-${randomUUID()}`,
    });
  }

  public async recordOutcomeFeedback(input: Omit<EvidenceOutcomeFeedback, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<EvidenceOutcomeFeedback | undefined> {
    if (!this.claimGraphRepository) return undefined;
    const feedback: EvidenceOutcomeFeedback = {
      ...input,
      id: input.id ?? `eoutcome-${randomUUID()}`,
      relatedClaimIds: input.relatedClaimIds ?? [],
      relatedExperienceIds: input.relatedExperienceIds ?? [],
      metadata: input.metadata ?? {},
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    return this.claimGraphRepository.recordOutcomeFeedback(feedback);
  }

  public async buildLongTermMemory(input: {
    userId: string;
    claimIds?: string[];
    experienceIds?: string[];
    roleFamily?: string;
  }): Promise<EvidenceLongTermMemory | undefined> {
    if (!this.claimGraphRepository) return undefined;
    const [claimUsageStats, roleSpecificEffectiveness, outcomeFeedback] = await Promise.all([
      this.claimGraphRepository.listClaimUsageStats(input.userId, input.claimIds),
      this.claimGraphRepository.listRoleSpecificClaimEffectiveness(input.userId, input.roleFamily, input.claimIds),
      this.claimGraphRepository.listOutcomeFeedback(input.userId, {
        claimIds: input.claimIds,
        experienceIds: input.experienceIds,
        limit: 20,
      }),
    ]);
    return { claimUsageStats, roleSpecificEffectiveness, outcomeFeedback };
  }

  private async enrichWithLongTermMemory(userId: string, pack: EvidencePack, roleFamily?: string): Promise<EvidencePack> {
    if (!this.claimGraphRepository) return pack;
    const claimIds = pack.allowedClaims.map((claim) => claim.claimId ?? claim.id).filter(Boolean);
    const experienceIds = Array.from(new Set(pack.allowedClaims.map((claim) => claim.experienceId)));
    const longTermMemory = await this.buildLongTermMemory({ userId, claimIds, experienceIds, roleFamily });
    return { ...pack, version: "evidence-rag-v5", longTermMemory };
  }
}

function mergeOptionalPacks(
  builder: EvidencePackBuilder,
  persistentPack: EvidencePack | undefined,
  dynamicPack: EvidencePack | undefined,
  requirements: JDRequirement[],
): EvidencePack {
  if (persistentPack && dynamicPack) return builder.mergePacks(persistentPack, dynamicPack);
  if (persistentPack) return persistentPack;
  if (dynamicPack) return dynamicPack;
  return {
    version: "evidence-rag-v5",
    jdRequirements: requirements,
    matchedEvidence: requirements.map((requirement) => ({
      requirementId: requirement.id,
      evidenceItems: [],
      coverage: "no_evidence",
      recommendedAction: requirement.retrievalPolicies.includes("ask_user_required") ? "ask_user" : "alternative_angle",
    })),
    allowedClaims: [],
    missingRequirements: requirements.map((requirement) => ({
      requirementId: requirement.id,
      requirementText: requirement.text,
      reason: "No matching active experience or persistent claim was found.",
      recommendedAction: requirement.retrievalPolicies.includes("ask_user_required") ? "ask_user" : "alternative_angle",
    })),
    retrievalTrace: [],
    qualitySignals: requirements.map((requirement) => ({
      requirementId: requirement.id,
      quality: "missing",
      confidence: 0,
      reason: "No evidence was retrieved.",
    })),
    graphLinks: [],
    usageTrace: requirements.map((requirement) => ({
      requirementId: requirement.id,
      status: requirement.retrievalPolicies.includes("ask_user_required") ? "needs_user_confirmation" : "missing",
    })),
  };
}

function selectCorrectiveRequirements(requirements: JDRequirement[], pack: EvidencePack): JDRequirement[] {
  const missing = new Set(pack.missingRequirements.map((item) => item.requirementId));
  const weak = new Set(pack.qualitySignals.filter((item) => item.quality === "weak").map((item) => item.requirementId));
  return requirements.filter((requirement) => missing.has(requirement.id) || weak.has(requirement.id));
}

function buildDiagnosticsWarnings(pack: EvidencePack, evaluation: ReturnType<RetrievalEvaluator["evaluate"]>): string[] {
  const warnings = [...evaluation.correctionReasons];
  if (pack.retrievalTrace.length === 0) warnings.push("No retrieval trace was produced.");
  if (pack.allowedClaims.some((claim) => claim.riskLevel === "high")) warnings.push("At least one allowed claim has high factual risk and must not be used without confirmation.");
  if (pack.retrievalTrace.every((item) => item.source === "raw_experience") && pack.retrievalTrace.length > 0) {
    warnings.push("Persistent claim graph did not contribute; consider reindexing existing experiences.");
  }
  return Array.from(new Set(warnings)).slice(0, 12);
}
