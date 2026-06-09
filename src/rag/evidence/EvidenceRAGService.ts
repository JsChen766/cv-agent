import { randomUUID } from "node:crypto";
import type { ProductGeneratedVariant } from "../../product/types.js";
import type { ExperienceService } from "../../product/services/index.js";
import type {
  EvidenceLongTermMemory,
  EvidenceOutcomeFeedback,
  EvidencePack,
  EvidenceUsageRecord,
} from "./types.js";
import { JDRequirementParser } from "./JDRequirementParser.js";
import { ExperienceRetriever } from "./ExperienceRetriever.js";
import { ExperienceClaimExtractor } from "./ExperienceClaimExtractor.js";
import { EvidencePackBuilder } from "./EvidencePackBuilder.js";
import { ClaimSupportVerifier } from "./ClaimSupportVerifier.js";
import type { LLMEvidenceService } from "./LLMEvidenceService.js";
import type { ClaimGraphRepository } from "./ClaimGraphRepository.js";
import { PersistentClaimRetriever } from "./PersistentClaimRetriever.js";

export class EvidenceRAGService {
  private readonly jdRequirementParser: JDRequirementParser;
  private readonly experienceRetriever: ExperienceRetriever;
  private readonly persistentClaimRetriever?: PersistentClaimRetriever;
  private readonly evidencePackBuilder: EvidencePackBuilder;
  private readonly claimSupportVerifier = new ClaimSupportVerifier();

  public constructor(input: {
    experienceService: ExperienceService;
    llmEvidenceService?: LLMEvidenceService;
    claimGraphRepository?: ClaimGraphRepository;
  }) {
    this.jdRequirementParser = new JDRequirementParser(input.llmEvidenceService);
    this.experienceRetriever = new ExperienceRetriever(input.experienceService);
    this.persistentClaimRetriever = input.claimGraphRepository ? new PersistentClaimRetriever(input.claimGraphRepository) : undefined;
    this.evidencePackBuilder = new EvidencePackBuilder(new ExperienceClaimExtractor(input.llmEvidenceService));
    this.claimGraphRepository = input.claimGraphRepository;
  }

  private readonly claimGraphRepository?: ClaimGraphRepository;

  public async buildEvidencePack(input: {
    userId: string;
    jdText: string;
    targetRole?: string;
    roleFamily?: string;
    limit?: number;
  }): Promise<EvidencePack> {
    const requirements = await this.jdRequirementParser.parse({ jdText: input.jdText, targetRole: input.targetRole });

    const persistentClaims = this.persistentClaimRetriever
      ? await this.persistentClaimRetriever.retrieve({
          userId: input.userId,
          requirements,
          limit: Math.max(input.limit ?? 12, 30),
        })
      : [];

    const persistentPack = persistentClaims.length > 0
      ? this.evidencePackBuilder.buildFromPersistentClaims({ requirements, retrievedClaims: persistentClaims })
      : undefined;

    const needsRawFallback = !persistentPack
      || persistentPack.allowedClaims.length === 0
      || persistentPack.missingRequirements.length > 0;

    let pack: EvidencePack;
    if (!needsRawFallback && persistentPack) {
      pack = persistentPack;
    } else {
      const retrieved = await this.experienceRetriever.retrieve({
        userId: input.userId,
        requirements,
        limit: input.limit ?? 12,
      });
      const dynamicPack = await this.evidencePackBuilder.build({ requirements, retrieved });
      pack = persistentPack ? this.evidencePackBuilder.mergePersistentAndDynamic(persistentPack, dynamicPack) : dynamicPack;
    }

    return this.enrichWithLongTermMemory(input.userId, pack, input.roleFamily);
  }

  public verifyGeneratedVariants(variants: ProductGeneratedVariant[], evidencePack: EvidencePack): ProductGeneratedVariant[] {
    return this.claimSupportVerifier.verifyVariants(variants, evidencePack);
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
      const variantExperienceIds = new Set(variant.sourceExperienceIds ?? []);
      const candidateClaims = input.evidencePack.allowedClaims.filter((claim) => {
        if (variantExperienceIds.size === 0) return true;
        return variantExperienceIds.has(claim.experienceId);
      });
      for (const claim of candidateClaims.slice(0, 30)) {
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
              source: "evidence_rag_v4_generation_usage",
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
    await this.claimGraphRepository.updateEvidenceUsageAction({
      userId: input.userId,
      generationId: input.generationId,
      variantId: input.variantId,
      claimIds: input.claimIds,
      action: input.action,
      finalText: input.finalText,
      metadata: input.metadata,
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
    return {
      ...pack,
      version: "evidence-rag-v4",
      longTermMemory,
    };
  }
}
